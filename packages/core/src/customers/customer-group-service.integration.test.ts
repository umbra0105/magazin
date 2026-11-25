import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "@ecom/db";
import { AuditService } from "../audit/audit-service";
import { DEFAULT_ROLES } from "../rbac/catalog";
import type { PermissionSubject } from "../rbac/can";
import { MemoryAudit } from "../test-utils/memory-audit";
import { inRolledBackTransaction, type TestTx } from "../test-utils/rollback";
import { createPrismaCustomerGroupStore } from "./customer-group-store";
import { CustomerGroupService, maskEmail } from "./customer-group-service";

/**
 * Serviciul grupurilor de clienți pe Postgres real, în tranzacție anulată: permisiuni verificate pe server (fără permisiune =
 * refuz, nimic modificat), reguli (grupul de sistem, grupul cu clienți, atribuirea în masă) și audit fără date personale.
 * Nu presupun seed: grupul de sistem se creează aici.
 */
const db = getDb();
afterAll(() => db.$disconnect());

const uid = (): string => randomUUID().slice(0, 8);

function subjectFor(role: string, extra: readonly string[] = []): PermissionSubject {
  const def = DEFAULT_ROLES.find((r) => r.key === role);
  return {
    userId: `staff_${uid()}`,
    email: `${role}@exemplu.test`,
    roles: [role],
    permissions: new Set([...(def?.permissions ?? []), ...extra]),
  };
}

const owner = subjectFor("owner");
const manager = subjectFor("manager"); // customers.read/read_pii/write, FĂRĂ customers.groups.manage
const support = subjectFor("support"); // customers.read/read_pii, fără write
const warehouse = subjectFor("warehouse"); // fără customers.*

async function world(tx: TestTx) {
  const audit = new MemoryAudit();
  const service = new CustomerGroupService({
    store: createPrismaCustomerGroupStore(tx),
    audit: new AuditService(audit),
  });
  const existing = await tx.customerGroup.findFirst({ where: { isSystem: true } });
  const system =
    existing ??
    (await tx.customerGroup.create({
      data: { name: "Client standard", slug: "client-standard", isSystem: true },
    }));
  return { tx, audit, service, system };
}

async function customer(tx: TestTx, over: Record<string, unknown> = {}) {
  return tx.user.create({
    data: {
      id: `u_${uid()}`,
      name: `Client ${uid()}`,
      email: `cl-${uid()}@exemplu.test`,
      emailVerified: true,
      ...over,
    } as never,
  });
}

const fidel = { name: "Client fidel", pricingType: "discount", discountBps: 500, tone: "success" };
const partner = {
  name: "Partener 1",
  pricingType: "cost_plus",
  markupBps: 1200,
  earnsLoyaltyPoints: false,
};

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code ?? "fără cod";
  }
  return "nicio eroare";
};

describe("permisiuni (verificate pe server)", () => {
  it("fără customers.read nu se vede nimic; managerul nu gestionează grupurile; suportul nu mută clienți", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { service } = await world(tx);
      expect(await codeOf(service.list(warehouse))).toBe("AUTH_FORBIDDEN");
      expect(await codeOf(service.list(null))).toBe("AUTH_UNAUTHENTICATED");
      expect(await codeOf(service.listCustomers(warehouse, {}))).toBe("AUTH_FORBIDDEN");
      expect(await codeOf(service.create(manager, fidel))).toBe("AUTH_FORBIDDEN");
      const group = await service.create(owner, fidel);
      expect(await codeOf(service.update(manager, group.id, { name: "Altceva" }))).toBe(
        "AUTH_FORBIDDEN",
      );
      expect(await codeOf(service.remove(manager, group.id))).toBe("AUTH_FORBIDDEN");
      const user = await customer(tx);
      expect(await codeOf(service.assign(support, user.id, group.id))).toBe("AUTH_FORBIDDEN");
      expect(await codeOf(service.assignBulk(support, [user.id], group.id))).toBe("AUTH_FORBIDDEN");
      expect(await codeOf(service.assign(warehouse, user.id, group.id))).toBe("AUTH_FORBIDDEN");
      // nimic nu s-a schimbat
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: user.id } })).customerGroupId,
      ).toBeNull();
      expect((await service.list(owner)).find((g) => g.id === group.id)?.name).toBe("Client fidel");
    });
  });
});

