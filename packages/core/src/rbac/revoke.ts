import type { PrismaClient } from "@ecom/db";
import { DEFAULT_ROLES } from "./catalog";

export type RevokeStatus =
  "removed" | "would-remove" | "not-granted" | "unknown-role" | "unknown-permission";

export interface RevokeResult {
  status: RevokeStatus;
  /** Câți utilizatori au rolul (pierd permisiunea). */
  affectedUsers: number;
  /** `true` dacă permisiunea mai e în catalogul implicit al rolului: `pnpm db:seed` ar adăuga-o la loc. */
  stillInCatalog: boolean;
}

type Db = Pick<PrismaClient, "role" | "permission" | "rolePermission">;

const stillInCatalog = (roleKey: string, permissionKey: string): boolean =>
  DEFAULT_ROLES.some(
    (r) => r.key === roleKey && (r.permissions as readonly string[]).includes(permissionKey),
  );

/**
 * Seed-ul doar ADAUGĂ permisiuni (nu scoate niciodată una acordată). Când catalogul scoate o
 * permisiune dintr-un rol de sistem, scoaterea din baza existentă se face explicit, cu această
 * funcție (rulată din `pnpm rbac:revoke`). Fără `apply` doar raportează ce s-ar întâmpla.
 */
export async function revokeRolePermission(
  db: Db,
  roleKey: string,
  permissionKey: string,
  apply: boolean,
): Promise<RevokeResult> {
  const role = await db.role.findUnique({
    where: { key: roleKey },
    select: { id: true, _count: { select: { users: true } } },
  });
  const inCatalog = stillInCatalog(roleKey, permissionKey);
  if (!role) return { status: "unknown-role", affectedUsers: 0, stillInCatalog: inCatalog };
  const permission = await db.permission.findUnique({
    where: { key: permissionKey },
    select: { id: true },
  });
  if (!permission)
    return { status: "unknown-permission", affectedUsers: 0, stillInCatalog: inCatalog };

  const link = await db.rolePermission.findUnique({
    where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
  });
  if (!link) return { status: "not-granted", affectedUsers: 0, stillInCatalog: inCatalog };

  const affectedUsers = role._count.users;
  if (!apply) return { status: "would-remove", affectedUsers, stillInCatalog: inCatalog };
  await db.rolePermission.delete({
    where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
  });
  return { status: "removed", affectedUsers, stillInCatalog: inCatalog };
}
