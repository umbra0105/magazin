import { z } from "zod";

/** Valori acceptate pentru variabile booleene din .env ("true"/"false"/"1"/"0"). */
const envBoolean = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const baseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.url({ error: "APP_URL trebuie să fie un URL complet, ex. https://magazin.ro" }),
  // Cheia de criptare a credențialelor de integrare (AES-256-GCM): 32 de octeți, base64.
  APP_KEY: z
    .string()
    .refine((value) => Buffer.from(value, "base64").length === 32, {
      error: "APP_KEY trebuie să fie 32 de octeți codați base64 (generează cu: openssl rand -base64 32)",
    }),
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, { error: "DATABASE_URL trebuie să înceapă cu postgresql://" }),
  REDIS_URL: z.string().regex(/^rediss?:\/\//, { error: "REDIS_URL trebuie să înceapă cu redis://" }),
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

/** Validează variabilele de mediu și aruncă EnvValidationError cu mesaje în română. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  // Șirurile goale (ex. `SENTRY_DSN=`) sunt tratate ca absente.
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ""));
  const result = envSchema.safeParse(cleaned);
  if (result.success) return result.data;

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