describe("grupurile: creare, editare, ștergere", () => {
  it("creează grupuri valide, cu slug unic și ordine", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { service, audit } = await world(tx);
      const a = await service.create(owner, fidel);
      const b = await service.create(owner, { ...fidel, name: "Client fidel" });
      expect(a).toMatchObject({ pricingType: "discount", discountBps: 500, isSystem: false });
      expect(b.slug).not.toBe(a.slug);
      expect(b.sortOrder).toBeGreaterThan(a.sortOrder);
      const p = await service.create(owner, partner);
      expect(p).toMatchObject({
        pricingType: "cost_plus",
        markupBps: 1200,
        earnsLoyaltyPoints: false,
      });
      expect(audit.for(a.id, "customerGroup.create")).toHaveLength(1);
    });
  });

  it("refuză combinații invalide și nu creează nimic", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { service } = await world(tx);
      const before = await tx.customerGroup.count();
      for (const bad of [
        { name: "X", pricingType: "discount" },
        { name: "X", pricingType: "cost_plus", discountBps: 5 },
        { name: "X", pricingType: "none", markupBps: 100 },
        { name: "X", pricingType: "discount", discountBps: 20_000 },
        { name: "X", pricingType: "cost_plus", markupBps: 100, stacksWithSalePrice: true },
        { name: "  ", pricingType: "none" },
        { name: "X", pricingType: "none", isSystem: true },
      ]) {
        expect(await codeOf(service.create(owner, bad))).toBe("CUSTOMER_GROUP_INVALID");
      }
      expect(await tx.customerGroup.count()).toBe(before);
    });
  });

  it("editarea validează grupul întreg: nu schimbi tipul fără procentul lui", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { service, audit } = await world(tx);
      const group = await service.create(owner, fidel);
      expect(await codeOf(service.update(owner, group.id, { pricingType: "cost_plus" }))).toBe(
        "CUSTOMER_GROUP_INVALID",
      );
      const changed = await service.update(owner, group.id, {
        pricingType: "cost_plus",
        discountBps: null,
        markupBps: 1700,
      });
      expect(changed).toMatchObject({
        pricingType: "cost_plus",
        markupBps: 1700,
        discountBps: null,
      });
      const rows = audit.for(group.id, "customerGroup.update");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.before).toMatchObject({ pricingType: "discount", discountBps: 500 });
      // fără modificare reală: niciun rând de audit nou
      await service.update(owner, group.id, { name: changed.name });
      expect(audit.for(group.id, "customerGroup.update")).toHaveLength(1);
    });
  });

  it("«Client standard»: se redenumește, dar nu se șterge, nu-și schimbă tipul și nu se dezactivează", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { service, system } = await world(tx);
      expect(await codeOf(service.remove(owner, system.id))).toBe("CUSTOMER_GROUP_SYSTEM");
      expect(
        await codeOf(
          service.update(owner, system.id, {
            pricingType: "discount",
            discountBps: 500,
          }),
        ),
      ).toBe("CUSTOMER_GROUP_SYSTEM");
      expect(await codeOf(service.update(owner, system.id, { isActive: false }))).toBe(
        "CUSTOMER_GROUP_SYSTEM",
      );
      const renamed = await service.update(owner, system.id, { name: "Clienți obișnuiți" });
      expect(renamed.name).toBe("Clienți obișnuiți");
      expect(renamed.isSystem).toBe(true);
    });
  });

  it("un grup cu clienți sau comenzi nu se șterge și nu se dezactivează; unul gol da", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { service } = await world(tx);
      const used = await service.create(owner, fidel);
      const user = await customer(tx);
      await service.assign(manager, user.id, used.id);
      expect(await codeOf(service.remove(owner, used.id))).toBe("CUSTOMER_GROUP_IN_USE");
      expect(await codeOf(service.update(owner, used.id, { isActive: false }))).toBe(
        "CUSTOMER_GROUP_HAS_MEMBERS",
      );
      const empty = await service.create(owner, { ...fidel, name: "Gol" });
      expect((await service.update(owner, empty.id, { isActive: false })).isActive).toBe(false);
      await service.remove(owner, empty.id);
      expect(await tx.customerGroup.findUnique({ where: { id: empty.id } })).toBeNull();
      expect(await codeOf(service.remove(owner, "nu-exista"))).toBe("CUSTOMER_GROUP_NOT_FOUND");
    });
  });

  it("list: numărul de clienți per grup", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { service } = await world(tx);
      const group = await service.create(owner, fidel);
      const users = [await customer(tx), await customer(tx), await customer(tx)];
      await service.assignBulk(
        manager,
        users.map((u) => u.id),
        group.id,
      );
      const row = (await service.list(support)).find((g) => g.id === group.id);
      expect(row?.memberCount).toBe(3);
      expect(row?.orderCount).toBe(0);
    });
  });
});

