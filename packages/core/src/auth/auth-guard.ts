import { createHash } from "node:crypto";
import { DomainError } from "@ecom/shared";
import type { CounterStore } from "./counter-store";
import type { AuthSettings } from "./auth";

export class RateLimitedError extends DomainError {
  readonly retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super("AUTH_RATE_LIMITED", "Prea multe încercări. Încearcă din nou mai târziu.");
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/**
 * Amprenta emailului folosită în cheile contoarelor: lungime fixă (32 de caractere hex) și fără emailul în clar. Cheile
 * din Redis nu depind astfel de lungimea intrării (Blocul C, C-07: un «email» de megabytes devenea o cheie de megabytes)
 * și nu expun adrese de email în chei, în `SCAN`/`MONITOR` sau într-un dump.
 */
export const emailFingerprint = (email: string): string =>
  createHash("sha256").update(normalizeEmail(email)).digest("hex").slice(0, 32);

/** Ce blocări a produs un eșec de conectare (pentru audit); `email_alert` NU blochează nimic. */
export interface LoginLock {
  kind: "pair" | "ip" | "email_alert";
  lockoutMinutes: number;
}

const DAY_SECONDS = 24 * 60 * 60;
/** Fără adresă IP de încredere pragul pe pereche se înmulțește cu atât, iar blocarea se plafonează (vezi `recordLoginFailure`). */
const UNKNOWN_IP_THRESHOLD_FACTOR = 3;
const UNKNOWN_IP_MAX_LOCK_MINUTES = 1;
const UNKNOWN_IP_RATE_FACTOR = 10;

/**
 * Limite de cereri și blocare temporară pentru rutele de autentificare.
 *
 * Fără enumerare de utilizatori: contoarele sunt pe email-ul TRIMIS (există sau nu contul), în chei cu amprentă, și stau în
 * același depozit, deci un email inexistent se comportă exact ca unul real.
 *
 * Conectarea (Blocul C: C-05, C-06):
 *  - se numără DOAR eșecurile (cinci conectări reușite nu blochează pe nimeni);
 *  - blocare temporară, progresivă (durata de bază se dublează la blocări repetate în 24 h), pe perechea (email, IP) și pe IP;
 *  - NICIO blocare globală pe email: un străin nu poate bloca contul altcuiva de pe altă adresă. Eșecurile unui email de la
 *    orice adrese declanșează doar o alertă (`email_alert`);
 *  - un ritm maxim de încercări pe adresă (reușitele incluse), ca costul argon2 al fiecărei cereri să nu poată fi folosit
 *    pentru a bloca aplicația;
 *  - fără IP de încredere (`trustedProxyHops = 0`) perechea se cheamă (email, "-"), pragul se triplează, blocarea se plafonează la
 *    un minut și nu există blocare pe IP: un străin poate cel mult încetini conectările unui email, un minut o dată.
 */
export class AuthGuard {
  constructor(
    private readonly store: CounterStore,
    private readonly settings: AuthSettings,
  ) {}

  private async hit(key: string, max: number, windowMinutes: number): Promise<void> {
    const { count, ttlSeconds } = await this.store.increment(key, windowMinutes * 60);
    if (count > max) throw new RateLimitedError(ttlSeconds);
  }

  /** Pasul DINAINTEA autentificării: ritmul pe adresă, apoi blocările active (429 cu Retry-After). */
  async checkLogin(email: string, ip: string | null): Promise<void> {
    const { loginRatePerMinutePerIp: rate } = this.settings;
    await this.hit(
      ip ? `login-rate:${ip}` : "login-rate:-",
      ip ? rate : rate * UNKNOWN_IP_RATE_FACTOR,
      1,
    );
    const pairKey = this.pairKey(email, ip);
    const remaining = await Promise.all([
      this.store.ttl(`lock:pair:${pairKey}`),
      ip ? this.store.ttl(`lock:ip:${ip}`) : Promise.resolve(0),
    ]);
    const seconds = Math.max(...remaining);
    if (seconds > 0) throw new RateLimitedError(seconds);
  }

  private pairKey(email: string, ip: string | null): string {
    return `${emailFingerprint(email)}:${ip ?? "-"}`;
  }

  /** Durata unei blocări: baza se dublează la fiecare blocare repetată a aceleiași chei în 24 h, până la 24 h. */
  private async progressiveMinutes(key: string): Promise<number> {
    const { count } = await this.store.increment(`lockn:${key}`, DAY_SECONDS);
    const { lockoutMinutes: base } = this.settings;
    return Math.min(base * 2 ** (count - 1), 24 * 60);
  }

