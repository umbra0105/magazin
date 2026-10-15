import { RateLimitedError } from "../auth/auth-guard";
import type { CounterStore } from "../auth/counter-store";

export interface UploadRateSettings {
  uploadMaxAttempts: number;
  uploadWindowMinutes: number;
  refusedAuditMaxAttempts: number;
}

/**
 * Limite pentru ruta de upload, în același depozit de contoare ca autentificarea.
 *  - `checkUpload`: încărcări per utilizator (și per IP, când IP-ul e de încredere);
 *  - `allowRefusedAudit`: câte încercări REFUZATE (fără sesiune, fără permisiune, origine străină)
 *    mai intră în jurnalul de audit. Jurnalul e doar de adăugare și nu se poate șterge, deci o
 *    buclă de cereri anonime nu trebuie să-l umple. Peste limită cererea tot se refuză, dar nu se
 *    mai înregistrează. Fără IP de încredere există un singur bucket comun, cu limită de 10× mai mare.
 */
export class MediaUploadGuard {
  constructor(
    private readonly store: CounterStore,
    private readonly settings: UploadRateSettings,
    /** Spațiul de nume al contoarelor: documentele nu împart limita cu biblioteca media. */
    private readonly namespace: string = "media",
  ) {}

  async checkUpload(userId: string, ip: string | null): Promise<void> {
    const { uploadMaxAttempts: max, uploadWindowMinutes: win } = this.settings;
    await this.hit(`${this.namespace}-upload:user:${userId}`, max, win);
    if (ip) await this.hit(`${this.namespace}-upload:ip:${ip}`, max * 2, win);
  }

  async allowRefusedAudit(ip: string | null): Promise<boolean> {
    const { refusedAuditMaxAttempts: max, uploadWindowMinutes: win } = this.settings;
    const key = ip ? `${this.namespace}-refused:ip:${ip}` : `${this.namespace}-refused:-`;
    const limit = ip ? max : max * 10;
    const { count } = await this.store.increment(key, win * 60);
    return count <= limit;
  }

  private async hit(key: string, max: number, windowMinutes: number): Promise<void> {
    const { count, ttlSeconds } = await this.store.increment(key, windowMinutes * 60);
    if (count > max) throw new RateLimitedError(ttlSeconds);
  }
}
