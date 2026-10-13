import { describe, expect, it } from "vitest";
import {
  MAX_BUSY_RETRIES,
  UploadQueue,
  classifyResponse,
  type SendResult,
  type UploadItem,
} from "./media-uploader";

const file = (name: string) => ({ name }) as File;

describe("classifyResponse", () => {
  it("201 → ok", () => {
    expect(classifyResponse({ status: 201 })).toEqual({ kind: "ok" });
  });

  it("503 MEDIA_BUSY → reîncercare după Retry-After (implicit 5 s)", () => {
    expect(classifyResponse({ status: 503, code: "MEDIA_BUSY", retryAfterSeconds: 7 })).toEqual({
      kind: "retry",
      afterSeconds: 7,
    });
    expect(classifyResponse({ status: 503, code: "MEDIA_BUSY" })).toEqual({
      kind: "retry",
      afterSeconds: 5,
    });
  });

  it.each([
    [{ status: 413, code: "MEDIA_TOO_LARGE" }, "tooLarge"],
    [{ status: 413 }, "tooLarge"],
    [{ status: 415, code: "MEDIA_UNSUPPORTED_TYPE" }, "unsupported"],
    [{ status: 415 }, "unsupported"],
    [{ status: 429, code: "AUTH_RATE_LIMITED", retryAfterSeconds: 30 }, "rateLimited"],
    [{ status: 503, code: "MEDIA_STORAGE_UNAVAILABLE" }, "storageUnavailable"],
    [{ status: 503 }, "storageUnavailable"],
    [{ status: 401, code: "AUTH_UNAUTHENTICATED" }, "unauthenticated"],
    [{ status: 403, code: "AUTH_FORBIDDEN" }, "forbidden"],
    [{ status: 403, code: "ORIGIN_INVALID" }, "originInvalid"],
    [{ status: 422, code: "MEDIA_CORRUPT" }, "corrupt"],
    [{ status: 422, code: "MEDIA_IMAGE_TOO_BIG" }, "tooManyPixels"],
    [{ status: 500, code: "MEDIA_UPLOAD_FAILED" }, "generic"],
    [{ status: 0, networkError: true }, "network"],
  ] as [SendResult, string][])("%j → %s", (result, key) => {
    const verdict = classifyResponse(result);
    expect(verdict.kind).toBe("error");
    if (verdict.kind === "error") expect(verdict.key).toBe(key);
  });

  it("429 păstrează Retry-After pentru mesaj", () => {
    expect(classifyResponse({ status: 429, retryAfterSeconds: 42 })).toEqual({
      kind: "error",
      key: "rateLimited",
      retryAfterSeconds: 42,
    });
  });
});

