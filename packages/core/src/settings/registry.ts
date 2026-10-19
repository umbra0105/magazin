import { z } from "zod";
import { normalizeHostname } from "../media/host";

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
  catalog: {
    /**
     * Garanția implicită, în luni, pusă pe variantele fără garanție proprie la activarea produsului
     * (24 = minimul legal pentru consumatori). Magazinul o poate schimba; produsul o poate suprascrie.
     */
    defaultWarrantyMonths: z.number().int().min(0).max(240).default(24),
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
  auth: {
    /** Clienții trebuie să-și verifice emailul. Oprit = magazin fără SMTP nu își blochează înregistrările. */
    requireEmailVerification: z.boolean().default(true),
    /** Lungime minimă a parolei; fără reguli de compoziție. Nu poate coborî sub 12. */
    minPasswordLength: z.number().int().min(12).max(128).default(12),
    customerSessionDays: z.number().int().min(1).max(365).default(30),
    /** Sesiunile conturilor cu acces la admin sunt mai scurte. */
    adminSessionHours: z.number().int().min(1).max(168).default(8),
    /** Cât e valabil linkul de verificare a emailului (unică folosință). */
    emailVerificationHours: z.number().int().min(1).max(168).default(24),
    /** Cât e valabil linkul de resetare a parolei (unică folosință). */
    passwordResetMinutes: z.number().int().min(5).max(1440).default(60),
    loginMaxAttempts: z.number().int().min(1).max(100).default(5),
    loginWindowMinutes: z.number().int().min(1).max(1440).default(15),
    registerMaxAttempts: z.number().int().min(1).max(100).default(5),
    registerWindowMinutes: z.number().int().min(1).max(1440).default(60),
    passwordResetMaxAttempts: z.number().int().min(1).max(100).default(5),
    passwordResetWindowMinutes: z.number().int().min(1).max(1440).default(60),
    /** Încercări de confirmare a emailului (`/api/verify-email`) per IP în fereastră. */
    verifyEmailMaxAttempts: z.number().int().min(1).max(1000).default(10),
    verifyEmailWindowMinutes: z.number().int().min(1).max(1440).default(15),
    /** Eșecuri de login (pe email) după care contul se blochează temporar. */
    lockoutThreshold: z.number().int().min(3).max(100).default(10),
    lockoutMinutes: z.number().int().min(1).max(1440).default(15),
    /**
     * Câte proxy-uri de încredere sunt în fața aplicației. 0 = niciunul: headerul X-Forwarded-For
     * se ignoră (altfel orice client și-ar putea alege IP-ul și ar ocoli limitele).
     */
    trustedProxyHops: z.number().int().min(0).max(5).default(0),
  },
  media: {
    /** Mărimea maximă a unui fișier încărcat, în octeți (implicit 20 MB; plafon 50 MB: trece prin memorie). */
    maxUploadBytes: z
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(20 * 1024 * 1024),
    /** Pixeli maximi la intrare (lățime × înălțime), împotriva imaginilor-bombă. */
    maxInputPixels: z.number().int().min(1_000_000).max(100_000_000).default(40_000_000),
    /** Tipurile acceptate la încărcare; doar din lista suportată (GIF și SVG nu sunt acceptate). */
    allowedMimeTypes: z
      .array(z.enum(["image/jpeg", "image/png", "image/webp", "image/avif"]))
      .min(1)
      .default(["image/jpeg", "image/png", "image/webp", "image/avif"]),
    /** Încărcări per utilizator în fereastră. */
    uploadMaxAttempts: z.number().int().min(1).max(10_000).default(60),
    uploadWindowMinutes: z.number().int().min(1).max(1440).default(10),
    /** Încercări refuzate (origine, sesiune, permisiune) pe IP care mai intră în jurnalul de audit. */
    refusedAuditMaxAttempts: z.number().int().min(1).max(10_000).default(20),
    /** Lățimile variantelor generate (pixeli, latura mare); fiecare în AVIF, WebP și JPEG. */
    thumbWidth: z.number().int().min(64).max(1000).default(320),
    mediumWidth: z.number().int().min(200).max(2000).default(800),
    largeWidth: z.number().int().min(400).max(4000).default(1600),
    avifQuality: z.number().int().min(1).max(100).default(60),
    webpQuality: z.number().int().min(1).max(100).default(80),
    jpegQuality: z.number().int().min(1).max(100).default(82),
  },
  documents: {
    /** Mărimea maximă a unui document de produs (PDF sau imagine), în octeți (implicit 15 MB; plafon 50 MB). */
    maxUploadBytes: z
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(15 * 1024 * 1024),
    /** Încărcări de documente per utilizator în fereastră (contor separat de cel al bibliotecii media). */
    uploadMaxAttempts: z.number().int().min(1).max(10_000).default(30),
    uploadWindowMinutes: z.number().int().min(1).max(1440).default(10),
    /** Încercări refuzate (origine, sesiune, permisiune) pe IP care mai intră în jurnalul de audit. */
    refusedAuditMaxAttempts: z.number().int().min(1).max(10_000).default(20),
  },
  import: {
    /** Mărimea maximă a unui fișier de import (CSV sau XLSX), în octeți (implicit 10 MB; plafon 50 MB). */
    maxUploadBytes: z
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(10 * 1024 * 1024),
    /** Rânduri de date acceptate într-un import. */
    maxRows: z.number().int().min(1).max(20_000).default(5000),
    maxColumns: z.number().int().min(2).max(200).default(200),
    /** Caractere într-o celulă (implicit cât descrierea unui produs). */
    maxCellLength: z.number().int().min(100).max(100_000).default(100_000),
    /** Conținut decomprimat acceptat dintr-un XLSX (protecție împotriva arhivelor-bombă). */
    maxUncompressedBytes: z
      .number()
      .int()
      .min(1024 * 1024)
      .max(200 * 1024 * 1024)
      .default(60 * 1024 * 1024),
    maxZipEntries: z.number().int().min(10).max(500).default(100),
    /** Până la atâtea rânduri importul se aplică pe loc; peste, rulează în fundal, cu progres. */
    syncMaxRows: z.number().int().min(1).max(1000).default(100),
    /** Cât timp rămâne un import (fișierul neaplicat, apoi raportul) înainte să fie șters. */
    retentionHours: z.number().int().min(1).max(168).default(24),
    /**
     * Cât timp se păstrează RAPORTUL DETALIAT al unui import aplicat (în istoric), în zile. După aceea se
     * șterge detaliul pe rânduri; sumarul (contoarele, utilizatorul, fișierul) rămâne.
     */
    historyRetentionDays: z.number().int().min(7).max(3650).default(180),
    /** Un import care rulează și nu a mai avansat de atâtea minute apare în istoric ca «întrerupt». */
    interruptedAfterMinutes: z.number().int().min(5).max(1440).default(30),
    /** Descărcări de rapoarte de import per utilizator în fereastră (contor separat de încărcări). */
    reportDownloadMaxAttempts: z.number().int().min(1).max(10_000).default(60),
    /** Încărcări de fișiere de import per utilizator în fereastră (contor separat). */
    uploadMaxAttempts: z.number().int().min(1).max(10_000).default(20),
    uploadWindowMinutes: z.number().int().min(1).max(1440).default(10),
    /** Încercări refuzate (origine, sesiune, permisiune) pe IP care mai intră în jurnalul de audit. */
    refusedAuditMaxAttempts: z.number().int().min(1).max(10_000).default(20),
  },
  productExport: {
    /**
     * Rânduri (variante) într-un export de produse. Peste limită exportul se refuză cu un mesaj (se restrânge
     * cu filtre sau cu selecția): fișierul ajunge direct în browser, fără job în fundal. CSV-ul curge din
     * bază pe loturi; XLSX-ul se construiește în memorie, de aceea limita e comună.
     */
    maxRows: z.number().int().min(1).max(100_000).default(20_000),
    /** Exporturi per utilizator în fereastră (contor separat de importuri, media și documente). */
    uploadMaxAttempts: z.number().int().min(1).max(10_000).default(10),
    uploadWindowMinutes: z.number().int().min(1).max(1440).default(10),
    /** Încercări refuzate (origine, sesiune, permisiune) pe IP care mai intră în jurnalul de audit. */
    refusedAuditMaxAttempts: z.number().int().min(1).max(10_000).default(20),
  },
  /**
   * Importul de imagini prin adresă (profilul WooCommerce). SETARE DE SECURITATE: lista de domenii permise se
   * modifică doar cu `settings.write` (Admin, Owner), niciodată din formularul de import. Lista goală = nicio
   * imagine nu se descarcă. Potrivirea e EXACTĂ pe numele gazdei, normalizat (litere mici, fără punct final,
   * punycode); fără wildcard, fără IP, fără port. Lista nu anulează niciodată verificarea adreselor
   * (rețele private, loopback, link-local, metadata): aceea rulează oricum, la fiecare cerere și redirect.
   */
  imageImport: {
    allowedHosts: z
      .array(
        z.string().transform((value, ctx) => {
          const host = normalizeHostname(value);
          if (host === null) {
            ctx.addIssue({
              code: "custom",
              message:
                "Nu e un nume de domeniu valid (fără IP, port, cale, wildcard sau utilizator)",
            });
            return z.NEVER;
          }
          return host;
        }),
      )
      .max(50)
      .default([]),
    /** Mărimea maximă a unei imagini descărcate, în octeți (implicit 15 MB; plafon 50 MB). */
    maxDownloadBytes: z
      .number()
      .int()
      .min(1024)
      .max(50 * 1024 * 1024)
      .default(15 * 1024 * 1024),
    connectTimeoutSeconds: z.number().int().min(1).max(30).default(5),
    /** Timpul total al unei descărcări, cu redirecturile incluse. */
    totalTimeoutSeconds: z.number().int().min(2).max(120).default(30),
    /** Redirecturi urmate (doar în cadrul aceleiași gazde, fiecare revalidat); plafon 3. */
    maxRedirects: z.number().int().min(0).max(3).default(3),
    maxUrlLength: z.number().int().min(100).max(4000).default(2000),
    maxImagesPerProduct: z.number().int().min(1).max(30).default(20),
    maxImagesPerImport: z.number().int().min(1).max(20_000).default(2000),
    /** Descărcări simultane, în total și pe aceeași gazdă. */
    concurrency: z.number().int().min(1).max(10).default(3),
    perHostConcurrency: z.number().int().min(1).max(5).default(2),
  },
  monitoring: {
    /** DSN Sentry. Gol = Sentry complet inactiv. Nu e secret (se trimite și în browser). */
    sentryDsn: z
      .string()
      .refine((v) => v === "" || /^https?:\/\/\S+$/.test(v), "DSN invalid")
      .default(""),
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
