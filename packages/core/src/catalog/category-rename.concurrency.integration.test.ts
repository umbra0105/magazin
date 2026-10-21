import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { createLogger } from "@ecom/shared";
import { AuditService } from "../audit/audit-service";
import type { PermissionSubject } from "../rbac/can";
import { CategoryService } from "./category-service";
import { createPrismaCategoryStore, type CategoryStore } from "./category-store";

/**
 * Blocul C, C-15, pe Postgres real: redenumirea unei categorii (schimbarea adresei) scria `slug`-ul într-o instrucțiune și apoi
 * corecta căile într-o tranzacție SEPARATĂ, în afara lacătului:
 *  (A) dacă a doua parte eșua, `slug` rămânea nou și `path` vechi, iar o reîncercare nu repara nimic (diferența era deja zero);
 *  (B) două redenumiri simultane puteau lăsa `slug = "c"` și `path = "/…-b"`.
 * Acum slug-ul și căile (a categoriei și a descendenților) se scriu ÎNTR-O singură tranzacție, sub lacătul arborelui.
 */

const db = getDb();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const subject: PermissionSubject = {
  userId: "u-rename",
  email: "rename@magazin.test",
  roles: ["manager"],
  permissions: new Set(["admin.access", "products.write", "products.content.write"]),
};
const created: string[] = [];

afterAll(async () => {
  await db.category.deleteMany({ where: { id: { in: created }, depth: { gt: 0 } } });
  await db.category.deleteMany({ where: { id: { in: created } } });
  await db.$disconnect();
});

const serviceOver = (store: CategoryStore) =>
  new CategoryService({
    store,
    audit: new AuditService({ append: async () => undefined, list: async () => [] }),
    logger: createLogger({ destination: { write() {} } }),
  });

async function tree(tag: string) {
  const root = await db.category.create({
    data: {
      name: `ZZ Rad ${tag}`,
      slug: `zz-rad-${tag}`,
      path: `zz-rad-${tag}`,
      depth: 0,
      sortOrder: 0,
    },
  });
  const child = await db.category.create({
    data: {
      name: `ZZ Copil ${tag}`,
      slug: `zz-copil-${tag}`,
      path: `zz-rad-${tag}/zz-copil-${tag}`,
      depth: 1,
      sortOrder: 0,
      parentId: root.id,
    },
  });
  created.push(root.id, child.id);
  return { root, child };
}

describe("redenumirea categoriei: atomică și sub lacăt (Postgres real)", () => {
  it("(A) dacă scrierea căilor eșuează, slug-ul NU rămâne schimbat", async () => {
    const tag = randomUUID().slice(0, 8);
    const { root } = await tree(tag);
    const real = createPrismaCategoryStore(db);
    const store: CategoryStore = {
      ...real,
      async applyUpdates() {
        throw new Error("scriere eșuată (injectată)");
      },
    };
    await expect(
      serviceOver(store).update(subject, root.id, { slug: `zz-nou-${tag}` }),
    ).rejects.toThrow();
    const after = await db.category.findUniqueOrThrow({ where: { id: root.id } });
    expect(after.slug).toBe(`zz-rad-${tag}`);
    expect(after.path).toBe(`zz-rad-${tag}`);
  });

  it("(B) două redenumiri simultane lasă slug-ul și calea (și pe cele ale copilului) consistente", async () => {
    const tag = randomUUID().slice(0, 8);
    const { root, child } = await tree(tag);
    const real = createPrismaCategoryStore(db);
    let entered = 0;
    const store: CategoryStore = {
      ...real,
      // prima redenumire ajunge la lacăt ULTIMA (întârziată), deci a doua își scrie căile prima; slug-ul scris separat
      // (înainte de remediere) rămânea al celei de-a doua, iar calea a primeia
      async serialized(fn) {
        if (++entered === 1) await sleep(250);
        return real.serialized(fn);
      },
    };
    const service = serviceOver(store);
    await Promise.all([
      service.update(subject, root.id, { slug: `zz-b-${tag}` }),
      (async () => {
        await sleep(30);
        return service.update(subject, root.id, { slug: `zz-c-${tag}` });
      })(),
    ]);
    const rootAfter = await db.category.findUniqueOrThrow({ where: { id: root.id } });
    const childAfter = await db.category.findUniqueOrThrow({ where: { id: child.id } });
    expect(rootAfter.path).toBe(rootAfter.slug);
    expect(childAfter.path).toBe(`${rootAfter.path}/zz-copil-${tag}`);
    expect(["zz-b-" + tag, "zz-c-" + tag]).toContain(rootAfter.slug);
  }, 30_000);

  it("redenumirea obișnuită actualizează slug-ul, calea și calea descendenților", async () => {
    const tag = randomUUID().slice(0, 8);
    const { root, child } = await tree(tag);
    const service = serviceOver(createPrismaCategoryStore(db));
    const updated = await service.update(subject, root.id, { slug: `zz-nou-${tag}` });
    expect(updated.slug).toBe(`zz-nou-${tag}`);
    expect((await db.category.findUniqueOrThrow({ where: { id: root.id } })).path).toBe(
      `zz-nou-${tag}`,
    );
    expect((await db.category.findUniqueOrThrow({ where: { id: child.id } })).path).toBe(
      `zz-nou-${tag}/zz-copil-${tag}`,
    );
  });

  it("alte câmpuri se salvează împreună cu redenumirea, într-o singură cerere", async () => {
    const tag = randomUUID().slice(0, 8);
    const { root } = await tree(tag);
    const service = serviceOver(createPrismaCategoryStore(db));
    const updated = await service.update(subject, root.id, {
      slug: `zz-alt-${tag}`,
      description: "Descriere nouă",
    });
    expect(updated.slug).toBe(`zz-alt-${tag}`);
    expect(updated.description).toBe("Descriere nouă");
  });
});
