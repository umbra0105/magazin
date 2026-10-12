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
 * Limite de cereri și blocare temporară pentru rutele de autentificare.
 *
 * Fără enumerare de utilizatori: toate contoarele sunt pe email-ul TRIMIS (există sau nu contul) și
 * stau în același depozit, deci un email inexistent se comportă exact ca unul real. Cheile nu conțin
 * parole. Cu `ip = null` (niciun proxy de încredere) limitele rămân doar pe email.
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

  async checkLogin(email: string, ip: string | null): Promise<void> {
    const { loginMaxAttempts: max, loginWindowMinutes: win } = this.settings;
    const e = normalizeEmail(email);
    await this.hit(`login:${ip ?? "-"}:${e}`, max, win);
    // Un atacator care schimbă IP-ul tot nu poate trece de limita pe email (de 2× limita pe pereche).
    await this.hit(`login-email:${e}`, ip ? max * 2 : max, win);
  }

  async checkRegister(email: string, ip: string | null): Promise<void> {
    const { registerMaxAttempts: max, registerWindowMinutes: win } = this.settings;
    if (ip) await this.hit(`register-ip:${ip}`, max, win);
    await this.hit(`register-email:${normalizeEmail(email)}`, max, win);
  }

  async checkPasswordReset(email: string, ip: string | null): Promise<void> {
    const { passwordResetMaxAttempts: max, passwordResetWindowMinutes: win } = this.settings;
    if (ip) await this.hit(`reset-ip:${ip}`, max, win);
    await this.hit(`reset-email:${normalizeEmail(email)}`, max, win);
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

  /** Secundele rămase din blocare; 0 = cont deblocat. */
  lockRemainingSeconds(email: string): Promise<number> {
    return this.store.ttl(`lock:${normalizeEmail(email)}`);
  }

  /** Înregistrează un eșec; întoarce `true` dacă acest eșec a blocat contul. */
  async recordLoginFailure(email: string): Promise<boolean> {
    const e = normalizeEmail(email);
    const { lockoutThreshold: threshold, lockoutMinutes: minutes } = this.settings;
    const { count } = await this.store.increment(`fail:${e}`, minutes * 60);
    if (count !== threshold) return false;
    await this.store.set(`lock:${e}`, minutes * 60);
    return true;
  }

  async recordLoginSuccess(email: string): Promise<void> {
    await this.store.delete(`fail:${normalizeEmail(email)}`);
  }

  /** Folosit de `pnpm admin:unlock`: scoate blocarea și contorul de eșecuri. */
  async unlock(email: string): Promise<void> {
    const e = normalizeEmail(email);
    await this.store.delete(`lock:${e}`, `fail:${e}`, `login-email:${e}`);
  }
}
