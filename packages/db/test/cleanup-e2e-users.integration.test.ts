import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupE2eUsers } from "./cleanup-e2e-users";

const url = process.env["DATABASE_URL"];

describe("cleanupE2eUsers", () => {
  const client = new Client({ connectionString: url });
  const suffix = randomUUID().slice(0, 8);
  const e2eEmail = `e2e-cleanup-${suffix}@example.test`;
  const realEmail = `cleanup-keep-${suffix}@example.com`;

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await client.query(`delete from "user" where email = $1`, [realEmail]);
    await client.end();
  });

  async function insertUser(id: string, email: string): Promise<void> {
    await client.query(
      `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
       values ($1, $2, $3, false, now(), now())`,
      [id, "Test", email],
    );
  }

  it("șterge conturile e2e-* și le lasă pe celelalte", async () => {
    await insertUser(`u-${suffix}-a`, e2eEmail);
    await insertUser(`u-${suffix}-b`, realEmail);

    const removed = await cleanupE2eUsers(url);
    expect(removed).toBeGreaterThanOrEqual(1);

    const left = await client.query(`select email from "user" where email = any($1)`, [
      [e2eEmail, realEmail],
    ]);
    expect(left.rows.map((r: { email: string }) => r.email)).toEqual([realEmail]);
  });

  it("refuză o bază fără „test” în nume", async () => {
    await expect(cleanupE2eUsers("postgres://u:p@localhost:5432/ecom")).rejects.toThrow();
  });
});
