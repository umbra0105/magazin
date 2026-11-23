import { z } from "zod";
import { ValidationError } from "@ecom/shared";
import { inTx, type Db } from "../db-tx";
import { GeoService } from "../geo/siruta-store";
import { addressInputSchema, companyInputSchema } from "../orders/checkout-input";
import { verifyCuiForCheckout, type CuiLookupPort } from "../orders/cui-verification";
import { AccountError } from "./account-errors";

/**
 * Agenda de adrese a clientului (Faza 14): adrese SALVATE, separate de `Address` (snapshot-ul imuabil al comenzii). Validare ca la
 * checkout: județ și localitate din SIRUTA (potrivirea se verifică pe server), telefon `+40…`, cod poștal de 6 cifre, CUI pentru
 * persoane juridice prin aceeași validare (formatul și cifra de control local, ANAF doar completează starea «verificat»).
 * Fiecare operație primește clientul autentificat și lucrează DOAR pe adresele lui: o adresă străină se comportă ca una inexistentă.
 * O singură adresă implicită de livrare și una de facturare pe client (garantat și în bază).
 */
export const ADDRESS_LIMIT = 20;
export const ADDRESS_LABEL_MAX = 60;

export const savedAddressInputSchema = addressInputSchema.extend({
  label: z.string().trim().max(ADDRESS_LABEL_MAX).optional(),
  company: companyInputSchema.nullable().default(null),
  isDefaultShipping: z.boolean().default(false),
  isDefaultBilling: z.boolean().default(false),
});
export type SavedAddressInput = z.input<typeof savedAddressInputSchema>;

export interface SavedAddressView {
  id: string;
  label: string | null;
  fullName: string;
  company: string | null;
  vatId: string | null;
  vatIdVerification: string | null;
  tradeRegisterNo: string | null;
  phone: string;
  countyCode: number;
  countyName: string;
  localityCode: number;
  localityName: string;
  street: string;
  postalCode: string;
  country: string;
  isDefaultShipping: boolean;
  isDefaultBilling: boolean;
}

const SELECT = {
  id: true,
  label: true,
  fullName: true,
  company: true,
  vatId: true,
  vatIdVerification: true,
  tradeRegisterNo: true,
  phone: true,
  countySirutaCode: true,
  county: { select: { countyCode: true } },
  countyName: true,
  localitySirutaCode: true,
  localityName: true,
  street: true,
  postalCode: true,
  country: true,
  isDefaultShipping: true,
  isDefaultBilling: true,
} as const;

function toView(row: {
  id: string;
  label: string | null;
  fullName: string;
  company: string | null;
  vatId: string | null;
  vatIdVerification: string | null;
  tradeRegisterNo: string | null;
  phone: string;
  countySirutaCode: number;
  county: { countyCode: number };
  countyName: string;
  localitySirutaCode: number;
  localityName: string;
  street: string;
  postalCode: string;
  country: string;
  isDefaultShipping: boolean;
  isDefaultBilling: boolean;
}): SavedAddressView {
  return {
    id: row.id,
    label: row.label,
    fullName: row.fullName,
    company: row.company,
    vatId: row.vatId,
    vatIdVerification: row.vatIdVerification,
    tradeRegisterNo: row.tradeRegisterNo,
    phone: row.phone,
    // codul JUD al județului (cel din lista de județe), nu codul SIRUTA al unității
    countyCode: row.county.countyCode,
    countyName: row.countyName,
    localityCode: row.localitySirutaCode,
    localityName: row.localityName,
    street: row.street,
    postalCode: row.postalCode,
    country: row.country,
    isDefaultShipping: row.isDefaultShipping,
    isDefaultBilling: row.isDefaultBilling,
  };
}

export interface AddressBookDeps {
  db: Db;
  cui: CuiLookupPort;
  /** Data de azi (AAAA-LL-ZZ), pentru interogarea ANAF. */
  today: () => string;
}

export class AddressBook {
  constructor(private readonly deps: AddressBookDeps) {}

  async list(userId: string): Promise<SavedAddressView[]> {
    const rows = await this.deps.db.customerAddress.findMany({
      where: { userId },
      select: SELECT,
      orderBy: [{ isDefaultShipping: "desc" }, { isDefaultBilling: "desc" }, { createdAt: "asc" }],
    });
    return rows.map(toView);
  }

  async get(userId: string, id: string): Promise<SavedAddressView> {
    const row = await this.deps.db.customerAddress.findFirst({
      where: { id, userId },
      select: SELECT,
    });
    if (!row) throw new AccountError("ACCOUNT_ADDRESS_NOT_FOUND", "Adresa nu există");
    return toView(row);
  }

