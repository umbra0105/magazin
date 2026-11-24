import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { workbookBuffer } from "../../../../integrations/src/spreadsheet/test-utils/report-workbook";
import { AuditService } from "../../audit/audit-service";
import { DEFAULT_ROLES } from "../../rbac/catalog";
import type { PermissionSubject } from "../../rbac/can";
import { MemoryAudit } from "../../test-utils/memory-audit";
import { inRolledBackTransaction, type TestTx } from "../../test-utils/rollback";
import { toCsv } from "../import/import-csv";
import { NIR_TEMPLATE_HEADER } from "./nir-report";
import { createPrismaNirStore } from "./nir-store";
import { NirImportService, type NirJobQueue } from "./nir-service";

/**
 * Importul prețurilor NIR pe Postgres real, în tranzacție anulată, cu fișiere SINTETICE (coduri, produse și costuri inventate;
 * fișierul real SmartBill nu intră în teste). Ceasul e injectat, iar datele fișierelor se calculează față de el.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const NOW = new Date("2030-06-15T12:00:00.000Z");
const DAY = 86_400_000;
const uid = (): string => randomUUID().slice(0, 8);

const pad = (n: number) => String(n).padStart(2, "0");
/** `zz/ll/aaaa` pentru ziua aflată cu `ago` zile înainte de NOW. */
const ago = (days: number): string => {
  const d = new Date(NOW.getTime() - days * DAY);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
};
const iso = (days: number): string =>
  new Date(NOW.getTime() - days * DAY).toISOString().slice(0, 10);

function subjectFor(role: string, drop: readonly string[] = []): PermissionSubject {
  const def = DEFAULT_ROLES.find((r) => r.key === role);
  return {
    userId: `staff_${uid()}`,
    email: `${role}@exemplu.test`,
    roles: [role],
    permissions: new Set((def?.permissions ?? []).filter((p) => !drop.includes(p))),
  };
}
const owner = subjectFor("owner");
const manager = subjectFor("manager"); // vede costul, NU îl importă
const importOnly: PermissionSubject = {
  userId: "staff_x",
  email: "import@exemplu.test",
  roles: ["custom"],
  permissions: new Set(["admin.access", "products.cost.import"]),
};
const viewOnly: PermissionSubject = {
  userId: "staff_y",
  email: "view@exemplu.test",
  roles: ["custom"],
  permissions: new Set(["admin.access", "products.cost.view"]),
};

const HEADER = [...NIR_TEMPLATE_HEADER];
interface Line {
  code: string | null;
  date: string;
  qty?: number | string | null;
  cost?: number | string | null;
  unit?: string | null;
  type?: string;
}
const line = (l: Line) => [
  "Depozit",
  "Produs inventat",
  l.code,
  l.date,
  l.type ?? "Receptie",
  "NIR 1",
  l.unit === undefined ? "buc" : l.unit,
  l.qty === undefined ? 5 : l.qty,
  0,
  l.cost === undefined ? 10 : l.cost,
  50,
  0,
];
const aoa = (lines: Line[]): unknown[][] => [
  ["Raport mișcări produse"],
  ["Societate Inventata SRL"],
  [],
  HEADER,
  ...lines.map(line),
  ["Total", null, null, null, null, null, null, 99, 0, null, 999, 0],
];
const xls = (lines: Line[], format: "xls" | "xlsx" = "xls") =>
  new Uint8Array(workbookBuffer([aoa(lines)], format));
const csv = (lines: Line[]) =>
  toCsv([
    HEADER,
    ...lines.map((l) => line(l).map((cell) => (cell === null ? "" : String(cell)))),
    ["Total", "", "", "", "", "", "", "99", "0", "", "999", "0"],
  ]);

async function variant(tx: TestTx, sku: string, over: Record<string, unknown> = {}) {
  const product = await tx.product.create({
    data: { slug: `nir-${uid()}`, title: "Produs NIR", status: "active" },
  });
  return tx.productVariant.create({
    data: { productId: product.id, sku, price: 20_000, ...over } as never,
  });
}

/** Conturile din subiecte există în bază (importul le păstrează ca autor, cu cheie străină). */
const STAFF = [owner, manager, importOnly, viewOnly];

