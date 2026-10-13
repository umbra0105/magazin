import { describe, expect, it } from "vitest";
import { MediaError } from "./errors";
import { readBodyWithLimit } from "./body";

/** Un flux de `chunks` bucăți de `size` octeți; numără câte bucăți au fost efectiv citite. */
function stream(chunks: number, size: number) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= chunks) {
        controller.close();
        return;
      }
      state.pulled += 1;
      controller.enqueue(new Uint8Array(size).fill(1));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

const post = (body: ReadableStream<Uint8Array> | null, headers: Record<string, string> = {}) =>
  new Request("https://magazin.test/api/media", {
    method: "POST",
    body,
    headers,
    duplex: "half",
  });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof MediaError) return error.code;
    throw error;
  }
  return "OK";
}

describe("readBodyWithLimit", () => {
  it("citește un corp sub limită, întreg", async () => {
    const { body } = stream(4, 100);
    const out = await readBodyWithLimit(post(body), 1000);
    expect(out).toHaveLength(400);
  });

  it("exact la limită trece", async () => {
    const { body } = stream(2, 500);
    expect(await readBodyWithLimit(post(body), 1000)).toHaveLength(1000);
  });

  it("depășirea în timpul stream-ului oprește citirea și anulează fluxul (fără Content-Length)", async () => {
    const { body, state } = stream(1000, 100); // 100 KB posibili, limita e 250 de octeți
    expect(await codeOf(readBodyWithLimit(post(body), 250))).toBe("MEDIA_TOO_LARGE");
    expect(state.cancelled).toBe(true);
    // nu s-a citit restul fișierului: doar câteva bucăți (prefetch-ul fluxului), nu cele 1000
    expect(state.pulled).toBeLessThan(10);
  });

  it("un Content-Length mincinos (mic) nu ocolește limita", async () => {
    const { body, state } = stream(1000, 100);
    const request = post(body, { "content-length": "10" });
    expect(await codeOf(readBodyWithLimit(request, 250))).toBe("MEDIA_TOO_LARGE");
    expect(state.cancelled).toBe(true);
  });

  it("un Content-Length peste limită respinge fără să citească corpul", async () => {
    const { body, state } = stream(1000, 100);
    const request = post(body, { "content-length": "9999999" });
    expect(await codeOf(readBodyWithLimit(request, 250))).toBe("MEDIA_TOO_LARGE");
    expect(state.pulled).toBeLessThan(3);
  });

  it("corp lipsă sau gol → MEDIA_EMPTY", async () => {
    expect(await codeOf(readBodyWithLimit(post(null), 100))).toBe("MEDIA_EMPTY");
    const { body } = stream(0, 10);
    expect(await codeOf(readBodyWithLimit(post(body), 100))).toBe("MEDIA_EMPTY");
  });
});
