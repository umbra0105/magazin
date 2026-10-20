import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  expireE2eVerificationToken,
  isE2eUserVerified,
  promoteE2eUser,
} from "../packages/core/test/e2e-support";
import { expectNoEmail, extractTokenLink, waitForEmail } from "./support/mailpit";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Fluxurile cu email, cap-coadă: aplicația pune emailul în coadă (BullMQ), workerul îl trimite prin
 * SMTP la Mailpit, iar testul citește mesajul din Mailpit și urmează linkul. Parolele se generează
 * la fiecare rulare; conturile `e2e-*@example.test` se șterg la final.
 */

const uniqueEmail = () => `e2e-${randomBytes(5).toString("hex")}@example.test`;
const newPassword = () => randomBytes(18).toString("base64url");

async function verifiedAccount(request: APIRequestContext, baseURL: string) {
  const email = uniqueEmail();
  const password = newPassword();
  const response = await request.post(`${baseURL}/api/auth/sign-up/email`, {
    headers: { origin: baseURL },
    data: { name: "Cont E2E", email, password },
  });
  await expectResponseOk(response, "înregistrarea contului de test");
  await promoteE2eUser(email, null);
  return { email, password };
}

async function loginAs(page: Page, email: string, password: string) {
  await page.goto("/autentificare");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Parolă", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Intră în cont" }).click();
}

async function register(page: Page, email: string, password: string) {
  await page.goto("/inregistrare");
  await page.getByLabel("Nume").fill("Client E2E");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Parolă", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Creează contul" }).click();
  await expect(page.getByText("Verifică-ți emailul")).toBeVisible();
}

