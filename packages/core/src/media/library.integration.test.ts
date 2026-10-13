import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { LocalStorageDriver, deriveSigningKey } from "@ecom/integrations";
import { AuditService } from "../audit/audit-service";
import { createPrismaAuditStore } from "../audit/prisma-store";
import type { PermissionSubject } from "../rbac/can";
import { PermissionService } from "../rbac/permission-service";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { MediaInUseError, MediaLibraryError, MediaLibraryService } from "./library";
import { createPrismaLibraryStore } from "./library-store";
import { createPrismaProcessingStore } from "./processing-store";
import { MediaUsageRegistry } from "./usage";

const db = getDb();
let base: string;
let storage: LocalStorageDriver;

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "ecom-library-"));
  storage = new LocalStorageDriver({
    rootDir: join(base, "s"),
    appUrl: "https://magazin.test",
    signingKey: deriveSigningKey(Buffer.alloc(32, 6).toString("base64")),
  });
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
  await db.$disconnect();
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

interface Ctx {
  tx: TestTx;
  service: MediaLibraryService;
  usage: MediaUsageRegistry;
  queued: string[];
  as: (role: string) => Promise<PermissionSubject>;
  media: (
    over?: Partial<{
      name: string;
      alt: string;
      tags: string[];
      status: string;
      folderId: string | null;
      variants: boolean;
    }>,
  ) => Promise<string>;
}

async function withLibrary<T>(fn: (c: Ctx) => Promise<T>): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const usage = new MediaUsageRegistry();
    const queued: string[] = [];
    const service = new MediaLibraryService({
      store: createPrismaLibraryStore(tx),
      storage,
      audit: new AuditService(createPrismaAuditStore(tx)),
      usage,
      processing: createPrismaProcessingStore(tx),
      queue: { enqueueProcess: async (id) => void queued.push(id) },
    });
    let n = 0;
    const as = async (role: string): Promise<PermissionSubject> => {
      const user = await tx.user.create({
        data: { id: `lib-${role}-${n++}`, name: role, email: `lib-${role}-${n}@test.invalid` },
      });
      const found = await tx.role.findUniqueOrThrow({ where: { key: role } });
      await tx.userRole.create({ data: { userId: user.id, roleId: found.id } });
      const subject = await new PermissionService(tx).loadSubject(user.id);
      if (!subject) throw new Error("subject lipsă");
      return subject;
    };
    const media: Ctx["media"] = async (over = {}) => {
      const dir = `public/media/lib-${n++}-${Math.random().toString(16).slice(2, 8)}`;
      const original = `${dir}/original.jpg`;
      await storage.put(original, JPEG, { contentType: "image/jpeg" });
      const variants = over.variants
        ? await Promise.all(
            ["thumb.aa11bb22.webp", "thumb.cc33dd44.avif", "large.ee55ff66.webp"].map(async (f) => {
              const key = `${dir}/${f}`;
              await storage.put(key, JPEG, { contentType: "image/webp" });
              const [name, , format] = f.split(".");
              return {
                name,
                format: format === "webp" ? "webp" : "avif",
                mime: `image/${format}`,
                key,
                width: name === "thumb" ? 320 : 1600,
                height: name === "thumb" ? 160 : 800,
                sizeBytes: 7,
              };
            }),
          )
        : [];
      const row = await tx.media.create({
        data: {
          mime: "image/jpeg",
          sizeBytes: 100,
          width: 1600,
          height: 800,
          checksum: "c".repeat(64),
          originalName: over.name ?? "poza.jpg",
          alt: over.alt ?? "",
          tags: over.tags ?? [],
          status: over.status ?? "ready",
          folderId: over.folderId ?? null,
          storageKey: original,
          variants,
          blurhash: variants.length ? "LEHV6nWB2yk8pyo0adR*.7kCMdnj" : null,
        },
      });
      return row.id;
    };
    return fn({ tx, service, usage, queued, as, media });
  });
}