  /**
   * Înregistrează un eșec de conectare (parolă greșită) și întoarce blocările pe care le-a produs. Apelat doar pentru
   * `INVALID_EMAIL_OR_PASSWORD`: limitările, emailul neverificat și conectările reușite nu sunt eșecuri.
   */
  async recordLoginFailure(email: string, ip: string | null): Promise<LoginLock[]> {
    const {
      loginMaxAttempts,
      loginIpMaxAttempts,
      lockoutThreshold,
      loginWindowMinutes: win,
    } = this.settings;
    const window = win * 60;
    const locks: LoginLock[] = [];
    const fingerprint = emailFingerprint(email);

    const pairKey = this.pairKey(email, ip);
    const pairThreshold = ip ? loginMaxAttempts : loginMaxAttempts * UNKNOWN_IP_THRESHOLD_FACTOR;
    if ((await this.store.increment(`lfail:pair:${pairKey}`, window)).count >= pairThreshold) {
      let minutes = await this.progressiveMinutes(`pair:${pairKey}`);
      if (!ip) minutes = Math.min(minutes, UNKNOWN_IP_MAX_LOCK_MINUTES);
      await this.store.set(`lock:pair:${pairKey}`, minutes * 60);
      await this.store.delete(`lfail:pair:${pairKey}`);
      locks.push({ kind: "pair", lockoutMinutes: minutes });
    }

    if (ip && (await this.store.increment(`lfail:ip:${ip}`, window)).count >= loginIpMaxAttempts) {
      const minutes = await this.progressiveMinutes(`ip:${ip}`);
      await this.store.set(`lock:ip:${ip}`, minutes * 60);
      await this.store.delete(`lfail:ip:${ip}`);
      locks.push({ kind: "ip", lockoutMinutes: minutes });
    }

    // alertă (nu blocare): același email greșit de la multe adrese; o singură dată pe fereastră
    if (
      (await this.store.increment(`lfail:email:${fingerprint}`, window)).count === lockoutThreshold
    ) {
      locks.push({ kind: "email_alert", lockoutMinutes: 0 });
    }
    return locks;
  }

  /** O conectare reușită șterge eșecurile și blocările repetate ale perechii (nu și pe cele ale adresei). */
  async recordLoginSuccess(email: string, ip: string | null): Promise<void> {
    const pairKey = this.pairKey(email, ip);
    await this.store.delete(`lfail:pair:${pairKey}`, `lockn:pair:${pairKey}`);
  }

  /** Secundele rămase din blocarea perechii (email, IP); 0 = nicio blocare. */
  lockRemainingSeconds(email: string, ip: string | null): Promise<number> {
    return this.store.ttl(`lock:pair:${this.pairKey(email, ip)}`);
  }

  /** Folosit de `pnpm admin:unlock`: ridică blocările și eșecurile emailului, de pe TOATE adresele. */
  async unlock(email: string): Promise<void> {
    const fingerprint = emailFingerprint(email);
    for (const prefix of ["lfail:pair", "lockn:pair", "lock:pair"]) {
      await this.store.deleteByPrefix(`${prefix}:${fingerprint}:`);
    }
    await this.store.delete(`lfail:email:${fingerprint}`);
  }

  /**
   * Limită pe adresă + limită pe email (C-02, C-40). Fără adresă de încredere (`trustedProxyHops = 0`) nu se renunță la
   * limita pe adresă: există un coș GLOBAL de rezervă, cu plafon de 10 ori mai mare, ca un atacator cu emailuri diferite să nu
   * poată trimite emailuri nelimitat din SMTP-ul magazinului (și ca instalarea fără proxy să rămână, cel puțin, mărginită).
   */
  private async hitIpAndEmail(
    scope: string,
    email: string,
    ip: string | null,
    limits: { perIp: number; perEmail: number; windowMinutes: number },
  ): Promise<void> {
    await this.hit(
      `${scope}-ip:${ip ?? "-"}`,
      ip ? limits.perIp : limits.perIp * UNKNOWN_IP_RATE_FACTOR,
      limits.windowMinutes,
    );
    await this.hit(
      `${scope}-email:${emailFingerprint(email)}`,
      limits.perEmail,
      limits.windowMinutes,
    );
  }

  async checkRegister(email: string, ip: string | null): Promise<void> {
    const s = this.settings;
    await this.hitIpAndEmail("register", email, ip, {
      perIp: s.registerMaxPerIp,
      perEmail: s.registerMaxAttempts,
      windowMinutes: s.registerWindowMinutes,
    });
  }

  async checkPasswordReset(email: string, ip: string | null): Promise<void> {
    const s = this.settings;
    await this.hitIpAndEmail("reset", email, ip, {
      perIp: s.passwordResetMaxPerIp,
      perEmail: s.passwordResetMaxAttempts,
      windowMinutes: s.passwordResetWindowMinutes,
    });
  }

  /** Retrimiterea emailului de verificare: contoare separate de resetarea parolei. */
  async checkVerificationResend(email: string, ip: string | null): Promise<void> {
    const s = this.settings;
    await this.hitIpAndEmail("resend", email, ip, {
      perIp: s.verificationResendMaxPerIp,
      perEmail: s.verificationResendMaxAttempts,
      windowMinutes: s.verificationResendWindowMinutes,
    });
  }

  /**
   * Confirmarea emailului (`/api/verify-email`), limitată pe IP. Tokenurile au 256 de biți, deci
   * limita nu apără împotriva ghicirii, ci împotriva abuzului (încărcare, sondare). Fără IP de
   * încredere (`trustedProxyHops = 0`) există un singur bucket comun, cu limita de 10 ori mai mare,
   * ca un atacator să nu poată bloca confirmările tuturor.
   */
  async checkVerifyEmail(ip: string | null): Promise<void> {
    const { verifyEmailMaxAttempts: max, verifyEmailWindowMinutes: win } = this.settings;
    if (ip) await this.hit(`verify-ip:${ip}`, max, win);
    else await this.hit("verify-ip:-", max * 10, win);
  }
}
