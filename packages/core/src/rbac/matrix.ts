import { DEFAULT_ROLES, PERMISSIONS, PERMISSION_KEYS } from "./catalog";
import { OWNER_ROLE_KEY } from "./can";

export const RBAC_MATRIX_START = "<!-- rbac-matrix:start -->";
export const RBAC_MATRIX_END = "<!-- rbac-matrix:end -->";

/**
 * Matricea permisiune × rol ca tabel Markdown, generată din catalog (sursa de adevăr).
 * `docs/04-backend-admin.md` §6 o conține între marcajele de mai sus; un test pică dacă diferă.
 */
export function renderRoleMatrix(): string {
  const header = ["Permisiune", ...DEFAULT_ROLES.map((r) => r.name)];
  const lines = [
    `| ${header.join(" | ")} |`,
    `|${header.map((_, i) => (i === 0 ? "---" : ":---:")).join("|")}|`,
  ];
  for (const key of PERMISSION_KEYS) {
    const cells = DEFAULT_ROLES.map((role) =>
      role.key === OWNER_ROLE_KEY || role.permissions.includes(key) ? "✓" : "",
    );
    lines.push(`| \`${key}\` — ${PERMISSIONS[key]} | ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}
