import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { parseQuantity, ValidationError } from "@ecom/shared";
import { runBaseSeed } from "../seed/base-seed";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import {
  addStockProduct,
  createStockContext,
  type ProductSpec,
  type StockContext,
} from "../test-utils/stock-fixtures";
import { BackInStockError, BackInStockService, type BackInStockSettings } from "./back-in-stock";

/**
 * Faza 5, punctul 11a: «Anunță-mă când revine în stoc», partea de server. Logica deterministă rulează pe baza reală în
 * tranzacție anulată; cererile simultane sunt în `back-in-stock-concurrency.integration.test.ts`.
 * Testul nu presupune seed: depozitul implicit îl creează `runBaseSeed`, restul testul.
 */
const db = getDb();

afterAll(async () => {
  await db.$disconnect();
});

const DEFAULTS: BackInStockSettings = {
  lowStockSteps: 2,
  defaultLeadTimeDays: 14,
  maxPerEmail: 3,
  maxPerVariant: 4,
};

interface Harness {
  tx: TestTx;
  ctx: StockContext;
  service: BackInStockService;
  /** Un produs ACTIV cu o singură variantă */
  variant: (spec?: ProductSpec) => Promise<string>;
  rows: (variantId: string) => Promise<Array<{ email: string; notifiedAt: Date | null }>>;
  setPhysical: (variantId: string, quantity: string) => Promise<void>;
}

