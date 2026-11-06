import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import {
  addStockProduct,
  createStockContext,
  purgeStockContext,
  purgeStockLeftovers,
} from "./stock-fixtures";

/**
 * (15e) Cursa din curățarea globală a fixture-urilor de stoc (incidentul #2 din PROGRESS). Fișierele de concurență lucrează cu
 * date COMISE și, la început, își curățau «resturile» cu o ștergere GLOBALĂ (toate produsele `st-…`, depozitele `w_…`, unitățile
 * `u_…`): rulate în paralel de workeri diferiți, curățarea unuia șterge datele aflate în lucru ale celuilalt (încălcare de cheie
 * străină la `inventoryItem.create` / `warehouse.deleteMany`, eșecuri false). Acum fiecare fișier are un spațiu de nume propriu
 * (`createStockContext(db, { namespace })`), iar `purgeStockLeftovers(db, namespace)` șterge DOAR ce are prefixul lui.
 *
 * Aici cele două fișiere sunt simulate cu două spații de nume, pe date comise, într-un fișier propriu (aceleași două spații nu
 * sunt folosite nicăieri altundeva, ca un fișier paralel să nu poată interveni). Singura ștergere de registre imuabile rămâne
 * cea din `purgeStockContext` / `purgeStockLeftovers`, deja păzită de `append-only.test.ts`.
 */
const db = getDb();
const MINE = "fxone";
const OTHER = "fxtwo";

afterAll(async () => {
  await purgeStockLeftovers(db, MINE);
  await purgeStockLeftovers(db, OTHER);
  await db.$disconnect();
});

describe("curățarea resturilor șterge doar spațiul de nume al apelantului", () => {
  it("cursa din incident: curățarea unui fișier nu strică datele aflate în lucru ale altuia", async () => {
    await purgeStockLeftovers(db, MINE);
    await purgeStockLeftovers(db, OTHER);
    // fișierul «celălalt» e în lucru: produs și variantă comise, încă fără rândul de stoc
    const other = await createStockContext(db, { namespace: OTHER });
    const { variants } = await addStockProduct(db, other, { variants: [{ physical: null }] });
    const variantId = variants[0]!.id;
    try {
      // fișierul meu începe: își curăță resturile
      await purgeStockLeftovers(db, MINE);
      // fișierul celălalt continuă: înainte de remediere, variantei îi dispăruse produsul și crearea rândului de stoc pica cu
      // încălcare de cheie străină
      await expect(
        db.inventoryItem.create({ data: { variantId, warehouseId: other.warehouseId } }),
      ).resolves.toMatchObject({ variantId });
      expect(await db.warehouse.findUnique({ where: { id: other.warehouseId } })).not.toBeNull();
      expect(await db.measureUnit.findUnique({ where: { id: other.unitId } })).not.toBeNull();
    } finally {
      await purgeStockContext(db, other);
    }
  });

  it("șterge complet resturile propriului spațiu (produse, variante, stoc, depozit, unitate) și nimic din celelalte", async () => {
    await purgeStockLeftovers(db, MINE);
    await purgeStockLeftovers(db, OTHER);
    const mine = await createStockContext(db, { namespace: MINE });
    const theirs = await createStockContext(db, { namespace: OTHER });
    await addStockProduct(db, mine, { variants: [{ physical: "5" }] });
    await addStockProduct(db, theirs, { variants: [{ physical: "7" }] });
    // un context fără spațiu de nume (altă clasă de teste cu date comise) nu e al nimănui: nu se atinge
    const anonymous = await createStockContext(db);
    await addStockProduct(db, anonymous, { variants: [{ physical: "9" }] });
    try {
      expect(await purgeStockLeftovers(db, MINE)).toBe(1);
      expect(await db.product.count({ where: { id: { in: mine.productIds } } })).toBe(0);
      expect(await db.inventoryItem.count({ where: { variantId: { in: mine.variantIds } } })).toBe(
        0,
      );
      expect(await db.warehouse.count({ where: { id: mine.warehouseId } })).toBe(0);
      expect(await db.measureUnit.count({ where: { id: mine.unitId } })).toBe(0);

      expect(await db.product.count({ where: { id: { in: theirs.productIds } } })).toBe(1);
      expect(
        await db.inventoryItem.count({ where: { variantId: { in: theirs.variantIds } } }),
      ).toBe(1);
      expect(await db.warehouse.count({ where: { id: theirs.warehouseId } })).toBe(1);
      expect(await db.measureUnit.count({ where: { id: theirs.unitId } })).toBe(1);
      expect(await db.product.count({ where: { id: { in: anonymous.productIds } } })).toBe(1);
      expect(await db.warehouse.count({ where: { id: anonymous.warehouseId } })).toBe(1);
    } finally {
      await purgeStockContext(db, theirs);
      await purgeStockContext(db, anonymous);
    }
  });

  it("un spațiu de nume care e prefix al altuia nu îl atinge", async () => {
    // «fxone» vs «fxonex»: prefixul slug-ului include delimitatorul, deci nu se amestecă
    const longer = await createStockContext(db, { namespace: `${MINE}x` });
    await addStockProduct(db, longer, { variants: [{ physical: "1" }] });
    try {
      await purgeStockLeftovers(db, MINE);
      expect(await db.product.count({ where: { id: { in: longer.productIds } } })).toBe(1);
      expect(await db.warehouse.count({ where: { id: longer.warehouseId } })).toBe(1);
      expect(await db.measureUnit.count({ where: { id: longer.unitId } })).toBe(1);
    } finally {
      await purgeStockContext(db, longer);
    }
  });

  it("un produs al cărui slug seamănă cu al fixture-ului, dar nu e un «Produs stoc», nu se atinge", async () => {
    const lookalike = await db.product.create({
      data: { slug: `st-${MINE}_produs-real`, title: "Produs real, nu de test" },
    });
    try {
      await purgeStockLeftovers(db, MINE);
      expect(await db.product.count({ where: { id: lookalike.id } })).toBe(1);
    } finally {
      await db.product.delete({ where: { id: lookalike.id } });
    }
  });

  it("tag-ul și codurile contextului poartă spațiul de nume; fără spațiu, rămân neschimbate (doar tag aleator)", async () => {
    const named = await createStockContext(db, { namespace: MINE });
    const plain = await createStockContext(db);
    try {
      expect(named.tag.startsWith(`${MINE}_`)).toBe(true);
      expect((await db.warehouse.findUnique({ where: { id: named.warehouseId } }))?.code).toBe(
        `w_${named.tag}`,
      );
      expect((await db.measureUnit.findUnique({ where: { id: named.unitId } }))?.code).toBe(
        `u_${named.tag}`,
      );
      expect(plain.tag).toMatch(/^[0-9a-f]{10}$/);
    } finally {
      await purgeStockContext(db, named);
      await purgeStockContext(db, plain);
    }
  });
});
