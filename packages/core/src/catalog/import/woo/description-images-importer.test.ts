import { describe, expect, it } from "vitest";
import type { AuditService } from "../../../audit/audit-service";
import { DEFAULT_ROLES } from "../../../rbac/catalog";
import type { PermissionSubject } from "../../../rbac/can";
import { DESCRIPTION_TOKEN_LENGTH } from "./description-images";
import type { ImageTask, ImageTaskStatus, ImageTaskStore, NewImageTask } from "./image-store";
import { ProductImageImporter, type ImageImportPolicy } from "./image-importer";

/**
 * Imaginile din descrieri (15d), pe importatorul real, cu depozite în memorie: marcajul din descriere devine
 * `<img data-media-id>`, imaginea eșuată își păstrează marcajul pentru reluare, a doua rulare nu schimbă nimic, o descriere
 * editată între timp nu se suprascrie (se înlocuiesc doar marcajele), iar imaginile din descrieri NU intră în galeria produsului.
 */

const subjectFor = (roleKey: string): PermissionSubject => {
  const role = DEFAULT_ROLES.find((r) => r.key === roleKey);
  return {
    userId: `u-${roleKey}`,
    email: `${roleKey}@test.invalid`,
    roles: [roleKey],
    permissions: new Set(role?.permissions ?? []),
  };
};

const hashOf = (name: string): string => {
  const hex = Buffer.from(name).toString("hex").padEnd(64, "0");
  return hex.slice(0, 64);
};
const prefix = (name: string): string => hashOf(name).slice(0, DESCRIPTION_TOKEN_LENGTH);
const marker = (name: string): string => `{{img:${prefix(name)}}}`;

interface Fake {
  importer: ProductImageImporter;
  store: ImageTaskStore;
  tasks: ImageTask[];
  descriptions: Map<string, string | null>;
  media: Map<string, string>; // hash → mediaId
  productMedia: Map<string, string[]>;
  updates: { productId: string; description: string }[];
  fetched: string[];
  failing: Set<string>; // adrese care eșuează la descărcare
  permission: { role: string };
}

function world(
  taskInputs: (NewImageTask & { status?: ImageTaskStatus })[],
  descriptions: Record<string, string | null>,
  role = "owner",
): Fake {
  const tasks: ImageTask[] = taskInputs.map((task, index) => ({
    id: `t${index}`,
    importId: "imp1",
    kind: "product",
    status: "pending",
    reason: null,
    ...task,
  }));
  const fake: Fake = {
    importer: undefined as never,
    store: undefined as never,
    tasks,
    descriptions: new Map(Object.entries(descriptions)),
    media: new Map(),
    productMedia: new Map(),
    updates: [],
    fetched: [],
    failing: new Set(),
    permission: { role },
  };
  let mediaCounter = 0;
  const store: ImageTaskStore = {
    async insertTasks() {
      return 0;
    },
    async listTasks(_importId, statuses) {
      return fake.tasks.filter((task) => statuses.includes(task.status));
    },
    async setResult(taskId, result) {
      const task = fake.tasks.find((candidate) => candidate.id === taskId);
      if (task) Object.assign(task, result);
    },
    async resetFailed() {
      let count = 0;
      for (const task of fake.tasks) {
        if (task.status === "failed") {
          task.status = "pending";
          task.reason = null;
          count += 1;
        }
      }
      return count;
    },
    async progress() {
      return new Map();
    },
    async failures() {
      return [];
    },
    async findMediaBySourceHash(hash) {
      const id = fake.media.get(hash);
      return id ? { id, status: "ready" } : null;
    },
    async findMediaBySourceHashes(hashes) {
      const out = new Map<string, { id: string; status: string }>();
      for (const hash of hashes) {
        const id = fake.media.get(hash);
        if (id) out.set(hash, { id, status: "ready" });
      }
      return out;
    },
    async productMediaIds(productId) {
      return fake.productMedia.get(productId) ?? [];
    },
    async productTitles(productIds) {
      return new Map(productIds.map((id) => [id, `Produs ${id}`]));
    },
    async productDescriptions(productIds) {
      return new Map(productIds.map((id) => [id, fake.descriptions.get(id) ?? null]));
    },
  };
  fake.store = store;
  const policy: ImageImportPolicy = {
    allowedHosts: ["exemplu.invalid"],
    maxUrlLength: 2000,
    maxDownloadBytes: 1_000_000,
    connectTimeoutSeconds: 5,
    totalTimeoutSeconds: 10,
    maxRedirects: 2,
    concurrency: 2,
    perHostConcurrency: 2,
  };
  fake.importer = new ProductImageImporter({
    tasks: store,
    imports: {
      async get() {
        return { id: "imp1", status: "completed", createdById: "u1" } as never;
      },
    },
    fetchImage: async (url) => {
      fake.fetched.push(url);
      if (fake.failing.has(url)) throw Object.assign(new Error("x"), { code: "bad_status" });
      return { bytes: Buffer.from("x"), host: "exemplu.invalid" };
    },
    media: {
      async upload(input) {
        mediaCounter += 1;
        const id = `m${mediaCounter}`;
        fake.media.set((input as { sourceHash: string }).sourceHash, id);
        return { id } as never;
      },
    },
    processMedia: async () => "ready",
    assignments: {
      async setMedia(_subject, productId, input) {
        fake.productMedia.set(productId, [...(input as { mediaIds: string[] }).mediaIds]);
        return undefined as never;
      },
    },
    products: {
      async update(_subject, productId, input) {
        const description = (input as { description: string }).description;
        fake.updates.push({ productId, description });
        fake.descriptions.set(productId, description);
        return undefined as never;
      },
    },
    getPolicy: async () => policy,
    getMediaLimits: async () => ({ allowedMimeTypes: ["image/png"], maxInputPixels: 1_000_000 }),
    loadSubject: async () => subjectFor(fake.permission.role),
    audit: { record: async () => undefined } as unknown as AuditService,
    logger: { warn: () => undefined, error: () => undefined },
  });
  return fake;
}

