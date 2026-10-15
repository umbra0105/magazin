import { describe, expect, it, vi } from "vitest";
import { AuditService, type AuditRow, type AuditStore } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { DEFAULT_ROLES } from "../rbac/catalog";
import {
  AttributeService,
  type AttributeOptionRecord,
  type AttributeRecord,
  type AttributeStore,
  type NewAttributeData,
} from "./attribute-service";
import {
  ProductAttributesService,
  type ProductAttributeStore,
  type ValueWrite,
} from "./product-attributes";

function roleSubject(roleKey: string): PermissionSubject {
  const role = DEFAULT_ROLES.find((r) => r.key === roleKey);
  if (!role) throw new Error(roleKey);
  return {
    userId: `u-${roleKey}`,
    email: `${roleKey}@magazin.test`,
    roles: [roleKey],
    permissions: new Set<string>(role.permissions),
  };
}

type Stored = {
  attributeId: string;
  text: string | null;
  number: string | null;
  bool: boolean | null;
  optionId: string | null;
};

/** Baza în memorie pentru definiții și valori (aceleași reguli de bază ca Postgres). */
class MemoryAttributes implements AttributeStore, ProductAttributeStore {
  attrs = new Map<string, AttributeRecord>();
  values = new Map<string, Stored[]>(); // productId -> valori
  products = new Map<string, { id: string; slug: string; deletedAt: Date | null }>();
  private n = 0;
  private id(p: string) {
    return `${p}-${++this.n}`;
  }

  private withCounts(a: AttributeRecord): AttributeRecord {
    const all = [...this.values.values()].flat();
    return {
      ...a,
      productCount: all.filter((v) => v.attributeId === a.id).length,
      options: a.options.map((o) => ({
        ...o,
        productCount: all.filter((v) => v.optionId === o.id).length,
      })),
    };
  }

  async list() {
    return [...this.attrs.values()]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((a) => this.withCounts(a));
  }
  async get(id: string) {
    const a = this.attrs.get(id);
    return a ? this.withCounts(a) : null;
  }
  async codeExists(code: string) {
    return [...this.attrs.values()].some((a) => a.code === code);
  }
  async create(data: NewAttributeData, options: readonly string[]) {
    const id = this.id("a");
    const record: AttributeRecord = {
      id,
      ...data,
      options: options.map((value, position) => ({
        id: this.id("o"),
        attributeId: id,
        value,
        position,
        productCount: 0,
      })),
      productCount: 0,
    };
    this.attrs.set(id, record);
    return record;
  }
  async update(id: string, data: Partial<Omit<NewAttributeData, "code">>, clearOptions: boolean) {
    const current = this.attrs.get(id) as AttributeRecord;
    const next = { ...current, ...data, options: clearOptions ? [] : current.options };
    this.attrs.set(id, next);
    return this.withCounts(next);
  }
  async delete(id: string) {
    this.attrs.delete(id);
  }
  async getOption(optionId: string) {
    for (const a of this.attrs.values()) {
      const o = (await this.get(a.id))?.options.find((x) => x.id === optionId);
      if (o) return o;
    }
    return null;
  }
  async optionValueExists(attributeId: string, value: string, excludeOptionId?: string) {
    return (this.attrs.get(attributeId)?.options ?? []).some(
      (o) => o.id !== excludeOptionId && o.value.toLowerCase() === value.toLowerCase(),
    );
  }
  async addOption(attributeId: string, value: string): Promise<AttributeOptionRecord> {
    const a = this.attrs.get(attributeId) as AttributeRecord;
    const o = { id: this.id("o"), attributeId, value, position: a.options.length, productCount: 0 };
    a.options.push(o);
    return o;
  }
  async renameOption(optionId: string, value: string) {
    for (const a of this.attrs.values()) {
      const o = a.options.find((x) => x.id === optionId);
      if (o) o.value = value;
    }
  }
  async deleteOption(optionId: string) {
    for (const a of this.attrs.values()) a.options = a.options.filter((o) => o.id !== optionId);
  }
  async reorderOptions(attributeId: string, orderedIds: readonly string[]) {
    const a = this.attrs.get(attributeId) as AttributeRecord;
    a.options = orderedIds.map((id, position) => ({
      ...(a.options.find((o) => o.id === id) as AttributeOptionRecord),
      position,
    }));
  }

  // --- valorile pe produs
  async getProduct(id: string) {
    return this.products.get(id) ?? null;
  }
  async listValues(productId: string) {
    return this.values.get(productId) ?? [];
  }
  writes: ValueWrite[][] = [];
  async writeValues(productId: string, writes: readonly ValueWrite[]) {
    this.writes.push([...writes]);
    let rows = this.values.get(productId) ?? [];
    for (const w of writes) {
      rows = rows.filter((r) => r.attributeId !== w.attributeId);
      if (w.value) {
        rows.push({
          attributeId: w.attributeId,
          text: w.value.text ?? null,
          number: w.value.number ?? null,
          bool: w.value.bool ?? null,
          optionId: w.value.optionId ?? null,
        });
      }
    }
    this.values.set(productId, rows);
  }
}