async function world(tx: TestTx, queue?: NirJobQueue) {
  await tx.user.createMany({
    data: STAFF.map((subject) => ({
      id: subject.userId,
      name: subject.email,
      email: subject.email,
    })),
    skipDuplicates: true,
  });
  const memory = new MemoryAudit();
  const service = new NirImportService({
    store: createPrismaNirStore(tx),
    audit: new AuditService(memory),
    ...(queue ? { queue } : {}),
    now: () => NOW,
  });
  return { service, memory };
}

const costOf = async (tx: TestTx, variantId: string) =>
  tx.productVariant.findUniqueOrThrow({
    where: { id: variantId },
    select: { costPrice: true, costPriceDate: true },
  });
const history = (tx: TestTx, variantId: string) =>
  tx.costPriceHistory.findMany({ where: { variantId }, orderBy: { createdAt: "asc" } });

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? "fără cod";
  }
  return "nicio eroare";
};

describe("previzualizarea (dry-run) nu scrie nimic în catalog", () => {
  it("cifrele din raport, fără nicio modificare de cost sau de istoric", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await variant(tx, `A-${uid()}`);
      const b = await variant(tx, `B-${uid()}`);
      const { service } = await world(tx);
      const view = await service.preview(owner, {
        name: "miscari.xls",
        bytes: xls([
          { code: a.sku, date: ago(3), cost: 12.3456 },
          { code: b.sku, date: ago(2), cost: "49,99" },
          { code: "NU-EXISTA", date: ago(1) },
          { code: a.sku, date: ago(9), qty: -2 },
        ]),
      });
      expect(view.status).toBe("previewed");
      expect(view.report.counters).toMatchObject({
        updated: 2,
        unchanged: 0,
        unknownCodes: 1,
        ignored: 1,
        invalid: 0,
        fileRows: 4,
      });
      expect(await costOf(tx, a.id)).toEqual({ costPrice: null, costPriceDate: null });
      expect(await history(tx, a.id)).toEqual([]);
      expect(await history(tx, b.id)).toEqual([]);
    });
  });
});

