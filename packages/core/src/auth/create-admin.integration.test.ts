import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { DomainError, ValidationError } from "@ecom/shared";
import { can } from "../rbac/can";
import { PermissionService } from "../rbac/permission-service";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { createOwnerAccount } from "./create-admin";
import { verifyPassword } from "./password";

const db = getDb();

/** Parolă generată în memorie pentru fiecare test; nu apare nicăieri în cod. */
const genPassword = () => randomBytes(18).toString("base64url");
const genEmail = () => `owner-${randomBytes(4).toString("hex")}@test.invalid`;

/** Pornește dintr-o stare curată (fără utilizatori cu roluri), în tranzacția de test. */
async function withCleanSeeded<T>(fn: (tx: TestTx) => Promise<T>): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    await tx.userRole.deleteMany();
    return fn(tx);
  });
}

const errorOf = async (promise: Promise<unknown>): Promise<unknown> => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};

describe("createOwnerAccount (baza de test, în tranzacție anulată)", () => {
  afterAll(async () => {
    await db.$disconnect();
  });

  it("creează utilizator cu email verificat, parolă argon2id și rolul Owner care poate tot", async () => {
    await withCleanSeeded(async (tx) => {
      const password = genPassword();
      const email = genEmail();
      const { userId } = await createOwnerAccount(tx, {
        email: ` ${email.toUpperCase()} `,
        name: "  Administrator  ",
        password,
      });

      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        include: { accounts: true, roles: { include: { role: true } } },
      });
      expect(user.email).toBe(email); // normalizat
      expect(user.name).toBe("Administrator");
      expect(user.emailVerified).toBe(true);
      expect(user.roles.map((r) => r.role.key)).toEqual(["owner"]);

      const account = user.accounts.find((a) => a.providerId === "credential");
      expect(account?.password).toMatch(/^\$argon2id\$/);
      expect(account?.password).not.toContain(password);
      expect(await verifyPassword({ hash: account?.password ?? "", password })).toBe(true);
      expect(await verifyPassword({ hash: account?.password ?? "", password: genPassword() })).toBe(
        false,
      );

      const subject = await new PermissionService(tx).loadSubject(userId);
      expect(can(subject, "system.update")).toBe(true);
      expect(can(subject, "admin.access")).toBe(true);
    });
  });

  it("scrie în audit fără parolă (nici în clar, nici hash-ul)", async () => {
    await withCleanSeeded(async (tx) => {
      const password = genPassword();
      const { userId } = await createOwnerAccount(tx, {
        email: genEmail(),
        name: "Admin",
        password,
      });
      const [row] = await tx.$queryRaw<{ t: string }[]>`
        select row_to_json(a)::text as t from audit_log a
        where "entityId" = ${userId} and action = 'admin.account_created'`;
      expect(row?.t).toBeTruthy();
      expect(row?.t).toContain("cli:admin:create");
      expect(row?.t).not.toContain(password);
      expect(row?.t).not.toContain("argon2");
    });
  });

  it("respinge o parolă sub 12 caractere, fără să creeze nimic și fără parola în eroare", async () => {
    await withCleanSeeded(async (tx) => {
      const short = randomBytes(8).toString("hex").slice(0, 11);
      const email = genEmail();
      const error = await errorOf(
        createOwnerAccount(tx, { email, name: "Admin", password: short }),
      );
      expect(error).toBeInstanceOf(ValidationError);
      expect(String((error as Error).message)).toContain("12");
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(short);
      expect(await tx.user.count({ where: { email } })).toBe(0);
    });
  });

  it("acceptă exact 12 caractere, fără reguli de compoziție", async () => {
    await withCleanSeeded(async (tx) => {
      await expect(
        createOwnerAccount(tx, { email: genEmail(), name: "Admin", password: "abcdefghijkl" }),
      ).resolves.toBeDefined();
    });
  });

  it("respinge email invalid și nume gol", async () => {
    await withCleanSeeded(async (tx) => {
      expect(
        await errorOf(
          createOwnerAccount(tx, { email: "nu-e-email", name: "A", password: genPassword() }),
        ),
      ).toBeInstanceOf(ValidationError);
      expect(
        await errorOf(
          createOwnerAccount(tx, { email: genEmail(), name: "  ", password: genPassword() }),
        ),
      ).toBeInstanceOf(ValidationError);
    });
  });

  it("refuză un al doilea Owner (ADMIN_OWNER_EXISTS) dacă nu e permis explicit", async () => {
    await withCleanSeeded(async (tx) => {
      await createOwnerAccount(tx, { email: genEmail(), name: "Primul", password: genPassword() });
      const error = await errorOf(
        createOwnerAccount(tx, { email: genEmail(), name: "Al doilea", password: genPassword() }),
      );
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).code).toBe("ADMIN_OWNER_EXISTS");
      await expect(
        createOwnerAccount(
          tx,
          { email: genEmail(), name: "Al doilea", password: genPassword() },
          { allowAnotherOwner: true },
        ),
      ).resolves.toBeDefined();
    });
  });

  it("refuză un email deja folosit (ADMIN_EMAIL_TAKEN)", async () => {
    await withCleanSeeded(async (tx) => {
      const email = genEmail();
      await tx.user.create({ data: { id: "existing-user", name: "Client", email } });
      const error = await errorOf(
        createOwnerAccount(tx, { email, name: "Admin", password: genPassword() }),
      );
      expect((error as DomainError).code).toBe("ADMIN_EMAIL_TAKEN");
    });
  });

  it("fără seed (rolul Owner lipsește) dă ADMIN_ROLE_MISSING cu indicația de a rula db:seed", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      await tx.userRole.deleteMany();
      await tx.rolePermission.deleteMany();
      await tx.role.deleteMany();
      const error = await errorOf(
        createOwnerAccount(tx, { email: genEmail(), name: "Admin", password: genPassword() }),
      );
      expect((error as DomainError).code).toBe("ADMIN_ROLE_MISSING");
      expect((error as DomainError).message).toContain("pnpm db:seed");
    });
  });
});
