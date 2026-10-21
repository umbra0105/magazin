import { z } from "zod";

/** Valori acceptate pentru variabile booleene din .env ("true"/"false"/"1"/"0"). */
const envBoolean = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const baseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url({ error: "APP_URL trebuie să fie un URL complet, ex. https://magazin.ro" }),
  // Cheia de criptare a credențialelor de integrare (AES-256-GCM): 32 de octeți, base64.
  APP_KEY: z.string().refine((value) => Buffer.from(value, "base64").length === 32, {
    error:
      "APP_KEY trebuie să fie 32 de octeți codați base64 (generează cu: openssl rand -base64 32)",
  }),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, { error: "DATABASE_URL trebuie să înceapă cu postgresql://" }),
  REDIS_URL: z
    .string()
    .regex(/^rediss?:\/\//, { error: "REDIS_URL trebuie să înceapă cu redis://" }),
  SENTRY_DSN: z.url().optional(),
});

const localStorageSchema = z.object({
  STORAGE_DRIVER: z.literal("local"),
  STORAGE_LOCAL_PATH: z.string().min(1).default("./storage"),
});

const s3StorageSchema = z.object({
  STORAGE_DRIVER: z.literal("s3"),
  S3_ENDPOINT: z.url({ error: "S3_ENDPOINT trebuie să fie un URL complet" }),
  S3_REGION: z.string().min(1).default("auto"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: envBoolean.default(false),
  // CDN sau bucket public pentru fișierele `public/…`; fără el, URL-urile trec prin ruta aplicației.
  S3_PUBLIC_URL: z.url({ error: "S3_PUBLIC_URL trebuie să fie un URL complet" }).optional(),
});

const storageSchema = z.discriminatedUnion("STORAGE_DRIVER", [localStorageSchema, s3StorageSchema]);

export const envSchema = z.intersection(baseSchema, storageSchema);

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  readonly code = "ENV_INVALID";
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      [
        "Configurarea mediului (.env) este invalidă:",
        ...issues.map((issue) => `  - ${issue}`),
        "",
        "Copiază .env.example în .env și completează valorile lipsă.",
      ].join("\n"),
    );
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

/** Cheia publicată în `.env.example` (decodat: «dev-only-app-key-32-bytes-long!!»): doar pentru dezvoltare. */
const EXAMPLE_APP_KEY = "ZGV2LW9ubHktYXBwLWtleS0zMi1ieXRlcy1sb25nISE=";
/** Sub atâtea valori distincte de octet, cheia (32 de octeți) nu poate fi aleatorie (una aleatorie are ~30). */
const MIN_DISTINCT_KEY_BYTES = 16;

/** Adrese locale: dezvoltare, build-uri de probă și E2E rulează cu `NODE_ENV=production` pe localhost. */
function isLocalHost(appUrl: string): boolean {
  const host = new URL(appUrl).hostname.replace(/^[|]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.endsWith(".localhost") ||
    host.endsWith(".test")
  );
}

/**
 * Din `APP_KEY` derivă secretul sesiunilor, cheia linkurilor semnate (documente private), cheia credențialelor de
 * integrare și sigiliul joburilor de email: o cheie publicată sau slabă într-un site real le compromite pe toate (C-10).
 * Verificarea se aplică în producție, pe adrese care nu sunt locale.
 */
function weakProductionKeyIssue(env: Env): string | null {
  if (env.NODE_ENV !== "production" || isLocalHost(env.APP_URL)) return null;
  if (env.APP_KEY === EXAMPLE_APP_KEY) {
    return "APP_KEY: este cheia de exemplu din .env.example, publică; generează una proprie (openssl rand -base64 32)";
  }
  if (new Set(Buffer.from(env.APP_KEY, "base64")).size < MIN_DISTINCT_KEY_BYTES) {
    return "APP_KEY: cheie prea slabă (octeți repetați); generează una aleatorie (openssl rand -base64 32)";
  }
  return null;
}

/** Validează variabilele de mediu și aruncă EnvValidationError cu mesaje în română. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  // Șirurile goale (ex. `SENTRY_DSN=`) sunt tratate ca absente.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
  const result = envSchema.safeParse(cleaned);
  if (result.success) {
    const weak = weakProductionKeyIssue(result.data);
    if (weak) throw new EnvValidationError([weak]);
    return result.data;
  }

  throw new EnvValidationError(
    result.error.issues.map((issue) => {
      const name = issue.path.join(".") || "(env)";
      const missing = issue.code === "invalid_type" && issue.input === undefined;
      return missing ? `${name}: lipsește` : `${name}: ${issue.message}`;
    }),
  );
}

let cached: Env | undefined;

/** Citește și memorează env-ul din `process.env`. Apelat la boot: eșuează devreme. */
export function loadEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