describe("biblioteca media: citire", () => {
  it("listează paginat, cu thumb (nu originalul) și placeholder; cele mai noi primele", async () => {
    await withLibrary(async ({ service, as, media }) => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push(await media({ name: `f${i}.jpg`, variants: true }));
      const reader = await as("warehouse");

      const first = await service.list(reader, { pageSize: 2 });
      expect(first).toMatchObject({ total: 5, page: 1, pageSize: 2, pageCount: 3 });
      expect(first.items).toHaveLength(2);
      const last = await service.list(reader, { pageSize: 2, page: 3 });
      expect(last.items).toHaveLength(1);
      // pagină în afara intervalului → ultima pagină validă
      expect((await service.list(reader, { pageSize: 2, page: 99 })).page).toBe(3);

      const item = first.items[0]!;
      expect(item.thumb).toMatchObject({ width: 320, height: 160 });
      expect(item.thumb?.url).toMatch(/\/media\/media\/lib-.*\/thumb\.aa11bb22\.webp$/); // WebP preferat
      expect(item.thumb?.url).not.toContain("original");
      expect(item.placeholder).toMatch(/^data:image\/png;base64,/);
      // nimic din storage nu se scurge în browser
      expect(JSON.stringify(first)).not.toContain("storageKey");
      expect(JSON.stringify(first)).not.toContain("public/media");
    });
  });

  it("fără variante (încă pending): thumb nul, fără erori", async () => {
    await withLibrary(async ({ service, as, media }) => {
      await media({ status: "pending" });
      const { items } = await service.list(await as("manager"));
      expect(items[0]?.thumb).toBeNull();
      expect(items[0]?.placeholder).toBeNull();
    });
  });

  it("caută după nume, alt și tag (insensibil la majuscule la nume/alt, exact la tag)", async () => {
    await withLibrary(async ({ service, as, media }) => {
      const a = await media({ name: "Pompa-Căldură.jpg" });
      const b = await media({ name: "x.jpg", alt: "Liner albastru pentru piscină" });
      const c = await media({ name: "y.jpg", tags: ["filtru nisip", "promo"] });
      const reader = await as("manager");
      const ids = async (q: string) => (await service.list(reader, { q })).items.map((i) => i.id);

      expect(await ids("pompa-căldură")).toEqual([a]);
      expect(await ids("ALBASTRU")).toEqual([b]);
      expect(await ids("Promo")).toEqual([c]);
      expect(await ids("filtru nisip")).toEqual([c]);
      expect(await ids("nimic-de-gasit")).toEqual([]);
    });
  });

  it("filtrează după folder (inclusiv „fără folder”) și după status", async () => {
    await withLibrary(async ({ service, as, media, tx }) => {
      const folder = await tx.mediaFolder.create({ data: { name: "Piscine" } });
      const inFolder = await media({ folderId: folder.id });
      const root = await media({ status: "failed" });
      const reader = await as("warehouse");

      expect((await service.list(reader, { folder: folder.id })).items.map((i) => i.id)).toEqual([
        inFolder,
      ]);
      expect((await service.list(reader, { folder: "root" })).items.map((i) => i.id)).toEqual([
        root,
      ]);
      expect((await service.list(reader, { status: "failed" })).items.map((i) => i.id)).toEqual([
        root,
      ]);
      expect((await service.list(reader, { folder: folder.id, status: "failed" })).items).toEqual(
        [],
      );
    });
  });

  it("statuses întoarce doar ce se cere", async () => {
    await withLibrary(async ({ service, as, media }) => {
      const a = await media({ status: "processing" });
      await media();
      const out = await service.statuses(await as("manager"), [a]);
      expect(out.map((i) => i.id)).toEqual([a]);
      expect(out[0]?.status).toBe("processing");
    });
  });
});