function setup() {
  const store = new MemoryAttributes();
  store.products.set("p1", { id: "p1", slug: "p-1", deletedAt: null });
  const auditRows: AuditRow[] = [];
  const auditStore: AuditStore = {
    async append(row) {
      auditRows.push({ ...row, id: `a-${auditRows.length}`, createdAt: new Date() });
    },
    async list() {
      return auditRows;
    },
  };
  const audit = new AuditService(auditStore);
  const invalidated: string[][] = [];
  const logger = { warn: vi.fn() };
  const invalidate = (tags: readonly string[]) => void invalidated.push([...tags]);
  const definitions = new AttributeService({ store, audit, invalidate, logger });
  const values = new ProductAttributesService({
    store,
    attributes: store,
    audit,
    invalidate,
    logger,
  });
  return { store, definitions, values, auditRows, invalidated };
}

const manager = () => roleSubject("manager");

describe("definiții de atribute", () => {
  it("creează atribute numerice cu unitate și de tip listă cu opțiuni; codul e unic", async () => {
    const { definitions, auditRows, invalidated } = setup();
    const diametru = await definitions.create(manager(), {
      code: "diametru",
      name: "Diametru",
      type: "number",
      unit: "mm",
      isFilterable: true,
    });
    expect(diametru).toMatchObject({
      code: "diametru",
      type: "number",
      unit: "mm",
      isFilterable: true,
    });

    const material = await definitions.create(manager(), {
      code: "material",
      name: "Material",
      type: "select",
      options: ["Inox", "inox", "PVC", "ABS"],
    });
    // „inox” e dublura lui „Inox” (nu contează majusculele)
    expect(material.options.map((o) => o.value)).toEqual(["Inox", "PVC", "ABS"]);

    await expect(
      definitions.create(manager(), { code: "diametru", name: "Altul", type: "text" }),
    ).rejects.toMatchObject({ code: "ATTRIBUTE_CODE_CONFLICT" });
    expect(auditRows.filter((r) => r.action === "attribute.create")).toHaveLength(2);
    expect(invalidated.length).toBeGreaterThan(0);
  });

  it("refuză codul invalid, unitatea la non-numeric, filtrabil la text, opțiuni la non-listă", async () => {
    const { definitions } = setup();
    const base = { code: "x", name: "X", type: "number" as const };
    for (const code of ["Diametru", "1abc", "are-cratima", "are spatiu", ""]) {
      await expect(definitions.create(manager(), { ...base, code })).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
    }
    await expect(
      definitions.create(manager(), { code: "t", name: "T", type: "text", unit: "mm" }),
    ).rejects.toMatchObject({ code: "ATTRIBUTE_UNIT_INVALID" });
    await expect(
      definitions.create(manager(), { code: "t", name: "T", type: "text", isFilterable: true }),
    ).rejects.toMatchObject({ code: "ATTRIBUTE_FILTERABLE_INVALID" });
    await expect(
      definitions.create(manager(), { code: "t", name: "T", type: "bool", options: ["a"] }),
    ).rejects.toMatchObject({ code: "ATTRIBUTE_OPTIONS_INVALID" });
  });

  it("tipul nu se schimbă cât are valori (mesaj cu numărul); fără valori, tipul se schimbă și curăță unitatea/opțiunile", async () => {
    const { store, definitions, values } = setup();
    const attr = await definitions.create(manager(), {
      code: "putere",
      name: "Putere",
      type: "number",
      unit: "kW",
    });
    store.products.set("p2", { id: "p2", slug: "p-2", deletedAt: null });
    await values.set(manager(), "p1", { values: [{ attributeId: attr.id, value: "4,5" }] });
    await values.set(manager(), "p2", { values: [{ attributeId: attr.id, value: "6" }] });

    const error = await definitions
      .update(manager(), attr.id, { type: "text" })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ATTRIBUTE_TYPE_LOCKED" });
    expect((error as Error).message).toContain("2 produse");
    // numele și unitatea se pot schimba oricând
    expect(
      await definitions.update(manager(), attr.id, { name: "Putere nominală", unit: "W" }),
    ).toMatchObject({
      name: "Putere nominală",
      unit: "W",
    });

    // fără valori: tipul se schimbă, unitatea dispare
    const empty = await definitions.create(manager(), {
      code: "gol",
      name: "Gol",
      type: "number",
      unit: "mm",
    });
    const changed = await definitions.update(manager(), empty.id, { type: "bool" });
    expect(changed).toMatchObject({ type: "bool", unit: null });
    const list = await definitions.create(manager(), {
      code: "lista",
      name: "Lista",
      type: "select",
      options: ["A", "B"],
    });
    expect((await definitions.update(manager(), list.id, { type: "bool" })).options).toEqual([]);
  });

  it("ștergerea atributului folosit e refuzată cu numărul de produse; cel nefolosit se șterge", async () => {
    const { definitions, values } = setup();
    const used = await definitions.create(manager(), {
      code: "culoare",
      name: "Culoare",
      type: "text",
    });
    const unused = await definitions.create(manager(), {
      code: "rezerva",
      name: "Rezervă",
      type: "text",
    });
    await values.set(manager(), "p1", { values: [{ attributeId: used.id, value: "alb" }] });

    const error = await definitions.delete(manager(), used.id).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ATTRIBUTE_IN_USE" });
    expect((error as Error).message).toContain("1 produs");
    await definitions.delete(manager(), unused.id);
    expect((await definitions.list(manager())).map((a) => a.code)).toEqual(["culoare"]);
  });

  it("opțiuni: adăugare, dublură refuzată, redenumire, ștergere refuzată când e folosită, reordonare validată", async () => {
    const { definitions, values } = setup();
    const material = await definitions.create(manager(), {
      code: "material",
      name: "Material",
      type: "select",
      options: ["Inox"],
    });
    const pvc = await definitions.addOption(manager(), material.id, { value: "PVC" });
    await expect(
      definitions.addOption(manager(), material.id, { value: "pvc" }),
    ).rejects.toMatchObject({ code: "ATTRIBUTE_OPTION_DUPLICATE" });
    await definitions.renameOption(manager(), pvc.id, { value: "PVC-U" });
    await expect(
      definitions.renameOption(manager(), pvc.id, { value: "inox" }),
    ).rejects.toMatchObject({ code: "ATTRIBUTE_OPTION_DUPLICATE" });

    await values.set(manager(), "p1", { values: [{ attributeId: material.id, value: pvc.id }] });
    const error = await definitions.deleteOption(manager(), pvc.id).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "ATTRIBUTE_OPTION_IN_USE" });
    expect((error as Error).message).toContain("1 produs");

    const fresh = await definitions.list(manager());
    const ids = (fresh[0] as AttributeRecord).options.map((o) => o.id);
    await definitions.reorderOptions(manager(), material.id, { orderedIds: [...ids].reverse() });
    expect(
      ((await definitions.list(manager()))[0] as AttributeRecord).options.map((o) => o.id),
    ).toEqual([...ids].reverse());
    await expect(
      definitions.reorderOptions(manager(), material.id, { orderedIds: [ids[0] as string] }),
    ).rejects.toMatchObject({ code: "ATTRIBUTE_OPTIONS_MISMATCH" });

    // la un atribut care nu e listă, opțiunile sunt refuzate
    const text = await definitions.create(manager(), { code: "nota", name: "Notă", type: "text" });
    await expect(definitions.addOption(manager(), text.id, { value: "x" })).rejects.toMatchObject({
      code: "ATTRIBUTE_OPTIONS_INVALID",
    });
  });

  it("scrierile cer products.write (Editorul e refuzat); citirea cere products.read", async () => {
    const { definitions } = setup();
    const editor = roleSubject("editor");
    await expect(
      definitions.create(editor, { code: "x", name: "X", type: "text" }),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    expect(await definitions.list(editor)).toEqual([]);
    await expect(definitions.list(roleSubject("support"))).rejects.toMatchObject({
      code: "AUTH_FORBIDDEN",
    });
  });
});