const task = (name: string, productId = "p1", over: Partial<NewImageTask> = {}): NewImageTask => ({
  kind: "description",
  productId,
  row: 2,
  sku: "SKU-1",
  position: 0,
  sourceUrl: `https://exemplu.invalid/${name}.png`,
  sourceHash: hashOf(name),
  host: "exemplu.invalid",
  ...over,
});

describe("imaginile din descrieri: marcajul devine <img data-media-id>", () => {
  it("descarcă imaginea și înlocuiește marcajul din locul lui, fără să atingă restul descrierii", async () => {
    const f = world([task("a")], { p1: `<p>Înainte</p><p>${marker("a")}</p><p>După</p>` });
    const summary = await f.importer.run("imp1");
    expect(f.fetched).toEqual(["https://exemplu.invalid/a.png"]);
    expect(f.updates).toEqual([
      {
        productId: "p1",
        description: `<p>Înainte</p><p><img data-media-id="m1" alt=""></p><p>După</p>`,
      },
    ]);
    expect(summary).toMatchObject({ downloaded: 1, descriptions: 1, descriptionImages: 1 });
    expect(f.tasks[0]).toMatchObject({ status: "downloaded", reason: null });
  });

  it("imaginile din descriere NU se atașează galeriei produsului; cele din coloana «Imagini» da", async () => {
    const f = world([task("a"), task("g", "p1", { kind: "product", position: 0 })], {
      p1: `<p>${marker("a")}</p>`,
    });
    const summary = await f.importer.run("imp1");
    expect(f.productMedia.get("p1")).toEqual(["m2"]);
    expect(summary.attached).toBe(1);
  });

  it("aceeași adresă la două produse: o singură descărcare, ambele descrieri primesc imaginea", async () => {
    const f = world([task("a", "p1"), task("a", "p2")], {
      p1: `<p>${marker("a")}</p>`,
      p2: `<p>x${marker("a")}</p>`,
    });
    await f.importer.run("imp1");
    expect(f.fetched).toHaveLength(1);
    expect(f.descriptions.get("p1")).toBe(`<p><img data-media-id="m1" alt=""></p>`);
    expect(f.descriptions.get("p2")).toBe(`<p>x<img data-media-id="m1" alt=""></p>`);
  });

  it("fișierul deja în bibliotecă (aceeași adresă adusă înainte) se folosește fără descărcare", async () => {
    const f = world([task("a")], { p1: `<p>${marker("a")}</p>` });
    f.media.set(hashOf("a"), "m_existent");
    await f.importer.run("imp1");
    expect(f.fetched).toEqual([]);
    expect(f.descriptions.get("p1")).toBe(`<p><img data-media-id="m_existent" alt=""></p>`);
    expect(f.tasks[0]?.status).toBe("existing");
  });

  it("aceeași imagine de două ori în aceeași descriere: ambele locuri se înlocuiesc", async () => {
    const f = world([task("a")], { p1: `<p>${marker("a")}</p><p>${marker("a")}</p>` });
    const summary = await f.importer.run("imp1");
    expect(f.descriptions.get("p1")).toBe(
      `<p><img data-media-id="m1" alt=""></p><p><img data-media-id="m1" alt=""></p>`,
    );
    expect(summary.descriptionImages).toBe(2);
  });
});