describe("biblioteca media: permisiuni (și în core, nu doar în acțiuni)", () => {
  it("Manager și Depozit (doar media.read) citesc, dar orice scriere e refuzată; Editor poate", async () => {
    await withLibrary(async ({ service, as, media }) => {
      const id = await media({ variants: true });
      for (const role of ["manager", "warehouse"]) {
        const s = await as(role);
        expect((await service.list(s)).total).toBe(1);
        await expect(service.update(s, id, { alt: "x" })).rejects.toMatchObject({
          code: "AUTH_FORBIDDEN",
        });
        await expect(service.delete(s, id)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
        await expect(service.regenerate(s, id)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
        await expect(service.createFolder(s, "F", null)).rejects.toMatchObject({
          code: "AUTH_FORBIDDEN",
        });
      }
      const editor = await as("editor");
      await expect(service.update(editor, id, { alt: "ok" })).resolves.toMatchObject({ alt: "ok" });
    });
  });

  it("Suport și Contabil (fără media.read) nu pot nici să citească", async () => {
    await withLibrary(async ({ service, as }) => {
      for (const role of ["support", "accountant"]) {
        const s = await as(role);
        await expect(service.list(s)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
        await expect(service.folders(s)).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
        await expect(service.statuses(s, ["x"])).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
      }
    });
  });
});

describe("biblioteca media: editare", () => {
  it("alt și taguri normalizate, mutare în folder, audit cu diferențele", async () => {
    await withLibrary(async ({ service, as, media, tx }) => {
      const folder = await tx.mediaFolder.create({ data: { name: "Poze" } });
      const id = await media({ alt: "vechi", tags: ["a"] });
      const editor = await as("editor");

      const out = await service.update(editor, id, {
        alt: "  Pompă   de căldură  ",
        tags: [" Piscină ", "piscină", "PROMO"],
        folderId: folder.id,
      });
      expect(out.alt).toBe("Pompă de căldură");
      expect(out.tags).toEqual(["piscină", "promo"]);
      expect(out.folderId).toBe(folder.id);

      const rows = await tx.auditLog.findMany({ where: { action: "media.update", entityId: id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ outcome: "success", actorId: editor.userId });
      expect(rows[0]?.before).toMatchObject({ alt: "vechi", tags: ["a"], folderId: null });
      expect(rows[0]?.after).toMatchObject({ alt: "Pompă de căldură", folderId: folder.id });
    });
  });

  it("o salvare fără schimbări nu scrie în audit; valori invalide sunt respinse", async () => {
    await withLibrary(async ({ service, as, media, tx }) => {
      const id = await media({ alt: "la fel", tags: ["x"] });
      const editor = await as("editor");
      await service.update(editor, id, { alt: "la fel", tags: ["x"] });
      expect(await tx.auditLog.count({ where: { action: "media.update", entityId: id } })).toBe(0);

      await expect(service.update(editor, id, { alt: "a".repeat(301) })).rejects.toThrow();
      await expect(service.update(editor, id, { tags: ["<script>"] })).rejects.toThrow();
      await expect(
        service.update(editor, id, { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) }),
      ).rejects.toThrow();
      await expect(service.update(editor, id, { folderId: "nu-exista" })).rejects.toMatchObject({
        code: "FOLDER_NOT_FOUND",
      });
      await expect(service.update(editor, "nu-exista", { alt: "x" })).rejects.toMatchObject({
        code: "MEDIA_NOT_FOUND",
      });
    });
  });
});

describe("biblioteca media: ștergere", () => {
  it("refuză cu lista locurilor dacă e folosit, fără să șteargă nimic", async () => {
    await withLibrary(async ({ service, as, media, usage, tx }) => {
      const id = await media({ variants: true });
      usage.register({
        name: "produse-test",
        findUsages: async (ids) =>
          new Map(
            ids.map((i) => [
              i,
              [{ kind: "product", label: "Pompă 12 kW", href: "/admin/produse/1" }],
            ]),
          ),
      });
      const editor = await as("editor");

      const error = await service.delete(editor, id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MediaInUseError);
      expect((error as MediaInUseError).usages).toEqual([
        { kind: "product", label: "Pompă 12 kW", href: "/admin/produse/1" },
      ]);
      expect(await tx.media.count({ where: { id } })).toBe(1);
      const row = await tx.media.findUniqueOrThrow({ where: { id } });
      expect(await storage.stat(row.storageKey)).not.toBeNull();
      expect(await tx.auditLog.count({ where: { action: "media.delete", entityId: id } })).toBe(0);
    });
  });

  it("nefolosit: șterge rândul și TOATE obiectele (original + variante), cu audit", async () => {
    await withLibrary(async ({ service, as, media, tx }) => {
      const id = await media({ variants: true });
      const row = await tx.media.findUniqueOrThrow({ where: { id } });
      const keys = [
        row.storageKey,
        ...(row.variants as unknown as { key: string }[]).map((v) => v.key),
      ];
      expect(keys).toHaveLength(4);
      for (const k of keys) expect(await storage.stat(k)).not.toBeNull();

      const editor = await as("editor");
      await service.delete(editor, id);

      expect(await tx.media.count({ where: { id } })).toBe(0);
      for (const k of keys) expect(await storage.stat(k)).toBeNull();
      const audit = await tx.auditLog.findMany({ where: { action: "media.delete", entityId: id } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ outcome: "success", actorId: editor.userId });
      expect(JSON.stringify(audit[0])).not.toContain("poza.jpg");
    });
  });

  it("un provider căzut face ștergerea să eșueze (nu șterge pe nevăzute)", async () => {
    await withLibrary(async ({ service, as, media, usage, tx }) => {
      const id = await media();
      usage.register({
        name: "cazut",
        findUsages: async () => {
          throw new Error("provider căzut");
        },
      });
      await expect(service.delete(await as("editor"), id)).rejects.toThrow("provider căzut");
      expect(await tx.media.count({ where: { id } })).toBe(1);
    });
  });

  it("regenerarea pune fișierul pending și îl trimite în coadă, cu audit", async () => {
    await withLibrary(async ({ service, as, media, tx, queued }) => {
      const id = await media({ status: "failed" });
      await tx.media.update({ where: { id }, data: { processingError: "IMAGE_CORRUPT" } });
      await service.regenerate(await as("editor"), id);
      const row = await tx.media.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({ status: "pending", processingError: null });
      expect(queued).toEqual([id]);
      expect(await tx.auditLog.count({ where: { action: "media.regenerate", entityId: id } })).toBe(
        1,
      );
    });
  });
});

describe("biblioteca media: foldere", () => {
  it("creare, redenumire, mutare, cu audit și nume unic în același părinte", async () => {
    await withLibrary(async ({ service, as }) => {
      const editor = await as("editor");
      const a = await service.createFolder(editor, "  Produse ", null);
      expect(a.name).toBe("Produse");
      const b = await service.createFolder(editor, "Pompe", a.id);
      expect(b.parentId).toBe(a.id);

      await expect(service.createFolder(editor, "produse", null)).rejects.toMatchObject({
        code: "FOLDER_NAME_TAKEN",
      });
    });
    // un nume duplicat strică tranzacția: restul în teste separate
    await withLibrary(async ({ service, as, tx }) => {
      const editor = await as("editor");
      const a = await service.createFolder(editor, "A", null);
      const renamed = await service.renameFolder(editor, a.id, "Piscine");
      expect(renamed.name).toBe("Piscine");
      const b = await service.createFolder(editor, "B", null);
      const moved = await service.moveFolder(editor, b.id, a.id);
      expect(moved.parentId).toBe(a.id);
      const back = await service.moveFolder(editor, b.id, null);
      expect(back.parentId).toBeNull();
      const actions = (
        await tx.auditLog.findMany({
          where: { entity: "media_folder", entityId: { in: [a.id, b.id] } },
        })
      ).map((r) => r.action);
      expect(actions.sort()).toEqual(
        [
          "media_folder.create",
          "media_folder.create",
          "media_folder.move",
          "media_folder.move",
          "media_folder.rename",
        ].sort(),
      );
    });
  });

  it("nu permite cicluri și adâncime peste 5", async () => {
    await withLibrary(async ({ service, as }) => {
      const editor = await as("editor");
      const a = await service.createFolder(editor, "A", null);
      const b = await service.createFolder(editor, "B", a.id);
      const c = await service.createFolder(editor, "C", b.id);

      await expect(service.moveFolder(editor, a.id, a.id)).rejects.toMatchObject({
        code: "FOLDER_CYCLE",
      });
      await expect(service.moveFolder(editor, a.id, c.id)).rejects.toMatchObject({
        code: "FOLDER_CYCLE",
      });

      const d = await service.createFolder(editor, "D", c.id);
      const e = await service.createFolder(editor, "E", d.id); // nivel 5
      await expect(service.createFolder(editor, "F", e.id)).rejects.toMatchObject({
        code: "FOLDER_TOO_DEEP",
      });
      // mutarea unui subarbore adânc peste limită
      const x = await service.createFolder(editor, "X", null);
      await expect(service.moveFolder(editor, a.id, x.id)).rejects.toMatchObject({
        code: "FOLDER_TOO_DEEP",
      });
    });
  });

  it("numele invalide sunt respinse și folderele inexistente dau FOLDER_NOT_FOUND", async () => {
    await withLibrary(async ({ service, as }) => {
      const editor = await as("editor");
      await expect(service.createFolder(editor, "   ", null)).rejects.toThrow();
      await expect(service.createFolder(editor, "a/b", null)).rejects.toThrow();
      await expect(service.createFolder(editor, "x".repeat(61), null)).rejects.toThrow();
      await expect(service.createFolder(editor, "ok", "nu-exista")).rejects.toBeInstanceOf(
        MediaLibraryError,
      );
      await expect(service.renameFolder(editor, "nu-exista", "x")).rejects.toMatchObject({
        code: "FOLDER_NOT_FOUND",
      });
    });
  });
});