describe("valorile atributelor pe produs", () => {
  async function fixture() {
    const ctx = setup();
    const { definitions } = ctx;
    const diametru = await definitions.create(manager(), {
      code: "diametru",
      name: "Diametru",
      type: "number",
      unit: "mm",
    });
    const debit = await definitions.create(manager(), {
      code: "debit",
      name: "Debit",
      type: "number",
      unit: "m3_h",
    });
    const material = await definitions.create(manager(), {
      code: "material",
      name: "Material",
      type: "select",
      options: ["Inox", "PVC"],
    });
    const nota = await definitions.create(manager(), { code: "nota", name: "Notă", type: "text" });
    const rezistent = await definitions.create(manager(), {
      code: "uv",
      name: "Rezistent UV",
      type: "bool",
    });
    return { ...ctx, diametru, debit, material, nota, rezistent };
  }

  it("numerele cu virgulă sau punct se stochează exact (șir canonic, fără float)", async () => {
    const { values, store, diametru, debit } = await fixture();
    await values.set(manager(), "p1", {
      values: [
        { attributeId: diametru.id, value: "63,5" },
        { attributeId: debit.id, value: "0.1" },
      ],
    });
    expect(store.values.get("p1")).toEqual([
      expect.objectContaining({ attributeId: diametru.id, number: "63.5" }),
      expect.objectContaining({ attributeId: debit.id, number: "0.1" }),
    ]);
    const entries = await values.get(manager(), "p1");
    expect(entries.find((e) => e.attribute.code === "diametru")?.value).toBe("63.5");
  });

  it("validare pe tip: număr invalid, bool ca text, opțiune străină, text prea lung; cererea e respinsă întreagă", async () => {
    const { values, store, diametru, material, rezistent, nota } = await fixture();
    const set = (items: { attributeId: string; value: string | boolean | null }[]) =>
      values.set(manager(), "p1", { values: items });
    const base = { attributeId: nota.id, value: "ok" };

    for (const bad of ["abc", "1,23456", "12,5,3", "1e5"]) {
      await expect(set([base, { attributeId: diametru.id, value: bad }])).rejects.toMatchObject({
        code: "ATTRIBUTE_VALUE_INVALID",
      });
    }
    await expect(set([{ attributeId: rezistent.id, value: "da" }])).rejects.toMatchObject({
      code: "ATTRIBUTE_VALUE_INVALID",
    });
    await expect(
      set([{ attributeId: material.id, value: "optiune-straina" }]),
    ).rejects.toMatchObject({
      code: "ATTRIBUTE_VALUE_INVALID",
    });
    await expect(set([{ attributeId: nota.id, value: "x".repeat(501) }])).rejects.toMatchObject({
      code: "ATTRIBUTE_VALUE_INVALID",
    });
    await expect(set([{ attributeId: "lipsa", value: "1" }])).rejects.toMatchObject({
      code: "ATTRIBUTE_NOT_FOUND",
    });
    // nimic nu s-a scris (nici măcar „ok”)
    expect(store.writes).toEqual([]);
  });

  it("cerere parțială: doar ce se trimite se schimbă; text gol sau null șterge; neschimbat nu scrie și nu auditează", async () => {
    const { values, store, auditRows, diametru, nota, material } = await fixture();
    const opt = (await store.get(material.id))?.options[0] as AttributeOptionRecord;
    await values.set(manager(), "p1", {
      values: [
        { attributeId: diametru.id, value: "50" },
        { attributeId: nota.id, value: "  prima  " },
        { attributeId: material.id, value: opt.id },
      ],
    });
    expect(auditRows.filter((r) => r.action === "product.attributes.update")).toHaveLength(1);
    expect(auditRows.at(-1)).toMatchObject({
      after: { diametru: "50", nota: "prima", material: opt.id },
    });

    // același conținut: nicio scriere nouă
    const writes = store.writes.length;
    await values.set(manager(), "p1", { values: [{ attributeId: diametru.id, value: "50,00" }] });
    expect(store.writes.length).toBe(writes);

    // golire
    await values.set(manager(), "p1", {
      values: [
        { attributeId: nota.id, value: "" },
        { attributeId: material.id, value: null },
      ],
    });
    const left = (await store.listValues("p1")).map((v) => v.attributeId);
    expect(left).toEqual([diametru.id]);
  });

  it("Editorul e refuzat (403, audit denied), produs șters/inexistent refuză, același atribut de două ori refuză", async () => {
    const { values, store, auditRows, nota } = await fixture();
    await expect(
      values.set(roleSubject("editor"), "p1", { values: [{ attributeId: nota.id, value: "x" }] }),
    ).rejects.toMatchObject({ code: "AUTH_FORBIDDEN" });
    expect(auditRows.at(-1)).toMatchObject({
      outcome: "denied",
      after: { deniedFields: ["attributes"] },
    });
    store.products.set("p9", { id: "p9", slug: "p-9", deletedAt: new Date() });
    await expect(
      values.set(manager(), "p9", { values: [{ attributeId: nota.id, value: "x" }] }),
    ).rejects.toMatchObject({ code: "CATALOG_PRODUCT_DELETED" });
    await expect(
      values.set(manager(), "nu-exista", { values: [{ attributeId: nota.id, value: "x" }] }),
    ).rejects.toMatchObject({ code: "CATALOG_PRODUCT_NOT_FOUND" });
    await expect(
      values.set(manager(), "p1", {
        values: [
          { attributeId: nota.id, value: "a" },
          { attributeId: nota.id, value: "b" },
        ],
      }),
    ).rejects.toMatchObject({ code: "ATTRIBUTE_VALUE_DUPLICATE" });
    expect(store.writes).toEqual([]);
  });
});
