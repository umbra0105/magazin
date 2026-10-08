import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "./index";

describe("schema DB", () => {
  afterAll(async () => {
    await getDb().$disconnect();
  });

  it("are toate tabelele din migrația inițială", async () => {
    const rows = await getDb().$queryRaw<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public'`;
    const names = rows.map((r) => r.table_name);
    for (const t of [
      "user",
      "session",
      "account",
      "verification",
      "setting",
      "branding",
      "feature_flag",
      "integration",
      "audit_log",
      "role",
      "permission",
      "role_permission",
      "user_role",
    ]) {
      expect(names).toContain(t);
    }
  });
});
