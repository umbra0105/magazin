import { z } from "zod";
import type { AuditService } from "../audit/audit-service";
import { slugify } from "../catalog/slug";
import { assertCan, can, type PermissionSubject } from "../rbac/can";
import { SYSTEM_GROUP_SLUG } from "./constants";
import type { customerGroupFields } from "./group-rules";
import {
  CustomerError,
  MAX_BULK_ASSIGN,
  validateGroupFields,
  type CustomerGroupFields,
  type CustomerGroupRecord,
} from "./group-rules";
import type {
  CustomerGroupStore,
  CustomerGroupWithUsage,
  CustomerListFilter,
} from "./customer-group-store";

/**
 * Grupurile de clienți (Faza 15, docs/09 §6) și atribuirea clienților în ele, prin servicii (nu în componente). Permisiuni:
 *  - lista grupurilor și a clienților: `customers.read` (emailul se vede doar cu `customers.read_pii`);
 *  - crearea, editarea și ștergerea grupurilor: `customers.groups.manage`;
 *  - mutarea clienților într-un grup (individual sau în masă): `customers.write`.
 * Atribuirea e MANUALĂ (nu există promovare automată). Auditul păstrează doar identificatori și numere, niciun email sau nume.
 */

const PAGE_SIZE_MAX = 100;

const listQuery = z.object({
  query: z.string().trim().max(120).optional(),
  groupId: z.string().min(1).max(40).optional(),
  page: z.number().int().min(1).max(100_000).default(1),
  pageSize: z.number().int().min(1).max(PAGE_SIZE_MAX).default(25),
});

export interface CustomerListItem {
  id: string;
  name: string;
  /** Mascat (`i•••@e•••.ro`) fără `customers.read_pii`. */
  email: string;
  emailVerified: boolean;
  createdAt: Date;
  /** `null` = fără grup atribuit (se comportă ca «Client standard»). */
  groupId: string | null;
}

export interface CustomerListPage {
  rows: CustomerListItem[];
  total: number;
  page: number;
  pageSize: number;
}