describe("confirmarea aplică exact ce a arătat previzualizarea", () => {
  it("costul în bani (rotunjit o singură dată), data intrării și un rând de istoric pe variantă", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await variant(tx, `A-${uid()}`);
      const b = await variant(tx, `B-${uid()}`);
      const { service, memory } = await world(tx);
      const preview = await service.preview(owner, {
        name: "m.xls",
        bytes: xls([
          { code: a.sku, date: ago(3), cost: 12.3456 }, // 1234,56 bani → 1235
          { code: b.sku, date: ago(2), cost: "123,4550" }, // 12345,5 → 12346
        ]),
      });
      const done = await service.confirm(owner, preview.id);
      expect(done.status).toBe("completed");
      expect(done.processedItems).toBe(2);
      expect(await costOf(tx, a.id)).toEqual({
        costPrice: 1235,
        costPriceDate: new Date(`${iso(3)}T00:00:00.000Z`),
      });
      expect((await costOf(tx, b.id)).costPrice).toBe(12_346);
      const rows = await history(tx, a.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ costPrice: 1235, source: "import", importId: preview.id });
      // auditul: doar identificatori și numere, fără costuri și fără coduri
      const dump = JSON.stringify(memory.rows);
      expect(dump).not.toContain(a.sku);
      expect(dump).not.toMatch(/1235|12346|12\.3456/);
      expect(memory.rows.filter((r) => r.action === "product.cost.import")).toHaveLength(2);
    });
  });

  it("același fișier a doua oară: totul «neschimbat», zero rânduri noi de istoric", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await variant(tx, `A-${uid()}`);
      const { service } = await world(tx);
      const bytes = xls([{ code: a.sku, date: ago(3), cost: 10 }]);
      await service.confirm(owner, (await service.preview(owner, { name: "m.xls", bytes })).id);
      const before = await history(tx, a.id);
      const again = await service.preview(owner, { name: "m.xls", bytes });
      expect(again.report.counters).toMatchObject({ updated: 0, unchanged: 1 });
      const second = await service.confirm(owner, again.id);
      expect(second.status).toBe("completed");
      expect(second.report.counters).toMatchObject({ updated: 0, unchanged: 1 });
      expect(await history(tx, a.id)).toHaveLength(before.length);
      expect(before).toHaveLength(1);
    });
  });

  it("data mai veche sau egală: neschimbat, chiar dacă valoarea diferă; mai nouă: se actualizează, chiar dacă prețul scade", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await variant(tx, `A-${uid()}`, {
        costPrice: 5_000,
        costPriceDate: new Date(`${iso(5)}T00:00:00.000Z`),
      });
      const { service } = await world(tx);
      const run = async (lines: Line[]) =>
        service.confirm(
          owner,
          (await service.preview(owner, { name: "m.xls", bytes: xls(lines) })).id,
        );

      await run([{ code: a.sku, date: ago(8), cost: 99 }]); // mai veche
      expect((await costOf(tx, a.id)).costPrice).toBe(5_000);
      await run([{ code: a.sku, date: ago(5), cost: 99 }]); // aceeași zi
      expect((await costOf(tx, a.id)).costPrice).toBe(5_000);
      expect(await history(tx, a.id)).toEqual([]);

      await run([{ code: a.sku, date: ago(1), cost: 20 }]); // mai nouă și mai ieftin: se actualizează (nu se păstrează maximul)
      expect(await costOf(tx, a.id)).toEqual({
        costPrice: 2_000,
        costPriceDate: new Date(`${iso(1)}T00:00:00.000Z`),
      });
      expect(await history(tx, a.id)).toHaveLength(1);
    });
  });

  it("mai multe intrări pe același cod: câștigă data cea mai recentă; la aceeași zi, ultimul rând", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await variant(tx, `A-${uid()}`);
      const { service } = await world(tx);
      const preview = await service.preview(owner, {
        name: "m.xls",
        bytes: xls([
          { code: a.sku, date: ago(6), cost: 10 },
          { code: a.sku, date: ago(2), cost: 30 },
          { code: a.sku, date: ago(2), cost: 31 },
          { code: a.sku, date: ago(4), cost: 20 },
        ]),
      });
      expect(preview.report.counters.multiSameDay).toBe(1);
      await service.confirm(owner, preview.id);
      expect((await costOf(tx, a.id)).costPrice).toBe(3_100);
      expect(await history(tx, a.id)).toHaveLength(1);
    });
  });
});

describe("raportul: categoriile cerute", () => {
  it("coduri necunoscute, rânduri invalide (cu numărul rândului), ignorate, unitate diferită, intrări multiple, alte documente", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const ok = await variant(tx, `OK-${uid()}`);
      const steps = await variant(tx, `ST-${uid()}`, { smartbillMode: "steps" });
      const kg = await variant(tx, `KG-${uid()}`);
      const { service } = await world(tx);
      const view = await service.preview(owner, {
        name: "m.xlsx",
        bytes: xls(
          [
            { code: ok.sku, date: ago(2), cost: 10, type: "Transfer intrare" },
            { code: ok.sku, date: ago(2), cost: 11 },
            { code: "FANTOMA", date: ago(2) },
            { code: ok.sku, date: "2/2/2030", cost: 10 },
            { code: ok.sku, date: ago(2), cost: 0 },
            { code: ok.sku, date: ago(2), qty: 0 },
            { code: steps.sku, date: ago(2) },
            { code: kg.sku, date: ago(2), unit: "kg" },
          ],
          "xlsx",
        ),
      });
      const c = view.report.counters;
      expect(c).toMatchObject({
        fileRows: 8,
        unknownCodes: 1,
        invalid: 2,
        ignored: 1,
        unitDifferent: 2,
        matchedCodes: 1,
        updated: 1,
        multiSameDay: 1,
      });
      expect(view.report.invalid.map((r) => r.reason)).toEqual([
        expect.stringContaining("data nu e validă"),
        "preț prea mic sau invalid",
      ]);
      expect(view.report.invalid.every((r) => r.row > 0)).toBe(true);
      expect(view.report.otherDocTypes).toEqual([{ type: "Transfer intrare", count: 1 }]);
      expect(view.report.updated[0]).toMatchObject({ costMinor: 1100 });
    });
  });

  it("CSV (UTF-16LE cu TAB, formatul aplicației) dă același rezultat ca .xls și .xlsx", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await variant(tx, `A-${uid()}`);
      const lines: Line[] = [
        { code: a.sku, date: ago(3), cost: "12.3456" },
        { code: "NU-EXISTA", date: ago(1), cost: "5" },
      ];
      const { service } = await world(tx);
      const counters = [];
      for (const bytes of [csv(lines), xls(lines, "xls"), xls(lines, "xlsx")]) {
        counters.push((await service.preview(owner, { name: "m", bytes })).report.counters);
      }
      expect(counters[0]).toEqual(counters[1]);
      expect(counters[1]).toEqual(counters[2]);
      expect(counters[0]).toMatchObject({ updated: 1, unknownCodes: 1 });
    });
  });

  it("CSV UTF-8 cu «;» și virgulă zecimală, salvat din Excel", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await variant(tx, `A-${uid()}`);
      const text =
        `${HEADER.join(";")}\r\n` +
        `Depozit;Produs;${a.sku};${ago(2)};Receptie;NIR 7;buc;3;0;"12,3456";10;0\r\n` +
        `Total;;;;;;;3;0;;10;0\r\n`;
      const { service } = await world(tx);
      const view = await service.preview(owner, {
        name: "m.csv",
        bytes: new TextEncoder().encode(text),
      });
      expect(view.report.counters).toMatchObject({ updated: 1, invalid: 0, totalRows: 1 });
      expect(view.report.updated[0]?.costMinor).toBe(1235);
    });
  });
});