describe("atribuirea clienților în grup", () => {
  it("individual: mută, scoate din grup și scrie audit fără email sau nume", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { service, audit } = await world(tx);
      const group = await service.create(owner, partner);
      const user = await customer(tx);
      const first = await service.assign(manager, user.id, group.id);
      expect(first.previousGroupId).toBeNull();
      expect((await tx.user.findUniqueOrThrow({ where: { id: user.id } })).customerGroupId).toBe(
        group.id,
      );
      const second = await service.assign(manager, user.id, null);
      expect(second.previousGroupId).toBe(group.id);
      expect(
        (await tx.user.findUniqueOrThrow({ where: { id: user.id } })).customerGroupId,
      ).toBeNull();
      const rows = audit.rows.filter((r) => r.action === "customer.group.assign");
      expect(rows).toHaveLength(2);
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain(user.email);
      expect(dump).not.toContain(user.name);
      expect(dump).toContain(user.id);
    });
  });

  it("în masă: toți sau niciunul, un singur rând de audit cu numărul și identificatorii", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { service, audit } = await world(tx);
      const group = await service.create(owner, fidel);
      const other = await service.create(owner, partner);
      const users = [await customer(tx), await customer(tx), await customer(tx)];
      await service.assign(manager, users[0]!.id, other.id);
      const out = await service.assignBulk(
        manager,
        users.map((u) => u.id),
        group.id,
      );
      expect(out.moved).toHaveLength(3);
      expect(out.missing).toEqual([]);
      const rows = audit.rows.filter((r) => r.action === "customer.group.assign_bulk");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.after).toMatchObject({ groupId: group.id, userCount: 3 });
      expect(rows[0]?.before).toEqual({ previousGroups: { [other.id]: 1, none: 2 } });
      // niciun email sau nume de CLIENT (actorLabel e personalul care a făcut acțiunea)
      for (const u of users) {
        expect(JSON.stringify(rows)).not.toContain(u.email);
        expect(JSON.stringify(rows)).not.toContain(u.name);
      }
    });
  });

  it("refuză: listă goală, peste limită, grup inexistent sau dezactivat; id-urile necunoscute se raportează", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { service } = await world(tx);
      const group = await service.create(owner, fidel);
      const user = await customer(tx);
      expect(await codeOf(service.assignBulk(manager, [], group.id))).toBe("CUSTOMER_ASSIGN_EMPTY");
      expect(
        await codeOf(
          service.assignBulk(
            manager,
            Array.from({ length: 501 }, (_, i) => `x${i}`),
            group.id,
          ),
        ),
      ).toBe("CUSTOMER_ASSIGN_TOO_MANY");
      expect(await codeOf(service.assignBulk(manager, [user.id], "nu-exista"))).toBe(
        "CUSTOMER_GROUP_NOT_FOUND",
      );
      const out = await service.assignBulk(manager, [user.id, "fantoma"], group.id);
      expect(out.missing).toEqual(["fantoma"]);
      expect(await codeOf(service.assign(manager, "fantoma", group.id))).toBe("CUSTOMER_NOT_FOUND");
      const inactive = await service.create(owner, { ...fidel, name: "Inactiv" });
      await service.update(owner, inactive.id, { isActive: false });
      expect(await codeOf(service.assign(manager, user.id, inactive.id))).toBe(
        "CUSTOMER_GROUP_INACTIVE",
      );
      // grupul clientului nu s-a schimbat la refuzuri
      expect((await tx.user.findUniqueOrThrow({ where: { id: user.id } })).customerGroupId).toBe(
        group.id,
      );
    });
  });
});

