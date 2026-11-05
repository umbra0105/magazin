import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { LocalStorageDriver, deriveSigningKey } from "@ecom/integrations";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { MediaInUseError, MediaLibraryService } from "../media/library";
import { createPrismaLibraryStore } from "../media/library-store";
import { createPrismaProcessingStore } from "../media/processing-store";
import { PermissionService } from "../rbac/permission-service";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import {
  MEDIA_REFERENCING_MODELS,
  PRODUCT_DESCRIPTION_MEDIA_USAGE_PROVIDER,
  createMediaUsageRegistry,
  createProductDescriptionMediaUsageProvider,
} from "./media-usage";
import { plainTextToHtml } from "./rich-text";

/**
 * 15c, pasul 3: descrierea produsului ca HTML. Teste pe Postgres real: tabela de utilizare media (FK Restrict +
 * provider), migrarea de date a descrierilor vechi (text simplu → HTML sigur, idempotentă, cu escape), CHECK-ul
 * «descrierea nu e un șir gol». Nu presupun date de seed: tot ce trebuie îmi creez singur, în tranzacție anulată.
 */

const db = getDb();
let base: string;
let storage: LocalStorageDriver;

const MIGRATION = fileURLToPath(
  new URL(
    "../../../db/prisma/migrations/20261105090000_product_description_rich/migration.sql",
    import.meta.url,
  ),
);

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "ecom-desc-usage-"));
  storage = new LocalStorageDriver({
    rootDir: join(base, "s"),
    appUrl: "https://magazin.test",
    signingKey: deriveSigningKey(Buffer.alloc(32, 7).toString("base64")),
  });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);

async function newMedia(tx: TestTx): Promise<{ id: string; key: string }> {
  const key = `public/media/desc-${uid()}/original.jpg`;
  await storage.put(key, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]), { contentType: "image/jpeg" });
  const row = await tx.media.create({
    data: {
      mime: "image/jpeg",
      sizeBytes: 5,
      checksum: uid(),
      originalName: "poza.jpg",
      storageKey: key,
      status: "ready",
    },
  });
  return { id: row.id, key };
}

const newProduct = (tx: TestTx, title: string, description?: string | null) =>
  tx.product.create({
    data: { slug: `p-${uid()}`, title, ...(description !== undefined && { description }) },
  });

async function withLibrary<T>(
  fn: (c: {
    tx: TestTx;
    service: MediaLibraryService;
    owner: Awaited<ReturnType<PermissionService["loadSubject"]>> & object;
  }) => Promise<T>,
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const service = new MediaLibraryService({
      store: createPrismaLibraryStore(tx),
      storage,
      audit: new AuditService(createPrismaAuditStore(tx)),
      usage: createMediaUsageRegistry(tx),
      processing: createPrismaProcessingStore(tx),
      queue: { enqueueProcess: async () => undefined },
    });
    const user = await tx.user.create({
      data: { id: `desc-${uid()}`, name: "Owner", email: `desc-${uid()}@test.invalid` },
    });
    const role = await tx.role.findUniqueOrThrow({ where: { key: "owner" } });
    await tx.userRole.create({ data: { userId: user.id, roleId: role.id } });
    const owner = await new PermissionService(tx).loadSubject(user.id);
    if (!owner) throw new Error("subject lipsă");
    return fn({ tx, service, owner });
  });
}

describe("ProductDescriptionMediaUsageProvider", () => {
  it("raportează produsul a cărui descriere folosește fișierul, cu link spre produs; fișierele libere lipsesc", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const used = await newMedia(tx);
      const free = await newMedia(tx);
      const product = await newProduct(tx, "Pompă de căldură X");
      await tx.productDescriptionMedia.create({
        data: { productId: product.id, mediaId: used.id },
      });

      const provider = createProductDescriptionMediaUsageProvider(tx);
      const result = await provider.findUsages([used.id, free.id]);
      expect(provider.name).toBe(PRODUCT_DESCRIPTION_MEDIA_USAGE_PROVIDER);
      expect(result.get(used.id)).toEqual([
        {
          kind: "product_description",
          label: "Descriere produs: Pompă de căldură X",
          href: `/admin/produse/${product.id}`,
        },
      ]);
      expect(result.has(free.id)).toBe(false);
      expect((await provider.findUsages([])).size).toBe(0);
    });
  });

  it("un produs șters (soft delete) apare cu «(șters)»; mai multe produse se listează în ordinea titlului", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const m = await newMedia(tx);
      const b = await newProduct(tx, "Bbb");
      const a = await newProduct(tx, "Aaa");
      await tx.productDescriptionMedia.create({ data: { productId: b.id, mediaId: m.id } });
      await tx.productDescriptionMedia.create({ data: { productId: a.id, mediaId: m.id } });
      await tx.product.update({ where: { id: b.id }, data: { deletedAt: new Date() } });
      const usages = (await createProductDescriptionMediaUsageProvider(tx).findUsages([m.id])).get(
        m.id,
      );
      expect(usages?.map((u) => u.label)).toEqual([
        "Descriere produs: Aaa",
        "Descriere produs: Bbb (șters)",
      ]);
    });
  });
});

