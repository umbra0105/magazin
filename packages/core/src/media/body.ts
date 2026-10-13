import { MediaError } from "./errors";

/**
 * Citește corpul cererii cu o limită de octeți aplicată ÎN TIMPUL stream-ului: la depășire citirea
 * se oprește și fluxul se anulează, fără să încarce restul fișierului în memorie.
 * `Content-Length` e doar o scurtătură (poate minți sau lipsi, la `chunked`); limita reală e cea
 * din buclă.
 */
export async function readBodyWithLimit(request: Request, maxBytes: number): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw tooLarge(maxBytes);
  }
  if (!request.body) throw new MediaError("MEDIA_EMPTY", "Cererea nu conține fișier");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  if (total === 0) throw new MediaError("MEDIA_EMPTY", "Fișierul e gol");
  return Buffer.concat(chunks, total);
}

const tooLarge = (maxBytes: number): MediaError =>
  new MediaError("MEDIA_TOO_LARGE", "Fișierul depășește mărimea maximă permisă", { maxBytes });
