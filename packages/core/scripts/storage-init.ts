/**
 * Pregătește storage-ul din `.env`: `pnpm storage:init`.
 *
 * Cu `STORAGE_DRIVER=s3` creează bucketul `S3_BUCKET` dacă nu există și nu atinge nimic dacă
 * există (idempotent, poate fi rulat oricând). Cu `STORAGE_DRIVER=local` refuză: nu are ce
 * inițializa. Nu afișează endpoint-ul sau credențialele; la eroare apar doar numele și statusul.
 */
import { loadEnv } from "@ecom/config";
import { StorageError, initStorage } from "@ecom/integrations";
import { loadRootEnv } from "./_runtime";

loadRootEnv();

try {
  const { bucket, result, policy } = await initStorage(loadEnv());
  console.log(
    result === "created"
      ? `Bucketul „${bucket}” a fost creat.`
      : `Bucketul „${bucket}” există deja.`,
  );
  console.log(
    policy === "applied"
      ? "Politica de citire anonimă pe public/* a fost aplicată (private/ rămâne accesibil doar cu link semnat)."
      : policy === "unchanged"
        ? "Politica de citire anonimă pe public/* era deja aplicată."
        : "Bucketul are o altă politică; nu am atins-o. Verifică manual că public/* se poate citi anonim și private/* nu.",
  );
} catch (error) {
  if (error instanceof StorageError) {
    const details = (error.details ?? {}) as { errorName?: string; status?: number };
    console.error(
      `${error.message}${details.errorName ? ` (${details.errorName}, status ${details.status ?? "?"})` : ""}`,
    );
    if (error.code === "STORAGE_FAILED") {
      console.error(
        "Verifică dacă MinIO/serviciul S3 rulează și dacă variabilele S3_* din .env sunt corecte.",
      );
    }
  } else {
    // eroare de configurare (EnvValidationError) sau neașteptată: mesajul nu conține secrete
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exit(1);
}
