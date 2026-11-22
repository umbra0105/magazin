"use server";

import { z } from "zod";
import { getSettingSchema, type SettingKey } from "@ecom/core";
import { getAdminWrites } from "@/lib/admin-writes";
import { getSettings } from "@/lib/services";
import { withPermission } from "@/lib/session";

/**
 * Datele firmei din admin (`/admin/setari/firma`, Faza 13). Cere `settings.write`; fiecare valoare se validează cu schema ei din
 * registrul de setări (o singură sursă, la fel ca în vitrină și în facturare), iar scrierea trece prin `AdminWrites`: auditul
 * diferenței (doar ce s-a schimbat) și reîmprospătarea vitrinei (subsol, «Cum comanzi», JSON-LD) prin invalidarea cache-ului. Cota de
 * TVA nu se schimbă de aici. Erorile se întorc pe câmp.
 */
const input = z.strictObject({
  legalName: z.string().max(200),
  vatId: z.string().max(40),
  tradeRegisterNo: z.string().max(60),
  isVatPayer: z.boolean(),
  phone: z.string().max(40),
  email: z.string().max(200),
  street: z.string().max(200),
  city: z.string().max(120),
  county: z.string().max(120),
  postalCode: z.string().max(20),
  country: z.string().max(10),
  iban: z.string().max(60),
  bankName: z.string().max(120),
  pickupHours: z.string().max(1000),
  anpcUrl: z.string().max(500),
  salUrl: z.string().max(500),
  odrUrl: z.string().max(500),
});

export type SaveCompanyResult = { ok: true } | { ok: false; errors: Record<string, string> };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IBAN = /^[A-Za-z]{2}[0-9A-Za-z]{13,32}$/;
const VAT_ID = /^[0-9A-Za-z]{0,20}$/;
const isHttps = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export const saveCompanySettings = withPermission(
  "settings.write",
  async (raw: unknown, subject): Promise<SaveCompanyResult> => {
    const parsed = input.safeParse(raw);
    if (!parsed.success) return { ok: false, errors: { form: "invalid" } };
    const d = parsed.data;
    const errors: Record<string, string> = {};

    // valorile se salvează așa cum le-a scris adminul (tăiate de spații); validarea ignoră spațiile din interior
    const vatId = d.vatId.trim();
    const email = d.email.trim().toLowerCase();
    const iban = d.iban.trim();
    const country = d.country.trim().toUpperCase();
    if (!VAT_ID.test(vatId.replace(/\s+/g, ""))) errors["vatId"] = "vatId";
    if (email !== "" && !EMAIL.test(email)) errors["email"] = "email";
    if (iban !== "" && !IBAN.test(iban.replace(/\s+/g, ""))) errors["iban"] = "iban";
    if (!/^[A-Z]{2}$/.test(country)) errors["country"] = "country";
    for (const key of ["anpcUrl", "salUrl", "odrUrl"] as const) {
      const value = d[key].trim();
      if (value !== "" && !isHttps(value)) errors[key] = "url";
    }

    const next: Array<[SettingKey, unknown, string]> = [
      ["company.legalName", d.legalName.trim(), "legalName"],
      ["company.vatId", vatId, "vatId"],
      ["company.tradeRegisterNo", d.tradeRegisterNo.trim(), "tradeRegisterNo"],
      ["company.isVatPayer", d.isVatPayer, "isVatPayer"],
      ["company.phone", d.phone.trim(), "phone"],
      ["company.email", email, "email"],
      [
        "company.address",
        {
          street: d.street.trim(),
          city: d.city.trim(),
          county: d.county.trim(),
          postalCode: d.postalCode.trim(),
          country,
        },
        "street",
      ],
      ["company.iban", iban, "iban"],
      ["company.bankName", d.bankName.trim(), "bankName"],
      ["company.pickupHours", d.pickupHours.trim(), "pickupHours"],
      ["legal.anpcUrl", d.anpcUrl.trim(), "anpcUrl"],
      ["legal.salUrl", d.salUrl.trim(), "salUrl"],
      ["legal.odrUrl", d.odrUrl.trim(), "odrUrl"],
    ];
    for (const [key, value, field] of next) {
      if (errors[field]) continue;
      const schema = getSettingSchema(key);
      if (schema && !schema.safeParse(value).success) {
        errors[field] = field === "pickupHours" ? "pickupHours" : "long";
      }
    }
    if (Object.keys(errors).length > 0) return { ok: false, errors };

    const settings = getSettings();
    for (const [key, value] of next) {
      const current = await settings.get(key);
      if (sameValue(current, value)) continue;
      await getAdminWrites().updateSetting(
        { key, value },
        { id: subject.userId, label: subject.email },
      );
    }
    return { ok: true };
  },
  { action: "company-settings.update", entity: "setting" },
);