describe("permisiuni (verificate pe server)", () => {
  it("fără products.cost.import nu se încarcă și nu se confirmă, nici cu products.cost.view; fără view nu se încarcă nici cu import", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await variant(tx, `A-${uid()}`);
      const { service } = await world(tx);
      const file = { name: "m.xls", bytes: xls([{ code: a.sku, date: ago(3) }]) };
      expect(await codeOf(service.preview(manager, file))).toBe("AUTH_FORBIDDEN");
      expect(await codeOf(service.preview(viewOnly, file))).toBe("AUTH_FORBIDDEN");
      expect(await codeOf(service.preview(importOnly, file))).toBe("AUTH_FORBIDDEN");
      expect(await codeOf(service.preview(null, file))).toBe("AUTH_UNAUTHENTICATED");
      const view = await service.preview(owner, file);
      expect(await codeOf(service.confirm(manager, view.id))).toBe("AUTH_FORBIDDEN");
      expect(await codeOf(service.confirm(importOnly, view.id))).toBe("AUTH_FORBIDDEN");
      expect((await tx.nirImport.findUniqueOrThrow({ where: { id: view.id } })).status).toBe(
        "previewed",
      );
      expect(await costOf(tx, a.id)).toEqual({ costPrice: null, costPriceDate: null });
    });
  });

  it("raportul, lista și șablonul cer products.cost.view (managerul le are, rolul fără cost nu)", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await variant(tx, `A-${uid()}`);
      const { service } = await world(tx);
      const view = await service.preview(owner, {
        name: "m.xls",
        bytes: xls([{ code: a.sku, date: ago(3) }]),
      });
      for (const denied of [
        importOnly,
        subjectFor("editor"),
        subjectFor("warehouse"),
        subjectFor("support"),
      ]) {
        expect(await codeOf(service.reportRows(denied, view.id))).toBe("AUTH_FORBIDDEN");
        expect(await codeOf(service.get(denied, view.id))).toBe("AUTH_FORBIDDEN");
        expect(await codeOf(service.list(denied))).toBe("AUTH_FORBIDDEN");
        expect(() => service.templateRows(denied)).toThrowError(
          expect.objectContaining({ code: "AUTH_FORBIDDEN" }),
        );
      }
      expect((await service.reportRows(manager, view.id)).length).toBeGreaterThan(1);
      expect(service.templateRows(manager)[0]).toEqual([...NIR_TEMPLATE_HEADER]);
      expect((await service.list(subjectFor("accountant"))).map((r) => r.id)).toContain(view.id);
    });
  });
});

