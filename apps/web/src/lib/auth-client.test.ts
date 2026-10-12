import { describe, expect, it } from "vitest";
import { getMessages } from "@/messages";
import { authErrorMessage, authPost, type AuthResult } from "./auth-client";

const m = getMessages().auth;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string>) },
    ...init,
  });

describe("authPost", () => {
  it("trimite POST JSON cu datele în corp, niciodată în URL", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const result = await authPost(
      "/api/auth/sign-in/email",
      { email: "a@x.test", password: "parola-secreta-12" },
      async (url, init) => {
        seen = { url, init };
        return json({ ok: true });
      },
    );
    expect(result).toEqual({ ok: true });
    expect(seen?.url).toBe("/api/auth/sign-in/email");
    expect(seen?.url).not.toMatch(/[?&=]|parola|a@x/);
    expect(seen?.init?.method).toBe("POST");
    expect(seen?.init?.body).toBe(
      JSON.stringify({ email: "a@x.test", password: "parola-secreta-12" }),
    );
  });

  it("citește codul de eroare și Retry-After din 429", async () => {
    const result = await authPost("/x", {}, async () =>
      json({ code: "AUTH_RATE_LIMITED" }, { status: 429, headers: { "retry-after": "840" } }),
    );
    expect(result).toEqual({
      ok: false,
      status: 429,
      code: "AUTH_RATE_LIMITED",
      retryAfterSeconds: 840,
    });
  });

  it("eroare de rețea => NETWORK_ERROR; corp non-JSON => cod gol", async () => {
    expect(
      await authPost("/x", {}, async () => {
        throw new TypeError("fetch failed");
      }),
    ).toMatchObject({ ok: false, status: 0, code: "NETWORK_ERROR" });
    expect(
      await authPost("/x", {}, async () => new Response("<html>", { status: 502 })),
    ).toMatchObject({ ok: false, status: 502, code: "", retryAfterSeconds: null });
  });
});

const fail = (code: string, status = 401, retryAfterSeconds: number | null = null): AuthResult => ({
  ok: false,
  status,
  code,
  retryAfterSeconds,
});
const asFail = (r: AuthResult) => r as Extract<AuthResult, { ok: false }>;

describe("authErrorMessage", () => {
  it("credențiale greșite: același mesaj, în română, fără detalii despre cont", () => {
    const message = authErrorMessage(asFail(fail("INVALID_EMAIL_OR_PASSWORD")), "login", m);
    expect(message).toBe("Email sau parolă incorecte.");
    expect(message).not.toMatch(/există|inexistent|blocat|parola e greșită/i);
  });

  it("429: spune în română peste câte minute poate reîncerca (rotunjit în sus)", () => {
    const at = (s: number | null) => authErrorMessage(asFail(fail("", 429, s)), "login", m);
    expect(at(840)).toBe("Prea multe încercări. Poți încerca din nou peste 14 minute.");
    expect(at(61)).toContain("peste 2 minute");
    expect(at(60)).toContain("peste 1 minut.");
    expect(at(1)).toContain("peste 1 minut.");
    expect(at(null)).toBe("Prea multe încercări. Încearcă din nou mai târziu.");
  });

  it("429 are prioritate chiar dacă lipsește codul din corp", () => {
    expect(authErrorMessage(asFail(fail("", 429, 120)), "register", m)).toContain("2 minute");
  });

  it("email neverificat, token invalid, rețea și necunoscut", () => {
    expect(authErrorMessage(asFail(fail("EMAIL_NOT_VERIFIED", 403)), "login", m)).toBe(
      m.login.emailNotVerified,
    );
    expect(authErrorMessage(asFail(fail("INVALID_TOKEN", 400)), "reset", m)).toBe(
      m.reset.invalidToken,
    );
    expect(authErrorMessage(asFail(fail("NETWORK_ERROR", 0)), "login", m)).toBe(
      m.common.networkError,
    );
    expect(authErrorMessage(asFail(fail("CEVA_NOU", 500)), "login", m)).toBe(m.common.genericError);
  });

  it("niciun mesaj nu cere sau afișează date din răspunsul serverului (doar texte din traduceri)", () => {
    const sample = authErrorMessage(asFail(fail("INVALID_EMAIL_OR_PASSWORD")), "login", m);
    expect(Object.values(m.login)).toContain(sample);
  });
});