/** `ion.popescu@exemplu.ro` → `i•••@e•••.ro`: destul ca adminul fără drept la datele personale să distingă conturile. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "•••";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local.slice(0, 1)}•••@${host.slice(0, 1)}•••${tld}`;
}

export interface CustomerGroupServiceDeps {
  store: CustomerGroupStore;
  audit: AuditService;
}

const notFound = () =>
  new CustomerError("CUSTOMER_GROUP_NOT_FOUND", "Grupul de clienți nu există.");

export class CustomerGroupService {
  constructor(private readonly deps: CustomerGroupServiceDeps) {}

  /** Toate grupurile, cu numărul de clienți și de comenzi. Cere `customers.read`. */
  async list(subject: PermissionSubject | null): Promise<CustomerGroupWithUsage[]> {
    assertCan(subject, "customers.read");
    return this.deps.store.list();
  }

  async create(subject: PermissionSubject | null, input: unknown): Promise<CustomerGroupRecord> {
    assertCan(subject, "customers.groups.manage");
    const data = validateGroupFields(input);
    const slug = await this.uniqueSlug(data.name);
    const sortOrder = (await this.deps.store.maxSortOrder()) + 1;
    const created = await this.deps.store.create({ ...data, slug, sortOrder });
    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "customerGroup.create",
      entity: "customer_group",
      entityId: created.id,
      after: groupAudit(created),
    });
    return created;
  }

  async update(
    subject: PermissionSubject | null,
    id: string,
    input: unknown,
  ): Promise<CustomerGroupRecord> {
    assertCan(subject, "customers.groups.manage");
    const existing = await this.deps.store.get(id);
    if (!existing) throw notFound();
    const patch = z.record(z.string(), z.unknown()).parse(input);
    // combin cu ce există și validez ÎNTREGUL grup (tipul și procentele trebuie să se potrivească)
    const merged = validateGroupFields({
      name: existing.name,
      pricingType: existing.pricingType,
      discountBps: existing.discountBps,
      markupBps: existing.markupBps,
      stacksWithSalePrice: existing.stacksWithSalePrice,
      earnsLoyaltyPoints: existing.earnsLoyaltyPoints,
      tone: existing.tone,
      isActive: existing.isActive,
      ...patch,
    });
    if (existing.isSystem) {
      if (merged.pricingType !== "none") {
        throw new CustomerError(
          "CUSTOMER_GROUP_SYSTEM",
          "«Client standard» rămâne la prețul public: tipul lui nu se schimbă.",
        );
      }
      if (!merged.isActive) {
        throw new CustomerError(
          "CUSTOMER_GROUP_SYSTEM",
          "«Client standard» e grupul de sistem și nu se dezactivează.",
        );
      }
    }
    const changes = diffFields(existing, merged);
    if (Object.keys(changes.after).length === 0) return existing;

    let after: CustomerGroupRecord;
    if (changes.after["isActive"] === false) {
      const outcome = await this.deps.store.deactivateIfEmpty(id);
      if (outcome === "has_members") {
        throw new CustomerError(
          "CUSTOMER_GROUP_HAS_MEMBERS",
          "Grupul are clienți: mută-i întâi în alt grup, apoi îl poți dezactiva.",
        );
      }
      const rest: Record<string, unknown> = { ...changes.after };
      delete rest["isActive"];
      after =
        Object.keys(rest).length > 0
          ? await this.deps.store.update(id, rest as Partial<CustomerGroupFields>)
          : ((await this.deps.store.get(id)) as CustomerGroupRecord);
    } else {
      after = await this.deps.store.update(id, changes.after as Partial<CustomerGroupFields>);
    }
    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "customerGroup.update",
      entity: "customer_group",
      entityId: id,
      before: changes.before,
      after: changes.after,
    });
    return after;
  }

  async remove(subject: PermissionSubject | null, id: string): Promise<void> {
    assertCan(subject, "customers.groups.manage");
    const existing = await this.deps.store.get(id);
    if (!existing) throw notFound();
    if (existing.isSystem) {
      throw new CustomerError(
        "CUSTOMER_GROUP_SYSTEM",
        "«Client standard» e grupul de sistem și nu se șterge.",
      );
    }
    const outcome = await this.deps.store.deleteUnused(id);
    if (outcome === "in_use") {
      throw new CustomerError(
        "CUSTOMER_GROUP_IN_USE",
        "Grupul are clienți sau comenzi și nu se poate șterge. Dezactivează-l după ce muți clienții în alt grup.",
      );
    }
    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action: "customerGroup.delete",
      entity: "customer_group",
      entityId: id,
      before: groupAudit(existing),
    });
  }

  /** Lista clienților (cu căutare și filtru de grup). Cere `customers.read`; emailul doar cu `customers.read_pii`. */
  async listCustomers(
    subject: PermissionSubject | null,
    input: unknown,
  ): Promise<CustomerListPage> {
    assertCan(subject, "customers.read");
    const query = listQuery.parse(input ?? {});
    const seeEmails = can(subject, "customers.read_pii");
    const filter: CustomerListFilter = {
      query: query.query && query.query.length > 0 ? query.query : null,
      groupId: query.groupId ?? null,
      page: query.page,
      pageSize: query.pageSize,
      matchEmail: seeEmails,
    };
    const { rows, total } = await this.deps.store.listCustomers(filter);
    return {
      rows: rows.map((row) => ({ ...row, email: seeEmails ? row.email : maskEmail(row.email) })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** Mută UN client în grup (sau îl scoate din grup cu `null`). Cere `customers.write`. */
  async assign(
    subject: PermissionSubject | null,
    userId: string,
    groupId: string | null,
  ): Promise<{ previousGroupId: string | null }> {
    assertCan(subject, "customers.write");
    const result = await this.assignMany(subject, [userId], groupId, "customer.group.assign");
    const moved = result.moved[0];
    if (!moved) throw new CustomerError("CUSTOMER_NOT_FOUND", "Clientul nu există.");
    return { previousGroupId: moved.previousGroupId };
  }

  /** Mută mai mulți clienți într-un grup, atomic și cu un singur rând de audit. Cere `customers.write`. */
  async assignBulk(
    subject: PermissionSubject | null,
    userIds: readonly string[],
    groupId: string | null,
  ) {
    assertCan(subject, "customers.write");
    return this.assignMany(subject, userIds, groupId, "customer.group.assign_bulk");
  }

  private async assignMany(
    subject: PermissionSubject,
    userIds: readonly string[],
    groupId: string | null,
    action: string,
  ) {
    const ids = [...new Set(userIds)];
    if (ids.length === 0) {
      throw new CustomerError("CUSTOMER_ASSIGN_EMPTY", "Alege cel puțin un client.");
    }
    if (ids.length > MAX_BULK_ASSIGN) {
      throw new CustomerError(
        "CUSTOMER_ASSIGN_TOO_MANY",
        `Poți muta cel mult ${MAX_BULK_ASSIGN} de clienți odată.`,
        { max: MAX_BULK_ASSIGN },
      );
    }
    if (groupId !== null) {
      const group = await this.deps.store.get(groupId);
      if (!group) throw notFound();
    }
    const outcome = await this.deps.store.assign(ids, groupId);
    if (outcome === "group_inactive") {
      throw new CustomerError(
        "CUSTOMER_GROUP_INACTIVE",
        "Grupul e dezactivat: alege un grup activ.",
      );
    }
    const previous: Record<string, number> = {};
    for (const row of outcome.moved) {
      const key = row.previousGroupId ?? "none";
      previous[key] = (previous[key] ?? 0) + 1;
    }
    await this.deps.audit.record({
      actorId: subject.userId,
      actorLabel: subject.email,
      action,
      entity: "customer_group",
      entityId: groupId,
      before: { previousGroups: previous },
      after: {
        groupId,
        userCount: outcome.moved.length,
        userIds: outcome.moved.map((row) => row.userId),
      },
    });
    return outcome;
  }

  private async uniqueSlug(name: string): Promise<string> {
    const base = slugify(name, "grup") || "grup";
    let candidate = base === SYSTEM_GROUP_SLUG ? `${base}-2` : base;
    for (let n = 2; await this.deps.store.slugExists(candidate); n += 1) candidate = `${base}-${n}`;
    return candidate;
  }
}

/** Ce intră în audit despre un grup: câmpurile lui de preț și de comportament (nu sunt date personale și nu conțin costuri). */
function groupAudit(group: CustomerGroupRecord): Record<string, unknown> {
  return {
    name: group.name,
    pricingType: group.pricingType,
    discountBps: group.discountBps,
    markupBps: group.markupBps,
    stacksWithSalePrice: group.stacksWithSalePrice,
    earnsLoyaltyPoints: group.earnsLoyaltyPoints,
    isActive: group.isActive,
  };
}

function diffFields(
  existing: CustomerGroupRecord,
  next: ReturnType<typeof customerGroupFields.parse>,
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const keys = [
    "name",
    "pricingType",
    "discountBps",
    "markupBps",
    "stacksWithSalePrice",
    "earnsLoyaltyPoints",
    "tone",
    "isActive",
  ] as const;
  for (const key of keys) {
    const was = existing[key];
    const now = next[key] ?? null;
    if (was !== now) {
      before[key] = was;
      after[key] = now;
    }
  }
  return { before, after };
}