describe("ciclul de viață al importului", () => {
  it("o previzualizare expirată nu se mai confirmă; una confirmată nu se confirmă a doua oară", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await variant(tx, `A-${uid()}`);
      const { service } = await world(tx);
      const view = await service.preview(owner, {
        name: "m.xls",
        bytes: xls([{ code: a.sku, date: ago(3) }]),
      });
      await tx.nirImport.update({
        where: { id: view.id },
        data: { expiresAt: new Date(NOW.getTime() - 1) },
      });
      expect(await codeOf(service.confirm(owner, view.id))).toBe("NIR_IMPORT_EXPIRED");

      const fresh = await service.preview(owner, {
        name: "m.xls",
        bytes: xls([{ code: a.sku, date: ago(3) }]),
      });
      await service.confirm(owner, fresh.id);
      expect(await codeOf(service.confirm(owner, fresh.id))).toBe("NIR_IMPORT_STATE");
      expect(await codeOf(service.confirm(owner, "nu-exista"))).toBe("NIR_IMPORT_NOT_FOUND");
      expect(await history(tx, a.id)).toHaveLength(1);
    });
  });

  it("cu coadă: confirmarea pune importul în coadă (nu aplică pe loc), iar jobul îl aplică o singură dată", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await variant(tx, `A-${uid()}`);
      const queued: string[] = [];
      const { service } = await world(tx, { enqueue: async (id) => void queued.push(id) });
      const view = await service.preview(owner, {
        name: "m.xls",
        bytes: xls([{ code: a.sku, date: ago(3), cost: 10 }]),
      });
      const after = await service.confirm(owner, view.id);
      expect(after.status).toBe("queued");
      expect(queued).toEqual([view.id]);
      expect(await costOf(tx, a.id)).toEqual({ costPrice: null, costPriceDate: null });
      await service.runQueued(view.id);
      await service.runQueued(view.id); // al doilea apel nu face nimic
      expect((await costOf(tx, a.id)).costPrice).toBe(1_000);
      expect(await history(tx, a.id)).toHaveLength(1);
      expect((await service.get(owner, view.id)).status).toBe("completed");
    });
  });

  it("coada indisponibilă: importul devine «eșuat», nu rămâne blocat, și nu s-a aplicat nimic", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const a = await variant(tx, `A-${uid()}`);
      const { service } = await world(tx, {
        enqueue: async () => Promise.reject(new Error("redis jos")),
      });
      const view = await service.preview(owner, {
        name: "m.xls",
        bytes: xls([{ code: a.sku, date: ago(3) }]),
      });
      expect(await codeOf(service.confirm(owner, view.id))).toBe("NIR_IMPORT_QUEUE_UNAVAILABLE");
      const stored = await service.get(owner, view.id);
      expect(stored.status).toBe("failed");
      expect(stored.errorMessage).not.toContain("redis");
      expect(await costOf(tx, a.id)).toEqual({ costPrice: null, costPriceDate: null });
    });
  });
});

describe("fișiere greșite", () => {
  it.each([
    ["gol", new Uint8Array(0), "NIR_FILE_EMPTY"],
    [
      "text fără antet",
      new TextEncoder().encode("alt fișier\nfără antet\n"),
      "NIR_FILE_HEADER_NOT_FOUND",
    ],
    [
      "antet fără coloana de cost",
      new TextEncoder().encode(
        "Gestiune;Produs;Cod;Data;U.M.;Intrari\r\nD;P;C;01/01/2030;buc;1\r\n",
      ),
      "NIR_FILE_COLUMNS_MISSING",
    ],
    ["binar necunoscut", new Uint8Array([1, 2, 3, 0, 4, 5]), "NIR_FILE_HEADER_NOT_FOUND"],
  ])("%s", async (_label, bytes, code) => {
    await inRolledBackTransaction(db, async (tx) => {
      const { service } = await world(tx);
      expect(await codeOf(service.preview(owner, { name: "m", bytes }))).toBe(code);
    });
  });

  it("un .xlsx stricat se refuză cu mesaj, fără a scrie nimic", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { service } = await world(tx);
      const bad = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
      expect(await codeOf(service.preview(owner, { name: "m.xlsx", bytes: bad }))).toBe(
        "NIR_FILE_UNREADABLE",
      );
      expect(await tx.nirImport.count()).toBe(0);
    });
  });
});
