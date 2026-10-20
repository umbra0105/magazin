import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { ageE2eSessions, promoteE2eUser } from "../packages/core/test/e2e-support";
import { extractTokenLink, waitForEmail } from "./support/mailpit";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Cap-coadă Faza 2, într-un singur parcurs ca al unui om: un vizitator își face cont (încercând să
 * își atribuie singur rolul de Owner), confirmă emailul, se autentifică, nu intră în admin; apoi
 * primește rolul de Suport și intră doar în ce are voie; la deconectare pierde accesul.
 * Parola se generează la fiecare rulare; contul `e2e-*@example.test` se șterge la final.
 */
// Același motiv ca în `media.spec.ts`: la rece durează ~1,3 min singur, aproape de limita de 90 s.
test.setTimeout(180_000);

test("Faza 2 cap-coadă: înregistrare → email → login → fără admin → rol Suport → doar ce are voie → logout → sesiune expirată", async ({
  page,
  request,
  baseURL,
}) => {
  const email = `e2e-${randomBytes(5).toString("hex")}@example.test`;
  const password = randomBytes(18).toString("base64url");
  const origin = baseURL as string;

  // 1. Înregistrare cu câmpuri de rol injectate: serverul trebuie să le ignore.
  const signUp = await request.post(`${origin}/api/auth/sign-up/email`, {
    headers: { origin },
    data: { name: "Vizitator E2E", email, password, role: "owner", roles: ["owner"] },
  });
  await expectResponseOk(signUp, "înregistrarea contului de test");

  // 2. Înainte de confirmarea emailului, autentificarea e refuzată.
  await page.goto("/autentificare");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Parolă", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Intră în cont" }).click();
  await expect(page.locator("main [role=alert]")).toContainText("Emailul nu este verificat");

  // 3. Emailul de confirmare (coadă → worker → SMTP → Mailpit); linkul se confirmă din buton.
  const message = await waitForEmail(email, { subject: /^Confirmă adresa de email – / });
  await page.goto(extractTokenLink(message.text));
  await page.getByRole("button", { name: "Confirmă adresa de email" }).click();
  await expect(page.getByRole("heading", { name: "Email verificat" })).toBeVisible();

  // 4. Autentificare: ajunge în contul de client; /admin îi e interzis (rolul „owner” injectat nu a contat).
  await page.goto("/autentificare?next=%2Fcont");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Parolă", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Intră în cont" }).click();
  await page.waitForURL((url) => url.pathname === "/cont");
  await page.goto("/admin");
  await expect(page.getByRole("heading", { level: 1, name: "Acces interzis" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Navigare principală" })).toHaveCount(0);

  // 5. Primește rolul Suport (ca din „Utilizatori și roluri”): intră, dar doar în ce are voie.
  await promoteE2eUser(email, "support");
  await page.goto("/admin");
  const sidebar = page.getByRole("navigation", { name: "Navigare principală" });
  await expect(page.getByRole("heading", { level: 1, name: "Panou de control" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Comenzi" })).toBeVisible();
  await expect(sidebar.getByRole("link", { name: "Setări" })).toHaveCount(0);
  await page.goto("/admin/setari");
  await expect(page).toHaveURL(/\/admin\/acces-interzis$/);

  // 6. Deconectare: sesiunea dispare, /admin duce din nou la autentificare.
  await page.goto("/admin");
  await page.getByRole("button", { name: "Meniul utilizatorului" }).click();
  await page.getByRole("button", { name: "Deconectare" }).click();
  await expect(page).toHaveURL(/\/autentificare$/);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/autentificare/);

  // 7. Autentificat din nou, o sesiune de admin mai veche decât limita (8 ore) expiră.
  await page.goto("/autentificare?next=%2Fadmin");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Parolă", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Intră în cont" }).click();
  await page.waitForURL((url) => url.pathname === "/admin");
  expect(await ageE2eSessions(email, 9)).toBeGreaterThan(0);
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/autentificare\?sesiune=expirata/);
  await expect(page.locator("main [role=alert]")).toHaveText(
    "Sesiunea a expirat. Autentifică-te din nou.",
  );
});
