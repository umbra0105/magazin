import { z } from "zod";

/**
 * Registrul setărilor: singura sursă pentru chei, tipuri și valori implicite NEUTRE.
 * Cheia completă este `grup.nume` (ex. `tax.standardRate`). Valorile reale vin din tabela
 * `Setting`, editabile din admin; aici sunt doar valorile de pornire.
 */
export const settingGroups = {
  general: {
    storeName: z.string().min(1).default("Magazin online"),
    storeTagline: z.string().default(""),
    showPoweredBy: z.boolean().default(true),
  },
  company: {
    legalName: z.string().default(""),
    vatId: z.string().default(""),
    tradeRegisterNo: z.string().default(""),
    isVatPayer: z.boolean().default(true),
    address: z
      .object({
        street: z.string(),
        city: z.string(),
        county: z.string(),
        postalCode: z.string(),
        country: z.string().length(2),
      })
      .default({ street: "", city: "", county: "", postalCode: "", country: "RO" }),
    email: z.string().default(""),
    phone: z.string().default(""),
    iban: z.string().default(""),
    bankName: z.string().default(""),
  },
  regional: {
    allowedCountries: z.array(z.string().length(2)).min(1).default(["RO"]),
    defaultCountry: z.string().length(2).default("RO"),
    currency: z.string().length(3).default("RON"),
    locale: z.string().default("ro-RO"),
    timezone: z.string().default("Europe/Bucharest"),
  },
  tax: {
    /** Cota unică de TVA, în procente. Singura sursă: nu se hardcodează nicăieri în cod. */
    standardRate: z.number().min(0).max(100).default(21),
  },
  inventory: {
    manageStock: z.boolean().default(true),
    reservationMinutes: z.number().int().min(1).default(15),
  },
  checkout: {
    guestCheckoutEnabled: z.boolean().default(true),
  },
  email: {
    fromName: z.string().default(""),
    fromAddress: z.string().default(""),
    replyTo: z.string().default(""),
  },
  legal: {
    anpcUrl: z.string().default(""),
    salUrl: z.string().default(""),
    odrUrl: z.string().default(""),
  },
  appearance: {
    headerVariant: z.string().default("default"),
    footerVariant: z.string().default("default"),
    containerWidth: z.string().default("xl"),
  },
} as const;

export type SettingGroups = typeof settingGroups;
export type SettingGroupName = keyof SettingGroups;

type NameOf<G extends SettingGroupName> = Extract<keyof SettingGroups[G], string>;

/** Toate cheile complete `grup.nume`. */
export type SettingKey = {
  [G in SettingGroupName]: `${G}.${NameOf<G>}`;
}[SettingGroupName];

type ValueAt<G extends SettingGroupName, N extends string> = N extends keyof SettingGroups[G]
  ? SettingGroups[G][N] extends z.ZodType
    ? z.output<SettingGroups[G][N]>
    : never
  : never;

export type SettingValue<K extends SettingKey> = K extends `${infer G}.${infer N}`
  ? G extends SettingGroupName
    ? ValueAt<G, N>
    : never
  : never;

export type SettingGroupValue<G extends SettingGroupName> = {
  [N in NameOf<G>]: ValueAt<G, N>;
};

/** Schema Zod pentru o cheie; `undefined` dacă cheia nu există în registru. */
export function getSettingSchema(key: string): z.ZodType | undefined {
  const [group, name] = key.split(".");
  if (!group || !name || !Object.hasOwn(settingGroups, group)) return undefined;
  const fields = settingGroups[group as SettingGroupName] as Record<string, z.ZodType>;
  return Object.hasOwn(fields, name) ? fields[name] : undefined;
}

/** Toate cheile din registru, cu grupul lor. */
export function listSettingKeys(): { key: SettingKey; group: SettingGroupName }[] {
  return (Object.keys(settingGroups) as SettingGroupName[]).flatMap((group) =>
    Object.keys(settingGroups[group]).map((name) => ({
      key: `${group}.${name}` as SettingKey,
      group,
    })),
  );
}