describe("ștergerea din bibliotecă cu fișiere folosite în descrieri", () => {
  it("fișierul folosit într-o descriere NU se poate șterge (refuz cu lista produselor); după ce e scos, se șterge", async () => {
    await withLibrary(async ({ tx, service, owner }) => {
      const m = await newMedia(tx);
      const product = await newProduct(tx, "Liner albastru");
      await tx.productDescriptionMedia.create({
        data: { productId: product.id, mediaId: m.id },
      });

      const error = await service.delete(owner, m.id).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(MediaInUseError);
      expect((error as MediaInUseError).usages).toEqual([
        {
          kind: "product_description",
          label: "Descriere produs: Liner albastru",
          href: `/admin/produse/${product.id}`,
        },
      ]);
      expect(await tx.media.count({ where: { id: m.id } })).toBe(1);
      expect(await storage.stat(m.key)).not.toBeNull();

      await tx.productDescriptionMedia.delete({
        where: { productId_mediaId: { productId: product.id, mediaId: m.id } },
      });
      await service.delete(owner, m.id);
      expect(await tx.media.count({ where: { id: m.id } })).toBe(0);
      expect(await storage.stat(m.key)).toBeNull();
    });
  });
});

describe("tabela product_description_media (constrângeri în bază)", () => {
  it("baza refuză ștergerea unui fișier folosit într-o descriere (FK Restrict), chiar ocolind serviciul", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const m = await newMedia(tx);
      const product = await newProduct(tx, "P");
      await tx.productDescriptionMedia.create({ data: { productId: product.id, mediaId: m.id } });
      await expect(tx.$executeRaw`DELETE FROM "media" WHERE "id" = ${m.id}`).rejects.toThrow();
    });
  });

  it("ștergerea definitivă a produsului îi șterge legăturile, dar nu fișierul", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const m = await newMedia(tx);
      const product = await newProduct(tx, "P");
      await tx.productDescriptionMedia.create({ data: { productId: product.id, mediaId: m.id } });
      await tx.$executeRaw`DELETE FROM "product" WHERE "id" = ${product.id}`;
      expect(await tx.productDescriptionMedia.count({ where: { mediaId: m.id } })).toBe(0);
      expect(await tx.media.count({ where: { id: m.id } })).toBe(1);
    });
  });

  it("aceeași pereche produs + fișier nu se poate repeta", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const m = await newMedia(tx);
      const product = await newProduct(tx, "P");
      await tx.productDescriptionMedia.create({ data: { productId: product.id, mediaId: m.id } });
      await expect(
        tx.productDescriptionMedia.create({ data: { productId: product.id, mediaId: m.id } }),
      ).rejects.toThrow();
    });
  });

  it("modelul e în lista celor care referă Media, cu providerul lui înregistrat", () => {
    expect(MEDIA_REFERENCING_MODELS["ProductDescriptionMedia"]).toBe(
      PRODUCT_DESCRIPTION_MEDIA_USAGE_PROVIDER,
    );
    expect(createMediaUsageRegistry(db).names).toContain(PRODUCT_DESCRIPTION_MEDIA_USAGE_PROVIDER);
  });
});

describe("CHECK: descrierea nu e un șir gol", () => {
  it("NULL și un text nevid sunt acceptate", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      expect((await newProduct(tx, "P1", null)).description).toBeNull();
      expect((await newProduct(tx, "P2", "<p>x</p>")).description).toBe("<p>x</p>");
    });
  });

  it.each([
    ["șir gol", ""],
    ["spații", "   "],
    ["tab și linii noi", "\t\n \r\n"],
  ])("%s este refuzat de bază", async (_name, value) => {
    await inRolledBackTransaction(db, async (tx) => {
      await expect(newProduct(tx, "P", value)).rejects.toThrow();
    });
  });
});