  private async prepare(raw: unknown) {
    const parsed = savedAddressInputSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "Adresa nu este validă", {
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const input = parsed.data;
    if (input.country !== "RO") {
      throw new AccountError("ACCOUNT_ADDRESS_INVALID", "Momentan livrăm doar în România");
    }
    let names;
    try {
      names = await new GeoService(this.deps.db).resolveLocation(
        input.countyCode,
        input.localityCode,
      );
    } catch {
      throw new AccountError("ACCOUNT_ADDRESS_INVALID", "Județul și localitatea nu se potrivesc");
    }
    let company: {
      name: string;
      vatId: string;
      verification: string;
      trade: string | null;
    } | null = null;
    if (input.company) {
      const checked = await verifyCuiForCheckout(
        input.company.vatId,
        this.deps.cui,
        this.deps.today(),
      );
      if (!checked.ok) {
        throw new AccountError(
          "ACCOUNT_ADDRESS_INVALID",
          checked.reason === "format" ? "CUI-ul nu are un format valid" : "CUI-ul nu este valid",
        );
      }
      company = {
        name: input.company.name,
        vatId: checked.digits,
        verification: checked.verification,
        trade: input.company.tradeRegisterNo ?? checked.company?.tradeRegisterNo ?? null,
      };
    }
    return { input, names, company };
  }

  private data(p: Awaited<ReturnType<AddressBook["prepare"]>>) {
    return {
      label: p.input.label || null,
      fullName: p.input.fullName,
      phone: p.input.phone,
      countySirutaCode: p.names.countySirutaCode,
      countyName: p.names.countyName,
      localitySirutaCode: p.names.localitySirutaCode,
      localityName: p.names.localityName,
      street: p.input.street,
      postalCode: p.input.postalCode,
      country: p.input.country,
      company: p.company?.name ?? null,
      vatId: p.company?.vatId ?? null,
      vatIdVerification: p.company?.verification ?? null,
      tradeRegisterNo: p.company?.trade ?? null,
    };
  }

  async create(userId: string, raw: unknown): Promise<SavedAddressView> {
    const prepared = await this.prepare(raw);
    return inTx(this.deps.db, async (tx) => {
      const count = await tx.customerAddress.count({ where: { userId } });
      if (count >= ADDRESS_LIMIT) {
        throw new AccountError(
          "ACCOUNT_ADDRESS_LIMIT",
          `Poți salva cel mult ${ADDRESS_LIMIT} de adrese`,
        );
      }
      // prima adresă devine implicită la livrare și la facturare
      const first = count === 0;
      const shipping = prepared.input.isDefaultShipping || first;
      const billing = prepared.input.isDefaultBilling || first;
      if (shipping) {
        await tx.customerAddress.updateMany({
          where: { userId },
          data: { isDefaultShipping: false },
        });
      }
      if (billing) {
        await tx.customerAddress.updateMany({
          where: { userId },
          data: { isDefaultBilling: false },
        });
      }
      const created = await tx.customerAddress.create({
        data: {
          userId,
          ...this.data(prepared),
          isDefaultShipping: shipping,
          isDefaultBilling: billing,
        },
        select: SELECT,
      });
      return toView(created);
    });
  }

  async update(userId: string, id: string, raw: unknown): Promise<SavedAddressView> {
    const prepared = await this.prepare(raw);
    return inTx(this.deps.db, async (tx) => {
      const current = await tx.customerAddress.findFirst({
        where: { id, userId },
        select: { id: true },
      });
      if (!current) throw new AccountError("ACCOUNT_ADDRESS_NOT_FOUND", "Adresa nu există");
      if (prepared.input.isDefaultShipping) {
        await tx.customerAddress.updateMany({
          where: { userId, NOT: { id } },
          data: { isDefaultShipping: false },
        });
      }
      if (prepared.input.isDefaultBilling) {
        await tx.customerAddress.updateMany({
          where: { userId, NOT: { id } },
          data: { isDefaultBilling: false },
        });
      }
      const updated = await tx.customerAddress.update({
        where: { id },
        data: {
          ...this.data(prepared),
          isDefaultShipping: prepared.input.isDefaultShipping,
          isDefaultBilling: prepared.input.isDefaultBilling,
        },
        select: SELECT,
      });
      return toView(updated);
    });
  }

  /** Șterge o adresă; dacă era implicită, cea mai veche rămasă devine implicită (clientul are mereu una, dacă are adrese). */
  async remove(userId: string, id: string): Promise<void> {
    await inTx(this.deps.db, async (tx) => {
      const row = await tx.customerAddress.findFirst({
        where: { id, userId },
        select: { id: true, isDefaultShipping: true, isDefaultBilling: true },
      });
      if (!row) throw new AccountError("ACCOUNT_ADDRESS_NOT_FOUND", "Adresa nu există");
      await tx.customerAddress.delete({ where: { id } });
      const next = await tx.customerAddress.findFirst({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (next && row.isDefaultShipping) {
        await tx.customerAddress.update({
          where: { id: next.id },
          data: { isDefaultShipping: true },
        });
      }
      if (next && row.isDefaultBilling) {
        await tx.customerAddress.update({
          where: { id: next.id },
          data: { isDefaultBilling: true },
        });
      }
    });
  }

  async setDefault(userId: string, id: string, kind: "shipping" | "billing"): Promise<void> {
    await inTx(this.deps.db, async (tx) => {
      const row = await tx.customerAddress.findFirst({
        where: { id, userId },
        select: { id: true },
      });
      if (!row) throw new AccountError("ACCOUNT_ADDRESS_NOT_FOUND", "Adresa nu există");
      const field = kind === "shipping" ? "isDefaultShipping" : "isDefaultBilling";
      await tx.customerAddress.updateMany({ where: { userId }, data: { [field]: false } });
      await tx.customerAddress.update({ where: { id }, data: { [field]: true } });
    });
  }
}
