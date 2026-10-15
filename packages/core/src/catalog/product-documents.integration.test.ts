import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { LocalStorageDriver, deriveSigningKey } from "@ecom/integrations";
import { createLogger } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import { PermissionService } from "../rbac/permission-service";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import {
  DOCUMENT_KEY_PREFIX,
  ProductDocumentsService,
  createPrismaProductDocumentStore,
  sweepOrphanDocuments,
} from "./product-documents";
import { ProductService } from "./product-service";
import { createPrismaProductStore } from "./product-store";

/**
 * Documentele pe baza reală și pe un director local de stocare (temporar): încărcare → rând + fișier,
 * ștergere → fără fișier, înlocuire, CHECK-urile din bază și curățarea orfanilor pe fișiere reale.
 */

const db = getDb();
let root: string;
let storage: LocalStorageDriver;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ecom-docs-"));
  storage = new LocalStorageDriver({
    rootDir: root,
    appUrl: "https://magazin.test",
    signingKey: deriveSigningKey(Buffer.alloc(32, 5).toString("base64")),
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await db.$disconnect();
});

const uid = (): string => randomUUID().slice(0, 8);
const pdf = (): Buffer => Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n");
const exists = async (key: string): Promise<boolean> => (await storage.stat(key)) !== null;

async function withServices<T>(
  fn: (c: {
    tx: TestTx;
    products: ProductService;
    documents: ProductDocumentsService;
    as: (role: string) => ReturnType<PermissionService["loadSubject"]>;
  }) => Promise<T>,
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const audit = new AuditService(createPrismaAuditStore(tx));
    const logger = createLogger({ destination: { write() {} } });
    const products = new ProductService({
      store: createPrismaProductStore(tx),
      audit,
      defaultManageStock: async () => true,
      logger,
    });
    const documents = new ProductDocumentsService({
      store: createPrismaProductDocumentStore(tx),
      storage,
      audit,
      getMaxInputPixels: async () => 40_000_000,
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
    return fn({ tx, products, documents, as });
  });
}

async function newProduct(
  products: ProductService,
  subject: Awaited<ReturnType<PermissionService["loadSubject"]>>,
) {
  return (
    await products.create(subject, {
      title: `Cu documente ${uid()}`,
      variants: [{ sku: `DC-${uid()}`, price: 1000 }],
    })
  ).product;
}

