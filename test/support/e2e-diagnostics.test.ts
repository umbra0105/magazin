import type { APIResponse } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { describeFailure, expectResponseOk, redactBody } from "../../e2e/support/diagnostics";

const fake = (status: number, body: string, statusText = ""): APIResponse =>
  ({
    ok: () => status >= 200 && status < 300,
    status: () => status,
    statusText: () => statusText,
    text: async () => body,
  }) as unknown as APIResponse;

describe("diagnosticul răspunsurilor API din E2E", () => {
  it("un răspuns reușit nu aruncă", async () => {
    await expect(expectResponseOk(fake(200, "{}"), "ceva")).resolves.toBeUndefined();
  });

  it("un răspuns eșuat spune ce s-a cerut, statusul și corpul", async () => {
    const response = fake(
      429,
      JSON.stringify({ code: "TOO_MANY_REQUESTS", message: "Prea multe" }),
      "Too Many Requests",
    );
    await expect(expectResponseOk(response, "înregistrarea contului de test")).rejects.toThrow(
      /înregistrarea contului de test: răspuns HTTP 429 Too Many Requests; corp: \{"code":"TOO_MANY_REQUESTS","message":"Prea multe"\}/,
    );
  });

  it("câmpurile sensibile din corpul JSON se ascund, oricât de adânc", () => {
    const body = JSON.stringify({
      user: { email: "a@b.test", password: "parola-secreta-123" },
      session: { token: "tok-abc", nested: { apiKey: "k-1", ok: true } },
      cookie: "sid=1",
      authorization: "Bearer xyz",
      message: "ok",
    });
    const out = redactBody(body);
    for (const secret of ["parola-secreta-123", "tok-abc", "k-1", "sid=1", "Bearer xyz"]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('"message":"ok"');
    expect(out).toContain("[ascuns]");
  });

  it("corpul care nu e JSON se redactează și el, pe șabloane", () => {
    const out = redactBody("eroare: password=parola123 token: abc-def cookie=sid9 restul rămâne");
    expect(out).not.toMatch(/parola123|abc-def|sid9/);
    expect(out).toContain("restul rămâne");
  });

  it("corpul lung se scurtează", () => {
    const out = redactBody("x".repeat(5000));
    expect(out.length).toBeLessThan(450);
    expect(out.endsWith("…")).toBe(true);
  });

  it("corp gol sau ilizibil nu strică mesajul", async () => {
    expect(await describeFailure(fake(500, ""), "cererea")).toMatch(/HTTP 500.*corp: \(gol\)/);
    const unreadable = {
      ok: () => false,
      status: () => 502,
      statusText: () => "",
      text: async () => {
        throw new Error("închis");
      },
    } as unknown as APIResponse;
    expect(await describeFailure(unreadable, "cererea")).toMatch(/HTTP 502.*nu a putut fi citit/);
  });
});