describe("lista clienților", () => {
  it("emailul e mascat fără customers.read_pii; căutarea după email nu e un oracol", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { service } = await world(tx);
      const withPii = subjectFor("support");
      const withoutPii: PermissionSubject = {
        ...subjectFor("support"),
        permissions: new Set(["admin.access", "customers.read"]),
      };
      const user = await customer(tx, {
        email: `ion.popescu-${uid()}@exemplu.ro`,
        name: "Ion Popescu",
      });
      const seen = await service.listCustomers(withPii, { query: user.email });
      expect(seen.rows.map((r) => r.id)).toContain(user.id);
      expect(seen.rows.find((r) => r.id === user.id)?.email).toBe(user.email);
      const masked = await service.listCustomers(withoutPii, { query: user.email });
      expect(masked.rows.map((r) => r.id)).not.toContain(user.id);
      const byName = await service.listCustomers(withoutPii, { query: "Ion Popescu" });
      const row = byName.rows.find((r) => r.id === user.id);
      expect(row?.email).toBe(maskEmail(user.email));
      expect(row?.email).not.toBe(user.email);
    });
  });

  it("filtrul de grup: «Client standard» include și clienții fără grup; personalul și conturile anonimizate nu apar", async () => {
    await inRolledBackTransaction(db, async (tx) => {
      const { service, system } = await world(tx);
      const group = await service.create(owner, fidel);
      const tag = uid();
      const none = await customer(tx, { name: `Nou ${tag}` });
      const inStandard = await customer(tx, {
        name: `Standard ${tag}`,
        customerGroupId: system.id,
      });
      const inFidel = await customer(tx, { name: `Fidel ${tag}`, customerGroupId: group.id });
      const anon = await customer(tx, { name: `Anon ${tag}`, anonymizedAt: new Date() });
      const staff = await customer(tx, { name: `Personal ${tag}` });
      const role = await tx.role.create({
        data: { key: `r_${uid()}`, name: "Rol", description: "x" },
      });
      await tx.userRole.create({ data: { userId: staff.id, roleId: role.id } });

      const ids = async (groupId?: string) =>
        (await service.listCustomers(owner, { query: tag, ...(groupId ? { groupId } : {}) })).rows
          .map((r) => r.id)
          .sort();
      expect(await ids()).toEqual([none.id, inStandard.id, inFidel.id].sort());
      expect(await ids(system.id)).toEqual([none.id, inStandard.id].sort());
      expect(await ids(group.id)).toEqual([inFidel.id]);
      expect(await ids()).not.toContain(anon.id);
      expect(await ids()).not.toContain(staff.id);
      const page = await service.listCustomers(owner, { query: tag, pageSize: 2, page: 2 });
      expect(page.total).toBe(3);
      expect(page.rows).toHaveLength(1);
    });
  });
});

describe("maskEmail", () => {
  it("ascunde restul adresei", () => {
    expect(maskEmail("ion.popescu@exemplu.ro")).toBe("i•••@e•••.ro");
    expect(maskEmail("fara-arond")).toBe("•••");
  });
});