describe("documente de produs pe baza reală", () => {
  it("încărcare: rând + fișier privat; ștergerea scoate ambele; auditul nu conține numele", async () => {
    await withServices(async ({ tx, products, documents, as }) => {
      const manager = await as("manager");
      const editor = await as("editor");
      const product = await newProduct(products, manager);

      const doc = await documents.upload(
        editor,
        product.id,
        { bytes: pdf(), originalName: "Manual de utilizare.pdf" },
        { type: "manual", title: "Manual" },
      );
      const row = await tx.productDocument.findUniqueOrThrow({ where: { id: doc.id } });
      expect(row.storageKey).toMatch(/^private\/product-documents\/[0-9a-f-]{36}\.pdf$/);
      expect(row).toMatchObject({ mime: "application/pdf", type: "manual", language: "ro" });
      expect(await exists(row.storageKey)).toBe(true);

      // nu apare în biblioteca media
      expect(await tx.media.count({ where: { storageKey: row.storageKey } })).toBe(0);

      const audit = await tx.auditLog.findMany({ where: { entityId: product.id } });
      expect(JSON.stringify(audit)).not.toContain("Manual de utilizare");

      await documents.remove(editor, doc.id);
      expect(await tx.productDocument.count({ where: { id: doc.id } })).toBe(0);
      expect(await exists(row.storageKey)).toBe(false);
    });
  });

  it("înlocuirea păstrează rândul și schimbă fișierul; cel vechi dispare", async () => {
    await withServices(async ({ tx, products, documents, as }) => {
      const manager = await as("manager");
      const product = await newProduct(products, manager);
      const doc = await documents.upload(
        manager,
        product.id,
        { bytes: pdf(), originalName: "v1.pdf" },
        { type: "datasheet" },
      );
      const before = await tx.productDocument.findUniqueOrThrow({ where: { id: doc.id } });

      await documents.replace(manager, product.id, doc.id, {
        bytes: Buffer.concat([pdf(), Buffer.from("% v2\n")]),
        originalName: "v2.pdf",
      });
      const after = await tx.productDocument.findUniqueOrThrow({ where: { id: doc.id } });
      expect(after.storageKey).not.toBe(before.storageKey);
      expect(after.originalName).toBe("v2.pdf");
      expect(await exists(after.storageKey)).toBe(true);
      expect(await exists(before.storageKey)).toBe(false);
      await documents.remove(manager, doc.id);
    });
  });

  it("ștergerea produsului scoate rândurile (cascadă); fișierele rămase sunt orfani găsiți de sweep", async () => {
    await withServices(async ({ tx, products, documents, as }) => {
      const manager = await as("manager");
      const product = await newProduct(products, manager);
      const doc = await documents.upload(
        manager,
        product.id,
        { bytes: pdf(), originalName: "x.pdf" },
        { type: "other" },
      );
      const { storageKey } = await tx.productDocument.findUniqueOrThrow({ where: { id: doc.id } });

      await tx.product.delete({ where: { id: product.id } });
      expect(await tx.productDocument.count({ where: { id: doc.id } })).toBe(0);
      expect(await exists(storageKey)).toBe(true); // fișierul a rămas: orfan

      // fișierul e „vechi” (mtime în trecut), deci devine candidat
      const longAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      await utimes(join(root, ...storageKey.split("/")), longAgo, longAgo);

      const store = createPrismaProductDocumentStore(tx);
      const report = await sweepOrphanDocuments({ storage, store });
      expect(report.orphans.map((o) => o.key)).toContain(storageKey);
      expect(await exists(storageKey)).toBe(true); // doar raport

      const applied = await sweepOrphanDocuments({ storage, store, delete: true });
      expect(applied.deleted).toContain(storageKey);
      expect(await exists(storageKey)).toBe(false);
    });
  });

  it("sweep pe fișiere reale: obiectul cu rând nu e raportat, cel din alt prefix nu e atins", async () => {
    await withServices(async ({ tx, products, documents, as }) => {
      const manager = await as("manager");
      const product = await newProduct(products, manager);
      const doc = await documents.upload(
        manager,
        product.id,
        { bytes: pdf(), originalName: "pastrat.pdf" },
        { type: "other" },
      );
      const { storageKey } = await tx.productDocument.findUniqueOrThrow({ where: { id: doc.id } });

      const stray = `public/docs-test-${uid()}/imagine.webp`;
      const privateOther = `private/alt-spatiu-${uid()}/fisier.pdf`;
      const orphan = `${DOCUMENT_KEY_PREFIX}${randomUUID()}.pdf`;
      for (const key of [stray, privateOther, orphan]) {
        await storage.put(key, Buffer.from("x"), { contentType: "application/octet-stream" });
        const old = new Date(Date.now() - 5 * 60 * 60 * 1000);
        await utimes(join(root, ...key.split("/")), old, old);
      }
      const longAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
      await utimes(join(root, ...storageKey.split("/")), longAgo, longAgo);

      const store = createPrismaProductDocumentStore(tx);
      const report = await sweepOrphanDocuments({ storage, store, delete: true });
      const reported = report.orphans.map((o) => o.key);
      expect(reported).toContain(orphan);
      expect(reported).not.toContain(storageKey); // are rând
      expect(reported).not.toContain(stray);
      expect(reported).not.toContain(privateOther);

      expect(await exists(storageKey)).toBe(true);
      expect(await exists(stray)).toBe(true);
      expect(await exists(privateOther)).toBe(true);
      expect(await exists(orphan)).toBe(false);

      await storage.delete(stray);
      await storage.delete(privateOther);
      await documents.remove(manager, doc.id);
      expect((await stat(root)).isDirectory()).toBe(true);
    });
  });

  it("baza respinge un tip de fișier sau o limbă nepermise, chiar ocolind serviciul", async () => {
    for (const data of [
      { mime: "text/html", language: "ro" },
      { mime: "application/pdf", language: "romana" },
    ]) {
      await expect(
        inRolledBackTransaction(db, async (tx) => {
          const product = await tx.product.create({ data: { slug: `chk-${uid()}`, title: "C" } });
          await tx.productDocument.create({
            data: {
              productId: product.id,
              type: "manual",
              title: "t",
              storageKey: `private/product-documents/${randomUUID()}.pdf`,
              originalName: "x.pdf",
              sizeBytes: 10,
              ...data,
            },
          });
        }),
      ).rejects.toThrow(/product_document_(mime|language)_check/);
    }
  });
});