async function withService<T>(
  fn: (h: Harness) => Promise<T>,
  settings: Partial<BackInStockSettings> = {},
): Promise<T> {
  return inRolledBackTransaction(db, async (tx) => {
    await runBaseSeed(tx);
    const ctx = await createStockContext(tx, { useDefaultWarehouse: true });
    const current = { ...DEFAULTS, ...settings };
    const service = new BackInStockService({ db: tx, readSettings: async () => current });
    const h: Harness = {
      tx,
      ctx,
      service,
      variant: async (spec = {}) => {
        const created = await addStockProduct(tx, ctx, {
          status: "active",
          variants: [{ physical: "0" }],
          ...spec,
        });
        return created.variants[0]!.id;
      },
      rows: async (variantId) =>
        tx.backInStockAlert.findMany({
          where: { variantId },
          orderBy: { createdAt: "asc" },
          select: { email: true, notifiedAt: true },
        }),
      setPhysical: async (variantId, quantity) => {
        await tx.inventoryItem.update({
          where: { variantId_warehouseId: { variantId, warehouseId: ctx.warehouseId } },
          data: { physical: parseQuantity(quantity) },
        });
      },
    };
    return fn(h);
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? "fără cod";
  }
  return "nicio eroare";
}

describe("cererea «Anunță-mă»", () => {
  it("o variantă gestionată epuizată: cererea se înregistrează, cu adresa normalizată", async () => {
    await withService(async (h) => {
      const id = await h.variant();
      expect(await h.service.subscribe({ variantId: id, email: "  Client@Exemplu.RO " })).toEqual({
        status: "registered",
      });
      expect(await h.rows(id)).toEqual([{ email: "client@exemplu.ro", notifiedAt: null }]);
    });
  });

  it("aceeași cerere de două ori (și cu alte majuscule): același răspuns, un singur rând", async () => {
    await withService(async (h) => {
      const id = await h.variant();
      const first = await h.service.subscribe({ variantId: id, email: "ana@exemplu.ro" });
      const second = await h.service.subscribe({ variantId: id, email: "ANA@Exemplu.ro" });
      expect(second).toEqual(first);
      expect(await h.rows(id)).toHaveLength(1);
    });
  });

  it("varianta e disponibilă: nu se păstrează nimic, răspunsul spune că e disponibilă", async () => {
    await withService(async (h) => {
      const id = await h.variant({ variants: [{ physical: "5" }] });
      expect(await h.service.subscribe({ variantId: id, email: "ana@exemplu.ro" })).toEqual({
        status: "available",
      });
      expect(await h.rows(id)).toEqual([]);
    });
  });

  it("«Stoc limitat» tot înseamnă disponibil (se poate comanda)", async () => {
    await withService(async (h) => {
      const id = await h.variant({ variants: [{ physical: "1" }] }); // 1 pas ≤ prag 2 → limitat
      expect((await h.service.subscribe({ variantId: id, email: "ana@exemplu.ro" })).status).toBe(
        "available",
      );
    });
  });

  it("sub minimul comandat înseamnă indisponibil: cererea se înregistrează", async () => {
    await withService(async (h) => {
      const id = await h.variant({ minSteps: 3, variants: [{ physical: "2" }] });
      expect((await h.service.subscribe({ variantId: id, email: "ana@exemplu.ro" })).status).toBe(
        "registered",
      );
    });
  });

  it("negestionat: «stoc epuizat» se înregistrează; «în stoc» și «la comandă» sunt disponibile", async () => {
    await withService(async (h) => {
      const out = await h.variant({ manageStock: false, stockStatus: "outofstock" });
      const inStock = await h.variant({ manageStock: false, stockStatus: "instock" });
      const onOrder = await h.variant({ manageStock: false, stockStatus: "onbackorder" });
      const status = async (variantId: string) =>
        (await h.service.subscribe({ variantId, email: "ana@exemplu.ro" })).status;
      expect(await status(out)).toBe("registered");
      expect(await status(inStock)).toBe("available");
      expect(await status(onOrder)).toBe("available");
    });
  });

  it("gestionat epuizat, dar cu «la comandă» permis: se poate comanda, deci nu se stochează nimic", async () => {
    await withService(async (h) => {
      const id = await h.variant({ allowBackorder: true });
      expect((await h.service.subscribe({ variantId: id, email: "ana@exemplu.ro" })).status).toBe(
        "available",
      );
      expect(await h.rows(id)).toEqual([]);
    });
  });

  it("produs digital: mereu disponibil, nu se stochează nimic", async () => {
    await withService(async (h) => {
      const id = await h.variant({ type: "digital", manageStock: false });
      expect((await h.service.subscribe({ variantId: id, email: "ana@exemplu.ro" })).status).toBe(
        "available",
      );
      expect(await h.rows(id)).toEqual([]);
    });
  });

  it("variantă inexistentă, produs în ciornă, arhivat sau în coșul de gunoi: BACK_IN_STOCK_VARIANT_NOT_FOUND", async () => {
    await withService(async (h) => {
      const draft = await h.variant({ status: "draft" });
      const archived = await h.variant({ status: "archived" });
      const deleted = await h.variant();
      await h.tx.product.updateMany({
        where: { variants: { some: { id: deleted } } },
        data: { deletedAt: new Date() },
      });
      for (const variantId of [draft, archived, deleted, "nu-exista"]) {
        expect(await codeOf(h.service.subscribe({ variantId, email: "ana@exemplu.ro" }))).toBe(
          "BACK_IN_STOCK_VARIANT_NOT_FOUND",
        );
      }
      expect(
        await h.tx.backInStockAlert.count({
          where: { variantId: { in: [draft, archived, deleted] } },
        }),
      ).toBe(0);
    });
  });

  it("adresă invalidă: ValidationError și nimic scris", async () => {
    await withService(async (h) => {
      const id = await h.variant();
      await expect(h.service.subscribe({ variantId: id, email: "fără-arond" })).rejects.toThrow(
        ValidationError,
      );
      expect(await h.rows(id)).toEqual([]);
    });
  });
});

describe("plafoane împotriva abuzului", () => {
  it("pe adresă: după plafon cererea nouă e refuzată, repetarea uneia existente nu consumă nimic, altă adresă merge", async () => {
    await withService(async (h) => {
      const ids = [await h.variant(), await h.variant(), await h.variant(), await h.variant()];
      const subscribe = (variantId: string, email: string) =>
        h.service.subscribe({ variantId, email });
      for (const id of ids.slice(0, 3)) await subscribe(id, "ana@exemplu.ro");
      expect(await codeOf(subscribe(ids[3]!, "ana@exemplu.ro"))).toBe("BACK_IN_STOCK_EMAIL_LIMIT");
      // aceeași adresă cu majuscule se numără la fel
      expect(await codeOf(subscribe(ids[3]!, "ANA@exemplu.ro"))).toBe("BACK_IN_STOCK_EMAIL_LIMIT");
      // repetarea unei cereri existente nu e refuzată
      expect((await subscribe(ids[0]!, "ana@exemplu.ro")).status).toBe("registered");
      // altă adresă are plafonul ei
      expect((await subscribe(ids[3]!, "mihai@exemplu.ro")).status).toBe("registered");
      expect(await h.rows(ids[3]!)).toHaveLength(1);
    });
  });

  it("pe variantă: după plafon cererea nouă e refuzată, repetarea uneia existente nu", async () => {
    await withService(async (h) => {
      const id = await h.variant();
      for (const email of ["a@exemplu.ro", "b@exemplu.ro", "c@exemplu.ro", "d@exemplu.ro"]) {
        await h.service.subscribe({ variantId: id, email });
      }
      expect(await codeOf(h.service.subscribe({ variantId: id, email: "e@exemplu.ro" }))).toBe(
        "BACK_IN_STOCK_VARIANT_LIMIT",
      );
      expect((await h.service.subscribe({ variantId: id, email: "A@exemplu.ro" })).status).toBe(
        "registered",
      );
      expect(await h.rows(id)).toHaveLength(4);
    });
  });

  it("cererile deja trimise nu ocupă plafoanele, iar după trimitere aceeași adresă poate cere din nou", async () => {
    await withService(async (h) => {
      const ids = [await h.variant(), await h.variant(), await h.variant(), await h.variant()];
      for (const id of ids.slice(0, 3)) {
        await h.service.subscribe({ variantId: id, email: "ana@exemplu.ro" });
      }
      await h.tx.backInStockAlert.updateMany({
        where: { variantId: { in: ids } },
        data: { notifiedAt: new Date() },
      });
      expect(
        (await h.service.subscribe({ variantId: ids[3]!, email: "ana@exemplu.ro" })).status,
      ).toBe("registered");
      // aceeași variantă și adresă după o trimitere: cerere nouă, alături de cea trimisă
      expect(
        (await h.service.subscribe({ variantId: ids[0]!, email: "ana@exemplu.ro" })).status,
      ).toBe("registered");
      expect(await h.rows(ids[0]!)).toHaveLength(2);
    });
  });
});

describe("selecția cererilor de trimis (findNotifiable)", () => {
  it("nimic cât timp varianta e epuizată; după intrarea în stoc, cererea apare", async () => {
    await withService(async (h) => {
      const id = await h.variant();
      await h.service.subscribe({ variantId: id, email: "ana@exemplu.ro" });
      expect(await h.service.findNotifiable({ limit: 10 })).toEqual([]);
      await h.setPhysical(id, "5");
      const found = await h.service.findNotifiable({ limit: 10 });
      expect(found.map((a) => a.variantId)).toEqual([id]);
    });
  });

  it("minimul comandat contează: 2 pași nu ajung la minim 3, 3 pași ajung", async () => {
    await withService(async (h) => {
      const id = await h.variant({ minSteps: 3, variants: [{ physical: "2" }] });
      await h.service.subscribe({ variantId: id, email: "ana@exemplu.ro" });
      expect(await h.service.findNotifiable({ limit: 10 })).toEqual([]);
      await h.setPhysical(id, "3");
      expect(await h.service.findNotifiable({ limit: 10 })).toHaveLength(1);
    });
  });

  it("stocul rezervat sau angajat nu se numără: fizic 1 cu 1 rezervat rămâne indisponibil", async () => {
    await withService(async (h) => {
      const id = await h.variant();
      await h.service.subscribe({ variantId: id, email: "ana@exemplu.ro" });
      await h.tx.inventoryItem.update({
        where: { variantId_warehouseId: { variantId: id, warehouseId: h.ctx.warehouseId } },
        data: { physical: parseQuantity("1"), reserved: parseQuantity("1") },
      });
      expect(await h.service.findNotifiable({ limit: 10 })).toEqual([]);
    });
  });

  it("«stoc limitat» declanșează trimiterea (disponibil ≥ 1 pas)", async () => {
    await withService(async (h) => {
      const id = await h.variant();
      await h.service.subscribe({ variantId: id, email: "ana@exemplu.ro" });
      await h.setPhysical(id, "1");
      expect(await h.service.findNotifiable({ limit: 10 })).toHaveLength(1);
    });
  });

  it("negestionat: doar «în stoc» declanșează; «la comandă» nu", async () => {
    await withService(async (h) => {
      const id = await h.variant({ manageStock: false, stockStatus: "outofstock" });
      await h.service.subscribe({ variantId: id, email: "ana@exemplu.ro" });
      const setStatus = (stockStatus: string) =>
        h.tx.product.updateMany({
          where: { variants: { some: { id } } },
          data: { stockStatus },
        });
      await setStatus("onbackorder");
      expect(await h.service.findNotifiable({ limit: 10 })).toEqual([]);
      await setStatus("instock");
      expect(await h.service.findNotifiable({ limit: 10 })).toHaveLength(1);
    });
  });

  it("gestionat epuizat care a trecut pe «la comandă» (hibrid pornit după cerere) nu declanșează", async () => {
    await withService(async (h) => {
      const id = await h.variant();
      await h.service.subscribe({ variantId: id, email: "ana@exemplu.ro" });
      await h.tx.product.updateMany({
        where: { variants: { some: { id } } },
        data: { allowBackorder: true },
      });
      expect(await h.service.findNotifiable({ limit: 10 })).toEqual([]);
    });
  });

  it("nu întoarce cererile deja trimise și nici pe cele ale produselor care nu mai sunt active sau au fost șterse", async () => {
    await withService(async (h) => {
      const sent = await h.variant();
      const draft = await h.variant();
      const deleted = await h.variant();
      const live = await h.variant();
      for (const [i, id] of [sent, draft, deleted, live].entries()) {
        await h.service.subscribe({ variantId: id, email: `client${i}@exemplu.ro` });
        await h.setPhysical(id, "5");
      }
      await h.tx.backInStockAlert.updateMany({
        where: { variantId: sent },
        data: { notifiedAt: new Date() },
      });
      await h.tx.product.updateMany({
        where: { variants: { some: { id: draft } } },
        data: { status: "draft" },
      });
      await h.tx.product.updateMany({
        where: { variants: { some: { id: deleted } } },
        data: { deletedAt: new Date() },
      });
      const found = await h.service.findNotifiable({ limit: 10 });
      expect(found.map((a) => a.variantId)).toEqual([live]);
    });
  });

  it("cele mai vechi cereri primele și cel mult `limit`", async () => {
    await withService(async (h) => {
      const id = await h.variant();
      for (const email of ["a@exemplu.ro", "b@exemplu.ro", "c@exemplu.ro"]) {
        await h.service.subscribe({ variantId: id, email });
      }
      await h.setPhysical(id, "5");
      const all = await h.tx.backInStockAlert.findMany({
        where: { variantId: id },
        orderBy: { email: "asc" },
      });
      // vechimea o stabilim explicit: c, apoi a, apoi b
      const base = Date.now();
      const age = { "c@exemplu.ro": 3, "a@exemplu.ro": 2, "b@exemplu.ro": 1 } as const;
      for (const row of all) {
        await h.tx.backInStockAlert.update({
          where: { id: row.id },
          data: { createdAt: new Date(base - age[row.email as keyof typeof age] * 60_000) },
        });
      }
      const found = await h.service.findNotifiable({ limit: 2 });
      expect(found).toHaveLength(2);
      const emails = await h.tx.backInStockAlert.findMany({
        where: { id: { in: found.map((a) => a.id) } },
      });
      expect(found.map((a) => emails.find((e) => e.id === a.id)?.email)).toEqual([
        "c@exemplu.ro",
        "a@exemplu.ro",
      ]);
    });
  });

  it("nu scoate adresa din bază: rezultatul are doar identificatori", async () => {
    await withService(async (h) => {
      const id = await h.variant();
      await h.service.subscribe({ variantId: id, email: "ana@exemplu.ro" });
      await h.setPhysical(id, "5");
      const [found] = await h.service.findNotifiable({ limit: 10 });
      expect(Object.keys(found!).sort()).toEqual(["id", "variantId"]);
    });
  });
});

describe("claim, release, complete", () => {
  async function pendingAlert(h: Harness, spec: ProductSpec = {}) {
    const variantId = await h.variant(spec);
    await h.service.subscribe({ variantId, email: "ana@exemplu.ro" });
    const alert = await h.tx.backInStockAlert.findFirstOrThrow({ where: { variantId } });
    return { variantId, alertId: alert.id };
  }

  it("claim: marchează cererea și dă adresa și produsul; al doilea claim găsește cererea luată", async () => {
    await withService(async (h) => {
      const { variantId, alertId } = await pendingAlert(h);
      await h.setPhysical(variantId, "5");
      const claimed = await h.service.claim(alertId);
      expect(claimed).toMatchObject({
        status: "claimed",
        alert: { id: alertId, email: "ana@exemplu.ro", variantLabel: null },
      });
      if (claimed.status === "claimed") {
        expect(claimed.alert.productTitle).toContain("Produs stoc");
        expect(claimed.alert.productSlug).toMatch(/^st-/);
      }
      expect((await h.rows(variantId))[0]?.notifiedAt).toBeInstanceOf(Date);
      expect(await h.service.claim(alertId)).toEqual({ status: "gone" });
    });
  });

  it("claim cât timp stocul a dispărut din nou: «unavailable», cererea rămâne în așteptare", async () => {
    await withService(async (h) => {
      const { variantId, alertId } = await pendingAlert(h);
      expect(await h.service.claim(alertId)).toEqual({ status: "unavailable" });
      expect((await h.rows(variantId))[0]?.notifiedAt).toBeNull();
      await h.setPhysical(variantId, "5");
      expect((await h.service.claim(alertId)).status).toBe("claimed");
    });
  });

  it("claim pe o cerere inexistentă: «gone»", async () => {
    await withService(async (h) => {
      expect(await h.service.claim("nu-exista")).toEqual({ status: "gone" });
    });
  });

  it("claim cât produsul nu mai e activ: «unavailable», nimic consumat", async () => {
    await withService(async (h) => {
      const { variantId, alertId } = await pendingAlert(h);
      await h.setPhysical(variantId, "5");
      await h.tx.product.updateMany({
        where: { variants: { some: { id: variantId } } },
        data: { status: "archived" },
      });
      expect(await h.service.claim(alertId)).toEqual({ status: "unavailable" });
      expect((await h.rows(variantId))[0]?.notifiedAt).toBeNull();
    });
  });

  it("release: o cerere luată revine în așteptare și poate fi luată din nou; pe una în așteptare nu face nimic", async () => {
    await withService(async (h) => {
      const { variantId, alertId } = await pendingAlert(h);
      await h.setPhysical(variantId, "5");
      expect(await h.service.release(alertId)).toBe(false); // încă în așteptare, nimic de eliberat
      await h.service.claim(alertId);
      expect(await h.service.release(alertId)).toBe(true);
      expect((await h.rows(variantId))[0]?.notifiedAt).toBeNull();
      expect((await h.service.claim(alertId)).status).toBe("claimed");
    });
  });

  it("release când clientul a cerut între timp din nou aceeași variantă: rămâne o singură cerere în așteptare, fără eroare de unicitate", async () => {
    await withService(async (h) => {
      const { variantId, alertId } = await pendingAlert(h);
      await h.setPhysical(variantId, "5");
      await h.service.claim(alertId);
      await h.setPhysical(variantId, "0");
      await h.service.subscribe({ variantId, email: "ana@exemplu.ro" }); // cerere nouă, în așteptare
      expect(await h.service.release(alertId)).toBe(true);
      const rows = await h.rows(variantId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.notifiedAt).toBeNull();
    });
  });

  it("complete: șterge cererea luată (adresa dispare din bază); pe una în așteptare sau absentă nu face nimic", async () => {
    await withService(async (h) => {
      const { variantId, alertId } = await pendingAlert(h);
      await h.setPhysical(variantId, "5");
      expect(await h.service.complete(alertId)).toBe(false); // nu e luată: nu se șterge
      expect(await h.rows(variantId)).toHaveLength(1);
      await h.service.claim(alertId);
      expect(await h.service.complete(alertId)).toBe(true);
      expect(await h.rows(variantId)).toEqual([]);
      expect(await h.service.complete(alertId)).toBe(false);
    });
  });

  it("o cerere trimisă nu se mai găsește la selecție", async () => {
    await withService(async (h) => {
      const { variantId, alertId } = await pendingAlert(h);
      await h.setPhysical(variantId, "5");
      expect(await h.service.findNotifiable({ limit: 10 })).toHaveLength(1);
      await h.service.claim(alertId);
      expect(await h.service.findNotifiable({ limit: 10 })).toEqual([]);
    });
  });
});

describe("erorile nu poartă adresa", () => {
  it("plafonul pe adresă nu pune adresa în mesaj sau detalii", async () => {
    await withService(
      async (h) => {
        const a = await h.variant();
        const b = await h.variant();
        await h.service.subscribe({ variantId: a, email: "secret.persoana@exemplu.ro" });
        try {
          await h.service.subscribe({ variantId: b, email: "secret.persoana@exemplu.ro" });
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(BackInStockError);
          const text = `${(error as Error).message} ${JSON.stringify((error as BackInStockError).details ?? null)}`;
          expect(text).not.toContain("secret.persoana");
        }
      },
      { maxPerEmail: 1 },
    );
  });
});
