import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getDb } from "@ecom/db";
import { createLogger } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { PermissionService } from "../rbac/permission-service";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { ProductLifecycleService } from "./product-lifecycle";
import { createPrismaProductLifecycleStore } from "./product-lifecycle-store";
import { ProductService } from "./product-service";
import { createPrismaProductStore } from "./product-store";

/**
 * 15c, pasul 4: orice scriere a descrierii produsului trece prin sanitizator. Pe Postgres real: serviciul de produse
 * (creare, modificare), legăturile cu fișierele media din descriere și duplicarea.
 */

const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);
const NOW = new Date("2026-10-14T12:00:00Z");

async function withServices<T>(
  fn: (c: {
    tx: TestTx;
    service: ProductService;
    lifecycle: ProductLifecycleService;
    as: (role: string) => ReturnType<PermissionService["loadSubject"]>;
  }) => Promise<T>,
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const logger = createLogger({ destination: { write() {} } });
    const audit = new AuditService(createPrismaAuditStore(tx));
    const service = new ProductService({
      store: createPrismaProductStore(tx),
      audit,
      defaultManageStock: async () => true,
      invalidate: () => undefined,
      logger,
      now: () => NOW,
    });
    const lifecycle = new ProductLifecycleService({
      store: createPrismaProductLifecycleStore(tx),
      products: createPrismaProductStore(tx),
      audit,
      deleteFiles: vi.fn(async () => {}),
      logger,
    });
    let n = 0;
    const as = async (role: string) => {
      const user = await tx.user.create({
        data: { id: `pd-${role}-${n++}`, name: role, email: `pd-${role}-${n}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      return new PermissionService(tx).loadSubject(user.id);
    };
    return fn({ tx, service, lifecycle, as });
  });
}

const newMedia = (tx: TestTx, overrides: { mime?: string; status?: string } = {}) =>
  tx.media.create({
    data: {
      mime: overrides.mime ?? "image/png",
      sizeBytes: 5,
      checksum: uid(),
      originalName: "poza.png",
      storageKey: `public/media/${uid()}/original.png`,
      status: overrides.status ?? "ready",
    },
  });

const image = (id: string, alt = "") => `<img data-media-id="${id}" alt="${alt}">`;

const create = (service: ProductService, subject: unknown, description?: string | null) =>
  service.create(subject as never, {
    title: `Produs ${uid()}`,
    ...(description !== undefined && { description }),
    variants: [{ sku: `PD-${uid()}`, price: 1000 }],
  });

const linkedMedia = async (tx: TestTx, productId: string): Promise<string[]> =>
  (await tx.productDescriptionMedia.findMany({ where: { productId } }))
    .map((row) => row.mediaId)
    .sort();

describe("ProductService: descrierea trece prin sanitizator", () => {
  it("la creare, HTML-ul ostil se curăță; ce rămâne e doar lista albă", async () => {
    await withServices(async ({ tx, service, as }) => {
      const { product } = await create(
        service,
        await as("manager"),
        '<p onclick="alert(1)">Text <b>aldin</b></p><script>alert(1)</script><a href="javascript:alert(1)">l</a>' +
          '<a href="https://exemplu.ro/x">extern</a><iframe src="https://evil.example"></iframe>',
      );
      const stored = (await tx.product.findUniqueOrThrow({ where: { id: product.id } }))
        .description;
      expect(stored).toBe(
        '<p>Text <strong>aldin</strong></p>l<a href="https://exemplu.ro/x" target="_blank" rel="noopener noreferrer">extern</a>',
      );
      expect(product.description).toBe(stored);
    });
  });

  it("textul simplu din formularul vechi devine paragrafe cu escape", async () => {
    await withServices(async ({ service, as }) => {
      const { product } = await create(
        service,
        await as("manager"),
        "Linia 1\nLinia 2\n\na < b & c",
      );
      expect(product.description).toBe("<p>Linia 1<br />Linia 2</p><p>a &lt; b &amp; c</p>");
    });
  });

  it.each(["", "   ", "<p></p>", "<p>&nbsp;</p>", "<p><br></p>", "<p> </p><p></p>"])(
    "descriere goală (%j) → NULL în bază, nu șir gol",
    async (empty) => {
      await withServices(async ({ tx, service, as }) => {
        const manager = await as("manager");
        const { product } = await create(service, manager, empty);
        expect(product.description).toBeNull();
        const updated = await create(service, manager, "<p>text</p>");
        const after = await service.update(manager, updated.product.id, { description: empty });
        expect(after.description).toBeNull();
        expect(
          (await tx.product.findUniqueOrThrow({ where: { id: updated.product.id } })).description,
        ).toBeNull();
      });
    },
  );

  it("imaginile din descriere: legăturile cu media se creează, se înlocuiesc și dispar odată cu imaginea", async () => {
    await withServices(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const a = await newMedia(tx);
      const b = await newMedia(tx);
      const { product } = await create(service, manager, `<p>x</p>${image(a.id, "A")}`);
      expect(await linkedMedia(tx, product.id)).toEqual([a.id]);

      await service.update(manager, product.id, {
        description: `<p>x</p>${image(a.id)}${image(b.id)}`,
      });
      expect(await linkedMedia(tx, product.id)).toEqual([a.id, b.id].sort());

      await service.update(manager, product.id, { description: `<p>x</p>${image(b.id)}` });
      expect(await linkedMedia(tx, product.id)).toEqual([b.id]);

      await service.update(manager, product.id, { description: null });
      expect(await linkedMedia(tx, product.id)).toEqual([]);
    });
  });

  it("o imagine cu fișier inexistent, de alt tip sau eșuat se elimină din descriere (nu se leagă)", async () => {
    await withServices(async ({ tx, service, as }) => {
      const ok = await newMedia(tx);
      const pdf = await newMedia(tx, { mime: "application/pdf" });
      const failed = await newMedia(tx, { status: "failed" });
      const { product } = await create(
        service,
        await as("manager"),
        `<p>t</p>${image(ok.id)}${image(pdf.id)}${image(failed.id)}${image("cm0nuexistaniciodata123")}`,
      );
      expect(product.description).toBe(`<p>t</p><img alt="" data-media-id="${ok.id}" />`);
      expect(await linkedMedia(tx, product.id)).toEqual([ok.id]);
    });
  });

  it("aceeași imagine în două produse: legăturile sunt independente", async () => {
    await withServices(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const m = await newMedia(tx);
      const one = await create(service, manager, image(m.id));
      const two = await create(service, manager, image(m.id));
      expect(await linkedMedia(tx, one.product.id)).toEqual([m.id]);
      expect(await linkedMedia(tx, two.product.id)).toEqual([m.id]);
      await service.update(manager, one.product.id, { description: "<p>fără imagine</p>" });
      expect(await linkedMedia(tx, one.product.id)).toEqual([]);
      expect(await linkedMedia(tx, two.product.id)).toEqual([m.id]);
    });
  });

  it("Editorul (doar products.content.write) poate modifica descrierea, tot sanitizată", async () => {
    await withServices(async ({ service, as }) => {
      const { product } = await create(service, await as("manager"), "<p>a</p>");
      const after = await service.update(await as("editor"), product.id, {
        description: '<p onmouseover="x">b</p><script>1</script>',
      });
      expect(after.description).toBe("<p>b</p>");
    });
  });

  it("auditul conține valoarea curățată, niciodată HTML-ul ostil trimis", async () => {
    await withServices(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const { product } = await create(service, manager, "<p>a</p>");
      await service.update(manager, product.id, {
        description: '<p onclick="alert(1)">b</p><script>alert(1)</script>',
      });
      const rows = await tx.auditLog.findMany({
        where: { entityId: product.id, action: "product.update" },
      });
      expect(rows).toHaveLength(1);
      const text = JSON.stringify(rows[0]);
      expect(text).toContain("<p>b</p>");
      expect(text).not.toContain("<script");
      expect(text).not.toContain("onclick");
    });
  });

  it("o salvare care nu schimbă nimic după curățare nu scrie nimic (nici audit)", async () => {
    await withServices(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const { product } = await create(service, manager, "<p>text <strong>aldin</strong></p>");
      const before = await tx.auditLog.count({ where: { entityId: product.id } });
      await service.update(manager, product.id, { description: "<p>text <b>aldin</b></p>" });
      await service.update(manager, product.id, {
        description: '<p style="x">text <b>aldin</b></p>',
      });
      expect(await tx.auditLog.count({ where: { entityId: product.id } })).toBe(before);
    });
  });

  it("o descriere prea lungă e refuzată cu eroare de validare și nu se scrie nimic", async () => {
    await withServices(async ({ tx, service, as }) => {
      const manager = await as("manager");
      const { product } = await create(service, manager, "<p>inițială</p>");
      await expect(
        service.update(manager, product.id, { description: `<p>${"a".repeat(100_000)}</p>` }),
      ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect((await tx.product.findUniqueOrThrow({ where: { id: product.id } })).description).toBe(
        "<p>inițială</p>",
      );
    });
  });
});

describe("duplicarea produsului păstrează descrierea și legăturile media", () => {
  it("copia are aceeași descriere și aceleași legături; fișierul rămâne protejat de ambele produse", async () => {
    await withServices(async ({ tx, service, lifecycle, as }) => {
      const manager = await as("manager");
      const m = await newMedia(tx);
      const { product } = await create(service, manager, `<p>Text</p>${image(m.id, "Poză")}`);
      const result = await lifecycle.duplicate(manager, product.id);
      const copy = await tx.product.findUniqueOrThrow({ where: { id: result.product.id } });
      expect(copy.description).toBe(`<p>Text</p><img alt="Poză" data-media-id="${m.id}" />`);
      expect(await linkedMedia(tx, copy.id)).toEqual([m.id]);
      expect(await linkedMedia(tx, product.id)).toEqual([m.id]);
    });
  });

  it("duplicarea re-sanitizează descrierea sursei (o valoare veche rămasă în bază nu se copiază ca atare)", async () => {
    await withServices(async ({ tx, service, lifecycle, as }) => {
      const manager = await as("manager");
      const { product } = await create(service, manager, "<p>curat</p>");
      // simulăm un rând scris direct în bază, ocolind serviciul
      await tx.$executeRaw`UPDATE "product" SET "description" = ${'<p onclick="alert(1)">vechi</p><script>alert(1)</script>'} WHERE "id" = ${product.id}`;
      const result = await lifecycle.duplicate(manager, product.id);
      const copy = await tx.product.findUniqueOrThrow({ where: { id: result.product.id } });
      expect(copy.description).toBe("<p>vechi</p>");
    });
  });
});
