import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { promoteE2eUser } from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Tema adminului la prima afișare după autentificare (mini-faza `prisma-join-tema`). Raport: meniul contului arăta «Luminos»
 * evidențiat, dar interfața era ÎNTUNECATĂ. Verificarea se face FĂRĂ reîncărcare: autentificarea duce la admin printr-o navigare
 * pe client, iar scriptul inline din layout nu rulează la o navigare pe client. Sistemul de operare e emulat în mod întunecat.
 * Regula: ce e evidențiat în meniu = ce se vede.
 */
const THEME_KEY = "ecom-admin-theme";

interface Account {
  email: string;
  password: string;
}

async function createOwner(request: APIRequestContext, baseURL: string): Promise<Account> {
  const email = `e2e-${randomBytes(5).toString("hex")}@example.test`;
  const password = randomBytes(18).toString("base64url");
  const response = await request.post(`${baseURL}/api/auth/sign-up/email`, {
    headers: { origin: baseURL, "x-forwarded-for": uniqueClientIp() },
    data: { name: "Cont E2E", email, password },
  });
  await expectResponseOk(response, "înregistrarea contului de test");
  await promoteE2eUser(email, "owner");
  return { email, password };
}

/** Autentificare fără reîncărcare după: pagina de autentificare, apoi navigarea pe client spre admin. */
async function signInToAdmin(page: Page, account: Account, saved: string | null) {
  await page.goto("/autentificare?next=%2Fadmin");
  await page.evaluate(
    ([key, value]) => {
      if (value === null) window.localStorage.removeItem(key as string);
      else window.localStorage.setItem(key as string, value);
    },
    [THEME_KEY, saved],
  );
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Parolă", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Intră în cont" }).click();
  await page.waitForURL((url) => url.pathname === "/admin");
  // apare doar după ce adminul s-a afișat
  await expect(page.getByRole("heading", { level: 1, name: "Panou de control" })).toBeVisible();
}

const adminBackground = (page: Page) =>
  page.evaluate(
    () =>
      getComputedStyle(document.querySelector('[data-surface="admin"]') as Element).backgroundColor,
  );

/** Luminanța relativă aproximativă (0 = negru, 1 = alb) dintr-un `rgb(...)`. */
function luminance(color: string): number {
  const channels = (/\d+(\.\d+)?/g.exec(color) ? color.match(/\d+(\.\d+)?/g) : null) ?? [];
  const [r = 0, g = 0, b = 0] = channels.slice(0, 3).map((c) => Number(c) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const openUserMenu = async (page: Page) => {
  await page.getByRole("button", { name: "Meniul utilizatorului" }).click();
};
const themeButton = (page: Page, name: "Sistem" | "Luminos" | "Întunecat") =>
  page.getByRole("group", { name: "Aspect" }).getByRole("button", { name, exact: true });

test.describe("tema adminului la prima afișare", () => {
  test.use({ colorScheme: "dark" });

  test("«Luminos» salvat: adminul e luminos și meniul evidențiază «Luminos», fără reîncărcare", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createOwner(request, baseURL as string);
    await signInToAdmin(page, owner, "light");
    await openUserMenu(page);
    await expect(themeButton(page, "Luminos")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
    expect(luminance(await adminBackground(page))).toBeGreaterThan(0.5);
  });

  test("«Întunecat» salvat: adminul e întunecat și meniul evidențiază «Întunecat», fără reîncărcare", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createOwner(request, baseURL as string);
    await signInToAdmin(page, owner, "dark");
    await openUserMenu(page);
    await expect(themeButton(page, "Întunecat")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    expect(luminance(await adminBackground(page))).toBeLessThan(0.5);
  });

  test("fără alegere salvată: meniul evidențiază «Sistem», iar adminul urmează sistemul (întunecat)", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createOwner(request, baseURL as string);
    await signInToAdmin(page, owner, null);
    await openUserMenu(page);
    await expect(themeButton(page, "Sistem")).toHaveAttribute("aria-pressed", "true");
    await expect(themeButton(page, "Luminos")).toHaveAttribute("aria-pressed", "false");
    expect(luminance(await adminBackground(page))).toBeLessThan(0.5);
    // «Sistem» urmează sistemul și în celălalt sens
    await page.emulateMedia({ colorScheme: "light" });
    await expect.poll(async () => luminance(await adminBackground(page))).toBeGreaterThan(0.5);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(async () => luminance(await adminBackground(page))).toBeLessThan(0.5);
  });

  test("alegere salvată nerecunoscută: se tratează ca «Sistem» (meniul și aspectul se potrivesc)", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createOwner(request, baseURL as string);
    await signInToAdmin(page, owner, "mov");
    await openUserMenu(page);
    await expect(themeButton(page, "Sistem")).toHaveAttribute("aria-pressed", "true");
    expect(luminance(await adminBackground(page))).toBeLessThan(0.5);
  });
});

test.describe("tema adminului cu sistemul în mod luminos", () => {
  test.use({ colorScheme: "light" });

  test("«Întunecat» salvat: adminul e întunecat de la prima afișare, deși sistemul e luminos", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createOwner(request, baseURL as string);
    await signInToAdmin(page, owner, "dark");
    await openUserMenu(page);
    await expect(themeButton(page, "Întunecat")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    expect(luminance(await adminBackground(page))).toBeLessThan(0.5);
  });
});
