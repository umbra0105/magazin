/**
 * Scoate explicit o permisiune dintr-un rol: `pnpm rbac:revoke <rol> <permisiune> [--apply]`.
 * Fără `--apply` doar arată ce s-ar întâmpla (nu modifică nimic). Seed-ul NU scoate niciodată
 * permisiuni, deci când catalogul le retrage, scoaterea din baza existentă se face cu această comandă.
 * Scrie în jurnalul de audit. Efectul e imediat (permisiunile se citesc din DB la fiecare cerere).
 */
import { AuditService, createPrismaAuditStore } from "../src/audit";
import { revokeRolePermission } from "../src/rbac/revoke";
import { getDb, loadRootEnv } from "./_runtime";

loadRootEnv();

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const [roleKey, permissionKey] = args.filter((a) => !a.startsWith("--"));
if (!roleKey || !permissionKey) {
  console.error("Folosire: pnpm rbac:revoke <rol> <permisiune> [--apply]");
  console.error("Exemplu:  pnpm rbac:revoke support orders.refund --apply");
  process.exit(1);
}

const db = getDb();
try {
  const result = await revokeRolePermission(db, roleKey, permissionKey, apply);
  switch (result.status) {
    case "unknown-role":
      console.error(`Rolul "${roleKey}" nu există.`);
      process.exitCode = 1;
      break;
    case "unknown-permission":
      console.error(`Permisiunea "${permissionKey}" nu există în baza de date.`);
      process.exitCode = 1;
      break;
    case "not-granted":
      console.log(`Rolul "${roleKey}" nu are permisiunea "${permissionKey}". Nimic de făcut.`);
      break;
    case "would-remove":
      console.log(
        `SIMULARE: s-ar scoate "${permissionKey}" din rolul "${roleKey}" (${result.affectedUsers} utilizatori cu acest rol).`,
      );
      console.log("Nu am modificat nimic. Adaugă --apply ca să aplici.");
      break;
    case "removed":
      await new AuditService(createPrismaAuditStore(db)).record({
        actorId: "cli",
        actorLabel: "cli:rbac:revoke",
        action: "rbac.permission_revoked",
        entity: "role",
        entityId: roleKey,
        before: { permission: permissionKey, granted: true },
        after: { permission: permissionKey, granted: false },
      });
      console.log(
        `Scos "${permissionKey}" din rolul "${roleKey}" (${result.affectedUsers} utilizatori cu acest rol). Efect imediat.`,
      );
      break;
  }
  if (
    result.status !== "unknown-role" &&
    result.status !== "unknown-permission" &&
    result.stillInCatalog
  ) {
    console.warn(
      `ATENȚIE: "${permissionKey}" mai e în catalogul implicit al rolului "${roleKey}"; \`pnpm db:seed\` l-ar adăuga la loc.`,
    );
  }
} finally {
  await db.$disconnect();
}