describe("UploadQueue", () => {
  const options = { folderId: null, alt: "" };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it("cel mult 2 încărcări simultane, restul așteaptă în coadă", async () => {
    let inFlight = 0;
    let max = 0;
    const resolvers: (() => void)[] = [];
    const queue = new UploadQueue({
      send: () =>
        new Promise<SendResult>((resolve) => {
          inFlight += 1;
          max = Math.max(max, inFlight);
          resolvers.push(() => {
            inFlight -= 1;
            resolve({ status: 201, mediaId: "m" });
          });
        }),
    });
    queue.add(
      [1, 2, 3, 4, 5].map((n) => file(`f${n}.jpg`)),
      options,
    );
    await tick();
    expect(inFlight).toBe(2);
    expect(queue.snapshot.filter((i) => i.status === "queued")).toHaveLength(3);

    while (resolvers.length) {
      resolvers.shift()?.();
      await tick();
    }
    await tick();
    expect(max).toBe(2);
    expect(queue.snapshot.every((i) => i.status === "done")).toBe(true);
  });

  it("raportează progresul pe fiecare fișier", async () => {
    const seen: number[] = [];
    const queue = new UploadQueue({
      send: async (_f, _o, onProgress) => {
        onProgress(30);
        onProgress(80);
        return { status: 201 };
      },
      onChange: (items) => {
        const p = items[0]?.progress;
        if (p !== undefined) seen.push(p);
      },
    });
    queue.add([file("a.jpg")], options);
    await tick();
    await tick();
    expect(seen).toContain(30);
    expect(seen).toContain(80);
    expect(queue.snapshot[0]?.progress).toBe(100);
  });

  it("503 MEDIA_BUSY: așteaptă Retry-After (cu numărătoare), reîncearcă singur și reușește", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const waits: (number | null)[] = [];
    const queue = new UploadQueue({
      send: async () => {
        calls += 1;
        return calls < 3
          ? { status: 503, code: "MEDIA_BUSY", retryAfterSeconds: 2 }
          : { status: 201, mediaId: "m1" };
      },
      sleep: async (ms) => void sleeps.push(ms),
      onChange: (items) => waits.push(items[0]?.waitingSeconds ?? null),
    });
    queue.add([file("a.jpg")], options);
    await tick();
    await tick();
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1000, 1000, 1000, 1000]); // 2 s × 2 reîncercări
    expect(waits).toContain(2);
    expect(waits).toContain(1);
    expect(queue.snapshot[0]).toMatchObject({ status: "done", mediaId: "m1" });
  });

  it("MEDIA_BUSY peste limită: eroare „busy” după reîncercările automate", async () => {
    let calls = 0;
    const queue = new UploadQueue({
      send: async () => {
        calls += 1;
        return { status: 503, code: "MEDIA_BUSY", retryAfterSeconds: 1 };
      },
      sleep: async () => undefined,
    });
    queue.add([file("a.jpg")], options);
    await tick();
    await tick();
    expect(calls).toBe(MAX_BUSY_RETRIES + 1);
    expect(queue.snapshot[0]).toMatchObject({ status: "error", errorKey: "busy" });
  });

  it("erorile definitive nu se reîncearcă automat; se pot reîncerca manual", async () => {
    let calls = 0;
    const queue = new UploadQueue({
      send: async () => {
        calls += 1;
        return calls === 1 ? { status: 413, code: "MEDIA_TOO_LARGE" } : { status: 201 };
      },
    });
    queue.add([file("mare.jpg")], options);
    await tick();
    await tick();
    expect(calls).toBe(1);
    expect(queue.snapshot[0]).toMatchObject({ status: "error", errorKey: "tooLarge" });

    queue.retry(queue.snapshot[0]!.id);
    await tick();
    await tick();
    expect(calls).toBe(2);
    expect(queue.snapshot[0]?.status).toBe("done");
  });

  it("o eroare de rețea sau o excepție din send devine eroare „network”", async () => {
    const queue = new UploadQueue({
      send: async () => {
        throw new Error("boom");
      },
    });
    queue.add([file("a.jpg")], options);
    await tick();
    await tick();
    expect(queue.snapshot[0]).toMatchObject({ status: "error", errorKey: "network" });
  });

  it("un fișier eșuat nu blochează restul cozii; onUploaded e apelat la fiecare reușită", async () => {
    const uploaded: UploadItem[] = [];
    const queue = new UploadQueue({
      send: async (f) =>
        f.name === "rau.jpg" ? { status: 415, code: "MEDIA_UNSUPPORTED_TYPE" } : { status: 201 },
      onUploaded: (item) => uploaded.push(item),
    });
    queue.add([file("a.jpg"), file("rau.jpg"), file("b.jpg")], options);
    await tick();
    await tick();
    await tick();
    expect(uploaded.map((u) => u.file.name).sort()).toEqual(["a.jpg", "b.jpg"]);
    expect(queue.snapshot.find((i) => i.file.name === "rau.jpg")?.errorKey).toBe("unsupported");
  });

  it("clearFinished scoate doar ce e încărcat", async () => {
    const queue = new UploadQueue({
      send: async (f) => (f.name === "rau.jpg" ? { status: 415 } : { status: 201 }),
    });
    queue.add([file("a.jpg"), file("rau.jpg")], options);
    await tick();
    await tick();
    queue.clearFinished();
    expect(queue.snapshot.map((i) => i.file.name)).toEqual(["rau.jpg"]);
  });
});