describe("migrarea de date: descrierile vechi (text simplu) devin HTML sigur", () => {
  const block = (() => {
    const sql = readFileSync(MIGRATION, "utf8");
    const match = /-- DATA-MIGRATION-BEGIN\n([\s\S]*?)-- DATA-MIGRATION-END/.exec(sql);
    if (!match) throw new Error("blocul DATA-MIGRATION lipsește din migrație");
    return (match[1] as string).trim().replace(/;$/, "");
  })();

  const SAMPLES = [
    "simplu",
    "a\nb\n\nc",
    "a\r\nb\r\n\r\nc",
    "a\rb",
    "\n\n  a  \n\n\n\t\n b\n\n",
    "<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>",
    "a < b & c > d",
    "&lt;b&gt; &amp;amp; &",
    'Șurub ț ă î â — „ghilimele” "drepte"',
    "Putere: 5 kW\n- unu\n- doi",
    "<p>text care arată a HTML, dar e text</p>",
    "<p>începe ca HTML, dar nu se termină cu etichetă de închidere",
    "se termină cu etichetă de închidere, dar nu începe cu <p>text</p>",
    "x\n \t \ny",
  ];

  it("funcția SQL dă același rezultat ca plainTextToHtml din TypeScript", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      for (const text of SAMPLES) {
        const rows = await tx.$queryRaw<
          { html: string | null }[]
        >`SELECT plain_text_to_description_html(${text}) AS html`;
        expect(rows[0]?.html, JSON.stringify(text)).toBe(plainTextToHtml(text));
      }
      // text gol: NULL în SQL, null în TS
      for (const empty of ["", " ", "\n\n", " \t \r\n "]) {
        const rows = await tx.$queryRaw<
          { html: string | null }[]
        >`SELECT plain_text_to_description_html(${empty}) AS html`;
        expect(rows[0]?.html).toBeNull();
        expect(plainTextToHtml(empty)).toBeNull();
      }
    });
  });

  async function insertLegacy(tx: TestTx, value: string | null): Promise<string> {
    const id = `legacy-${uid()}`;
    // inserare directă, ocolind CHECK-ul doar pentru rândurile care NU îl încalcă; golurile se simulează mai jos
    await tx.$executeRaw`INSERT INTO "product" ("id", "slug", "title", "description", "updatedAt")
      VALUES (${id}, ${`s-${id}`}, ${"Vechi"}, ${value}, now())`;
    return id;
  }

  const readDescription = async (tx: TestTx, id: string): Promise<string | null> =>
    (
      await tx.$queryRaw<
        { d: string | null }[]
      >`SELECT "description" AS d FROM "product" WHERE "id" = ${id}`
    )[0]?.d ?? null;

  it("convertește fiecare text, cu escape corect pentru < > &, lasă NULL și HTML-ul deja convertit", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const ids = new Map<string, string>();
      for (const text of SAMPLES) ids.set(text, await insertLegacy(tx, text));
      const nullId = await insertLegacy(tx, null);
      const htmlId = await insertLegacy(tx, "<p>deja HTML</p><p>două</p>");

      await tx.$executeRawUnsafe(block);

      for (const text of SAMPLES) {
        const expected =
          text.startsWith("<p>") && text.endsWith("</p>") ? text : plainTextToHtml(text);
        expect(await readDescription(tx, ids.get(text) as string), JSON.stringify(text)).toBe(
          expected,
        );
      }
      expect(await readDescription(tx, nullId)).toBeNull();
      expect(await readDescription(tx, htmlId)).toBe("<p>deja HTML</p><p>două</p>");
      // exemplul cu escape, scris explicit
      expect(await readDescription(tx, ids.get("a < b & c > d") as string)).toBe(
        "<p>a &lt; b &amp; c &gt; d</p>",
      );
    });
  });

  it("este idempotentă: a doua rulare nu schimbă nimic (nu escapează a doua oară)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const ids: string[] = [];
      for (const text of SAMPLES) ids.push(await insertLegacy(tx, text));
      await tx.$executeRawUnsafe(block);
      const first = await Promise.all(ids.map((id) => readDescription(tx, id)));
      const changedSecond = await tx.$executeRawUnsafe(block);
      const second = await Promise.all(ids.map((id) => readDescription(tx, id)));
      expect(second).toEqual(first);
      expect(changedSecond).toBe(0);
    });
  });

  it("descrierile goale sau doar din spații devin NULL (înainte să conteze CHECK-ul)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      // CHECK-ul există deja în baza de test: îl ocolesc doar pentru această simulare, în tranzacția anulată
      await tx.$executeRawUnsafe(
        `ALTER TABLE "product" DROP CONSTRAINT "product_description_not_blank_check"`,
      );
      const empty = await insertLegacy(tx, "");
      const spaces = await insertLegacy(tx, "  \n\t ");
      const real = await insertLegacy(tx, "text");
      await tx.$executeRawUnsafe(block);
      expect(await readDescription(tx, empty)).toBeNull();
      expect(await readDescription(tx, spaces)).toBeNull();
      expect(await readDescription(tx, real)).toBe("<p>text</p>");
    });
  });

  it("rezultatul migrării trece prin sanitizator neschimbat (HTML deja sigur)", async () => {
    const { sanitizeRichHtml } = await import("./rich-text");
    for (const text of SAMPLES) {
      const html = plainTextToHtml(text);
      if (html === null) continue;
      expect(sanitizeRichHtml(html).html, JSON.stringify(text)).toBe(html);
    }
  });
});
