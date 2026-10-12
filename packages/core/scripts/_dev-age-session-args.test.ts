import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseAgeSessionArgs } from "./_dev-age-session-args";

describe("dev:age-session — argumente și gardă", () => {
  it("acceptă email + ore în dezvoltare", () => {
    expect(parseAgeSessionArgs(["Admin@Magazin.test", "9"], {})).toEqual({
      ok: true,
      email: "admin@magazin.test",
      hours: 9,
    });
  });

  it("refuză în producție, indiferent de argumente", () => {
    for (const env of [{ NODE_ENV: "production" }, { APP_ENV: "production" }]) {
      expect(parseAgeSessionArgs(["a@b.test", "9"], env)).toMatchObject({ ok: false });
    }
  });

  it("refuză argumente lipsă, în plus, email invalid sau ore invalide", () => {
    for (const argv of [[], ["a@b.test"], ["a@b.test", "9", "x"], ["nu-email", "9"]]) {
      expect(parseAgeSessionArgs(argv, {})).toMatchObject({ ok: false });
    }
    for (const hours of ["0", "-1", "abc", "9999"]) {
      expect(parseAgeSessionArgs(["a@b.test", hours], {})).toMatchObject({ ok: false });
    }
  });
  it("scriptul modifică doar createdAt al sesiunilor și nu atinge credențiale", () => {
    const script = readFileSync(new URL("./dev-age-session.ts", import.meta.url), "utf8");
    const writes = [
      ...script.matchAll(/\.(\w+)\.(updateMany|update|create|upsert|delete\w*)\(/g),
    ].map((m) => m[0]);
    expect(writes).toEqual([".session.updateMany("]);
    expect(script).toContain("data: { createdAt }");
    expect(script).not.toMatch(/password|passwd|secret|apiKey/i);
  });
});
