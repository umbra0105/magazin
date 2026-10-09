import type { Prisma, PrismaClient } from "@ecom/db";
import { configFromPreset, DEFAULT_PRESET } from "../branding/presets";
import { brandingConfigSchema } from "../branding/tokens";
import { FEATURE_FLAGS, FEATURE_KEYS } from "../features/registry";
import { DEFAULT_ROLES, PERMISSIONS, PERMISSION_KEYS } from "../rbac/catalog";
import { getSettingSchema, listSettingKeys } from "../settings/registry";

/** Delegatul de DB al seed-ului: un PrismaClient sau clientul unei tranzacții. */
export type SeedDb = Omit<
  PrismaClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends"
>;

export interface BaseSeedResult {
  permissions: number;
  roles: number;
  rolePermissions: number;
  settings: number;
  featureFlags: number;
  brandingCreated: boolean;
}

/**
 * Seed-ul de PACHET: valori neutre, identice la orice instalare. Este IDEMPOTENT și NEDISTRUCTIV:
 * rulat de mai multe ori nu creează duplicate și nu suprascrie nimic ce s-a schimbat din admin
 * (setări, flag-uri, branding). Roluri: se adaugă doar permisiunile lipsă, niciodată nu se scot.
 *
 * Nu creează utilizatori și nu conține parole: contul de administrator vine cu autentificarea
 * (Promptul 3). Grupurile de clienți nu sunt aici (tabela vine în Faza 15, iar grupurile
 * specifice magazinului stau în `seed-store.ts`).
 *
 * Primește un client (sau tranzacție) deja deschis; nu deschide conexiuni și nu atinge Redis.
 */
export async function runBaseSeed(db: SeedDb): Promise<BaseSeedResult> {
  const permissions = await db.permission.createMany({
    data: PERMISSION_KEYS.map((key) => ({ key, description: PERMISSIONS[key] })),
    skipDuplicates: true,
  });

  const roles = await db.role.createMany({
    data: DEFAULT_ROLES.map(({ key, name, description }) => ({
      key,
      name,
      description,
      isSystem: true,
    })),
    skipDuplicates: true,
  });

  const [roleRows, permissionRows] = await Promise.all([
    db.role.findMany({ where: { key: { in: DEFAULT_ROLES.map((r) => r.key) } } }),
    db.permission.findMany({ where: { key: { in: PERMISSION_KEYS } } }),
  ]);
  const roleId = new Map(roleRows.map((r) => [r.key, r.id]));
  const permissionId = new Map(permissionRows.map((p) => [p.key, p.id]));
  const rolePermissions = await db.rolePermission.createMany({
    data: DEFAULT_ROLES.flatMap((role) =>
      role.permissions.map((permission) => ({
        roleId: roleId.get(role.key) as string,
        permissionId: permissionId.get(permission) as string,
      })),
    ),
    skipDuplicates: true,
  });

  const settings = await db.setting.createMany({
    data: listSettingKeys().map(({ key, group }) => ({
      key,
      group,
      // `parse(undefined)` aplică valoarea implicită neutră din registru.
      value: getSettingSchema(key)?.parse(undefined) as Prisma.InputJsonValue,
    })),
    skipDuplicates: true,
  });

  const featureFlags = await db.featureFlag.createMany({
    data: FEATURE_KEYS.map((key) => ({
      key,
      enabled: false,
      description: FEATURE_FLAGS[key],
    })),
    skipDuplicates: true,
  });

  let brandingCreated = false;
  if (!(await db.branding.findUnique({ where: { id: "default" } }))) {
    const config = brandingConfigSchema.parse(configFromPreset(DEFAULT_PRESET));
    await db.branding.create({
      data: {
        id: "default",
        preset: config.preset,
        colors: config.colors,
        fonts: config.fonts,
        radius: config.radius,
        darkMode: config.darkMode,
        logoUrl: config.logoUrl,
        faviconUrl: config.faviconUrl,
        ogImageUrl: config.ogImageUrl,
      },
    });
    brandingCreated = true;
  }

  return {
    permissions: permissions.count,
    roles: roles.count,
    rolePermissions: rolePermissions.count,
    settings: settings.count,
    featureFlags: featureFlags.count,
    brandingCreated,
  };
}