describe("eșec, reluare și idempotență", () => {
  it("imaginea eșuată își păstrează marcajul (pentru reluare); celelalte imagini ale descrierii se înlocuiesc", async () => {
    const f = world([task("a"), task("b", "p1", { position: 1 })], {
      p1: `<p>${marker("a")}</p><p>${marker("b")}</p>`,
    });
    f.failing.add("https://exemplu.invalid/b.png");
    const summary = await f.importer.run("imp1");
    expect(f.descriptions.get("p1")).toBe(
      `<p><img data-media-id="m1" alt=""></p><p>${marker("b")}</p>`,
    );
    expect(summary).toMatchObject({ downloaded: 1, failed: 1, descriptionImages: 1 });
    expect(f.tasks.find((t) => t.sourceUrl.endsWith("b.png"))).toMatchObject({
      status: "failed",
      reason: "download_failed",
    });
  });

  it("reluarea (resetFailed + rulare) aduce imaginea lipsă în același loc și nu atinge ce e gata", async () => {
    const f = world([task("a"), task("b", "p1", { position: 1 })], {
      p1: `<p>${marker("a")}</p><p>${marker("b")}</p>`,
    });
    f.failing.add("https://exemplu.invalid/b.png");
    await f.importer.run("imp1");
    f.failing.clear();
    await f.store.resetFailed("imp1");
    f.fetched.length = 0;
    await f.importer.run("imp1");
    expect(f.fetched).toEqual(["https://exemplu.invalid/b.png"]);
    expect(f.descriptions.get("p1")).toBe(
      `<p><img data-media-id="m1" alt=""></p><p><img data-media-id="m2" alt=""></p>`,
    );
  });

  it("a doua rulare nu descarcă nimic și nu scrie nimic (idempotent)", async () => {
    const f = world([task("a")], { p1: `<p>${marker("a")}</p>` });
    await f.importer.run("imp1");
    const updatesAfterFirst = f.updates.length;
    f.fetched.length = 0;
    const second = await f.importer.run("imp1");
    expect(f.fetched).toEqual([]);
    expect(f.updates).toHaveLength(updatesAfterFirst);
    expect(second).toMatchObject({ downloaded: 0, descriptions: 0, descriptionImages: 0 });
  });

  it("o descriere editată între timp rămâne a utilizatorului: doar marcajul se înlocuiește, restul textului nu se atinge", async () => {
    const f = world([task("a")], { p1: `<p>Text scris de mână</p><p>${marker("a")}</p>` });
    await f.importer.run("imp1");
    expect(f.descriptions.get("p1")).toBe(
      `<p>Text scris de mână</p><p><img data-media-id="m1" alt=""></p>`,
    );
  });

  it("marcajul șters de utilizator între timp: imaginea se aduce, dar nu se re-adaugă în descriere", async () => {
    const f = world([task("a")], { p1: `<p>Fără marcaj</p>` });
    const summary = await f.importer.run("imp1");
    expect(f.updates).toEqual([]);
    expect(summary).toMatchObject({ downloaded: 1, descriptions: 0 });
    expect(f.descriptions.get("p1")).toBe("<p>Fără marcaj</p>");
  });

  it("un marcaj care nu aparține niciunei sarcini a importului rămâne neatins", async () => {
    const f = world([task("a")], { p1: `<p>${marker("a")}</p><p>${marker("necunoscut")}</p>` });
    await f.importer.run("imp1");
    expect(f.descriptions.get("p1")).toBe(
      `<p><img data-media-id="m1" alt=""></p><p>${marker("necunoscut")}</p>`,
    );
  });
});

describe("drepturi", () => {
  it("fără products.write și media.write sarcinile eșuează cu «permission»: nicio descărcare, nicio scriere", async () => {
    const f = world([task("a")], { p1: `<p>${marker("a")}</p>` }, "viewer-inexistent");
    const summary = await f.importer.run("imp1");
    expect(f.fetched).toEqual([]);
    expect(f.updates).toEqual([]);
    expect(f.tasks[0]).toMatchObject({ status: "failed", reason: "permission" });
    expect(summary.failed).toBe(1);
  });
});
