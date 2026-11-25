import {
  CustomerGroupService,
  createPrismaCustomerGroupStore,
  type CustomerGroupWithUsage,
} from "@ecom/core";
import { getDb } from "@ecom/db";
import { getAudit } from "./admin-writes";

const globalForCustomers = globalThis as unknown as { __ecomCustomerGroups?: CustomerGroupService };

/** Grupurile de clienți și atribuirea lor (Faza 15). Un singur serviciu per proces; permisiunile se verifică în serviciu. */
export function getCustomerGroupService(): CustomerGroupService {
  globalForCustomers.__ecomCustomerGroups ??= new CustomerGroupService({
    store: createPrismaCustomerGroupStore(getDb()),
    audit: getAudit(),
  });
  return globalForCustomers.__ecomCustomerGroups;
}

export type { CustomerGroupWithUsage };
