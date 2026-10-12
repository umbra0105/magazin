import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient } from "@ecom/db";

type Db = Pick<PrismaClient, "verification" | "user">;

const IDENTIFIER_PREFIX = "ecom:verify-email:";

export type ConsumeResult =
  | { status: "verified"; userId: string }
  /** Nu există, a fost deja folosit sau a expirat: același mesaj pentru toate (nu dezvăluim care). */
  | { status: "invalid" };

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Tokenul de verificare a emailului: 32 de octeți aleatori, valabil `validForHours`, de UNICĂ
 * folosință. În baza de date stă doar hash-ul (SHA-256), deci o scurgere a tabelei nu dă linkuri
 * valide. Se emite un singur token activ per utilizator (unul nou îl înlocuiește pe cel vechi).
 */
export class EmailVerificationService {
  constructor(private readonly db: Db) {}

  async issue(userId: string, validForHours: number, now: Date = new Date()): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const identifier = IDENTIFIER_PREFIX + userId;
    await this.db.verification.deleteMany({ where: { identifier } });
    await this.db.verification.create({
      data: {
        id: randomUUID(),
        identifier,
        value: sha256(token),
        expiresAt: new Date(now.getTime() + validForHours * 3_600_000),
      },
    });
    return token;
  }

  /**
   * Consumă tokenul: șterge rândul ATOMIC (două cereri simultane cu același token nu reușesc
   * amândouă), apoi marchează emailul ca verificat. Un token expirat se șterge și el.
   */
  async consume(token: string, now: Date = new Date()): Promise<ConsumeResult> {
    if (token.length < 16 || token.length > 512) return { status: "invalid" };
    const row = await this.db.verification.findFirst({
      where: { value: sha256(token), identifier: { startsWith: IDENTIFIER_PREFIX } },
    });
    if (!row) return { status: "invalid" };

    const deleted = await this.db.verification.deleteMany({ where: { id: row.id } });
    if (deleted.count !== 1) return { status: "invalid" }; // altcineva l-a consumat între timp
    if (row.expiresAt.getTime() <= now.getTime()) return { status: "invalid" };

    const userId = row.identifier.slice(IDENTIFIER_PREFIX.length);
    const updated = await this.db.user.updateMany({
      where: { id: userId },
      data: { emailVerified: true },
    });
    return updated.count === 1 ? { status: "verified", userId } : { status: "invalid" };
  }
}