test.describe("verificarea emailului", () => {
  test("înregistrare → email → link → cont verificat → login; linkul nu mai merge a doua oară", async ({
    page,
  }) => {
    const email = uniqueEmail();
    const password = newPassword();

    // Urmărim toate cererile: tokenul nu are voie să apară în nicio adresă trimisă serverului.
    const requestedUrls: string[] = [];
    const referers: string[] = [];
    page.on("request", (r) => {
      requestedUrls.push(r.url());
      const referer = r.headers()["referer"];
      if (referer) referers.push(referer);
    });

    await register(page, email, password);

    // Înainte de confirmare, autentificarea e refuzată cu mesaj clar.
    await loginAs(page, email, password);
    await expect(page.locator("main [role=alert]")).toContainText("Emailul nu este verificat");

    const message = await waitForEmail(email, { subject: /^Confirmă adresa de email – / });
    expect(message.subject).toMatch(/^Confirmă adresa de email – /);
    expect(message.text).toContain("24 de ore");
    expect(message.text).toContain("o singură dată");
    const link = extractTokenLink(message.text);
    expect(new URL(link).pathname).toBe("/verificare-email");
    const token = new URL(link).hash.replace(/^#token=/, "");
    expect(token.length).toBeGreaterThan(30);

    await page.goto(link);
    await expect(page.getByRole("heading", { name: "Confirmă adresa de email" })).toBeVisible();
    // Fragmentul a fost scos din adresa vizibilă.
    expect(page.url()).not.toContain("token");
    await page.getByRole("button", { name: "Confirmă adresa de email" }).click();
    await expect(page.getByRole("heading", { name: "Email verificat" })).toBeVisible();
    expect(await isE2eUserVerified(email)).toBe(true);

    // Cont verificat → login.
    await loginAs(page, email, password);
    await page.waitForURL((url) => url.pathname === "/cont");

    // Linkul folosit nu mai merge.
    await page.goto(link);
    await page.getByRole("button", { name: "Confirmă adresa de email" }).click();
    await expect(page.locator("main [role=alert]")).toContainText(
      "expirat sau a fost deja folosit",
    );

    // Tokenul nu a ajuns niciodată în adresa unei cereri către server, nici în Referer.
    for (const url of requestedUrls) expect(url, url).not.toContain(token);
    for (const referer of referers) expect(referer, referer).not.toContain(token);
  });

  test("link expirat: mesaj clar și posibilitatea de a cere altul", async ({ page }) => {
    const email = uniqueEmail();
    await register(page, email, newPassword());

    const link = extractTokenLink(
      (await waitForEmail(email, { subject: /^Confirmă adresa de email – / })).text,
    );
    expect(await expireE2eVerificationToken(email)).toBe(1);

    await page.goto(link);
    await page.getByRole("button", { name: "Confirmă adresa de email" }).click();
    await expect(page.locator("main [role=alert]")).toContainText(
      "expirat sau a fost deja folosit",
    );
    expect(await isE2eUserVerified(email)).toBe(false);
    await expect(page.getByRole("button", { name: "Trimite mesajul de verificare" })).toBeVisible();
  });

  test("link incomplet (fără token): mesaj clar", async ({ page }) => {
    await page.goto("/verificare-email");
    await expect(page.locator("main [role=alert]")).toContainText("incomplet");
  });
});

test.describe("limitarea confirmării emailului", () => {
  test("după 10 încercări de pe același IP, a 11-a primește 429 cu Retry-After; alt IP nu e afectat", async ({
    request,
    baseURL,
  }) => {
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    const attempt = (forwardedFor: string) =>
      request.post(`${baseURL}/api/verify-email`, {
        headers: { origin: baseURL as string, "x-forwarded-for": forwardedFor },
        data: { token: randomBytes(32).toString("base64url") },
      });

    for (let i = 0; i < 10; i++) expect((await attempt(ip)).status()).toBe(400);
    const limited = await attempt(ip);
    expect(limited.status()).toBe(429);
    expect(Number(limited.headers()["retry-after"])).toBeGreaterThan(0);
    expect((await limited.json()).code).toBe("AUTH_RATE_LIMITED");

    expect((await attempt("203.0.113.77")).status()).toBe(400);
  });
});

test.describe("resetarea parolei", () => {
  test("am uitat parola → email → resetare → login cu parola nouă; linkul nu mai merge", async ({
    page,
    request,
    baseURL,
  }) => {
    const account = await verifiedAccount(request, baseURL as string);
    const requestedUrls: string[] = [];
    page.on("request", (r) => requestedUrls.push(r.url()));

    await page.goto("/recuperare-parola");
    await page.getByLabel("Email").fill(account.email);
    await page.getByRole("button", { name: "Trimite instrucțiunile" }).click();
    await expect(
      page.getByText("Dacă există un cont cu această adresă de email, am trimis instrucțiunile"),
    ).toBeVisible();

    // Contul a primit deja emailul de verificare la înregistrare: îl cerem pe cel de resetare.
    const message = await waitForEmail(account.email, { subject: /^Resetarea parolei – / });
    expect(message.subject).toMatch(/^Resetarea parolei – /);
    expect(message.text).toContain("1 oră");
    const link = extractTokenLink(message.text);
    expect(new URL(link).pathname).toBe("/resetare-parola");
    const token = new URL(link).hash.replace(/^#token=/, "");

    await page.goto(link);
    await expect(page.getByLabel("Parolă nouă")).toBeVisible();
    expect(page.url()).not.toContain("token");
    const fresh = newPassword();
    await page.getByLabel("Parolă nouă").fill(fresh);
    await page.getByRole("button", { name: "Schimbă parola" }).click();
    await expect(page.getByText("Parola a fost schimbată")).toBeVisible();

    // Parola nouă merge, cea veche nu.
    await loginAs(page, account.email, account.password);
    await expect(page.locator("main [role=alert]")).toHaveText("Email sau parolă incorecte.");
    await loginAs(page, account.email, fresh);
    await page.waitForURL((url) => url.pathname === "/cont");

    // Linkul folosit nu mai merge.
    await page.goto(link);
    await page.getByLabel("Parolă nouă").fill(newPassword());
    await page.getByRole("button", { name: "Schimbă parola" }).click();
    await expect(page.locator("main [role=alert]")).toContainText(
      "expirat sau a fost deja folosit",
    );

    for (const url of requestedUrls) expect(url, url).not.toContain(token);
  });

  test("email inexistent: același mesaj ca pentru unul real și niciun email trimis", async ({
    page,
  }) => {
    const ghost = uniqueEmail();
    await page.goto("/recuperare-parola");
    await page.getByLabel("Email").fill(ghost);
    await page.getByRole("button", { name: "Trimite instrucțiunile" }).click();
    await expect(
      page.getByText("Dacă există un cont cu această adresă de email, am trimis instrucțiunile"),
    ).toBeVisible();
    await expectNoEmail(ghost, 4000);
  });

  test("resetare fără token în adresă: mesaj clar și link spre recuperare", async ({ page }) => {
    await page.goto("/resetare-parola");
    await expect(page.locator("main [role=alert]")).toContainText("incomplet");
    await expect(page.getByRole("link", { name: "Cere un link nou" })).toBeVisible();
  });
});
