import type { PrismaClient } from "@ecom/db";
import type { PermissionSubject } from "./can";

/**
 * Încarcă rolurile și permisiunile unui utilizator direct din DB, la fiecare cerere (fără cache):
 * dacă un admin îi schimbă rolul cuiva, schimbarea se aplică imediat, nu după expirarea unui cache.
 */
export class PermissionService {
  constructor(private readonly db: Pick<PrismaClient, "user">) {}

  async loadSubject(userId: string): Promise<PermissionSubject | null> {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        roles: {
          select: {
            role: {
              select: {
                key: true,
                permissions: { select: { permission: { select: { key: true } } } },
              },
            },
          },
        },
      },
    });
    if (!user) return null;
    const roles = user.roles.map((r) => r.role.key);
    const permissions = new Set(
      user.roles.flatMap((r) => r.role.permissions.map((p) => p.permission.key)),
    );
    return { userId: user.id, email: user.email, roles, permissions };
  }
}
