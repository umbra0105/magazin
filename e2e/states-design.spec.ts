import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { promoteE2eUser } from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Redesign admin, Lotul 4 (docs/17): autentificare, 404, eroare și încărcare. Paginile de autentificare stau pe suprafața adminului
 * (tokeni, tonuri de stare, un singur buton principal); 404 (publică și în admin), eroarea (`error.tsx`) și încărcarea (`loading.tsx`)
 * folosesc `EmptyState`, `Button` și `Skeleton`, cu o singură acțiune. Eroarea și încărcarea se verifică pe paginile-harness
 * `/admin/e2e-harness/eroare` și `/admin/e2e-harness/incarcare`. Comportamentul autentificării rămâne în `auth.spec.ts`.
 */

interface Account {
  email: string;
  password: string;
}

async function createAccount(
  request: APIRequestContext,
  baseURL: string,
  roleKey: string,
): Promise<Account> {
  const email = `e2e-${randomBytes(5).toString("hex")}@example.test`;
  const password = randomBytes(18).toString("base64url");
  const response = await request.post(`${baseURL}/api/auth/sign-up/email`, {
    headers: { origin: baseURL, "x-forwarded-for": uniqueClientIp() },
    data: { name: "Cont E2E", email, password },
  });
  await expectResponseOk(response, "înregistrarea contului de test");
  await promoteE2eUser(email, roleKey);
  return { email, password };
}

async function login(page: Page, account: Account, next: string) {
  await page.goto(`/autentificare?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Parolă", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Intră în cont" }).click();
  await page.waitForURL((url) => url.pathname !== "/autentificare");
}

test.describe.configure({ mode: "serial", timeout: 150_000 });

let account: Account;

test.beforeAll(async ({ request, baseURL }) => {
  account = await createAccount(request, baseURL as string, "owner");
});

const css = (locator: Locator, property: string) =>
  locator.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), property);

/** Pagina nu derulează pe orizontală (scrollWidth ≤ clientWidth). */
const pageOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Valoarea unei proprietăți pentru o clasă-token, citită dintr-un element-sondă din suprafața adminului. */
const tokenStyle = (page: Page, className: string, property: string) =>
  page.evaluate(
    ([name, prop]) => {
      const probe = document.createElement("div");
      probe.className = name as string;
      (document.querySelector('[data-surface="admin"]') ?? document.body).append(probe);
      const value = getComputedStyle(probe).getPropertyValue(prop as string);
      probe.remove();
      return value;
    },
    [className, property] as const,
  );

/** Butoanele principale vizibile (fundal `--action`); întoarce numele lor. */
async function primaryControls(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const probe = document.createElement("div");
    probe.className = "bg-action";
    (document.querySelector('[data-surface="admin"]') ?? document.body).append(probe);
    const primary = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const found: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('button, a, [role="button"]')) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (getComputedStyle(el).backgroundColor !== primary) continue;
      found.push((el.getAttribute("aria-label") ?? el.textContent ?? "").trim());
    }
    return found;
  });
}

// ───────────────────────── Autentificare ─────────────────────────

test.describe("autentificare", () => {
  test("login (1440 px): suprafața adminului, un singur buton principal, erorile de câmp și de server în tonul Problemă, fără derulare orizontală la 390 px", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/autentificare");
    await expect(page.locator('[data-surface="admin"]')).toHaveCount(1);
    expect(await primaryControls(page)).toEqual(["Intră în cont"]);
    await page.getByRole("button", { name: "Intră în cont" }).click();
    const fieldError = page.getByText("Câmpul este obligatoriu.").first();
    await expect(fieldError).toBeVisible();
    expect(await css(fieldError, "color")).toBe(
      await tokenStyle(page, "text-tone-problem-fg", "color"),
    );
    await page.getByLabel("Email").fill("cineva@example.test");
    await page.getByLabel("Parolă", { exact: true }).fill("parola-gresita-1");
    await page.getByRole("button", { name: "Intră în cont" }).click();
    const alert = page.locator("main [role=alert]");
    await expect(alert).toHaveText("Email sau parolă incorecte.");
    expect(await css(alert, "background-color")).toBe(
      await tokenStyle(page, "bg-tone-problem-bg", "background-color"),
    );
    expect(await css(alert, "color")).toBe(await tokenStyle(page, "text-tone-problem-fg", "color"));
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("înregistrare, recuperare, resetare și verificare: tot pe suprafața adminului, fără derulare orizontală la 390 px, cel mult un buton principal", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of [
      "/inregistrare",
      "/recuperare-parola",
      "/resetare-parola",
      "/verificare-email",
    ]) {
      await page.goto(path);
      await expect(page.locator('[data-surface="admin"]'), path).toHaveCount(1);
      expect(await pageOverflow(page), `${path}: derulare orizontală`).toBeLessThanOrEqual(0);
      expect(
        (await primaryControls(page)).length,
        `${path}: butoane principale`,
      ).toBeLessThanOrEqual(1);
    }
  });
});

test.describe("autentificare: mesajul de formular", () => {
  test("link invalid de verificare și de resetare: alerta primește focus, dar fără inel de focus (inelul rămâne la navigarea cu tastatura)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const path of ["/verificare-email", "/resetare-parola"]) {
      await page.goto(path);
      const alert = page.locator("main [role=alert]");
      await expect(alert, path).toBeVisible();
      await expect(alert, path).toBeFocused();
      expect(await css(alert, "box-shadow"), `${path}: inel (box-shadow)`).toBe("none");
      expect(await css(alert, "outline-style"), `${path}: inel (outline)`).toBe("none");
    }
    // câmpurile și butoanele păstrează inelul la focus de la tastatură
    await page.goto("/autentificare");
    // primul Tab ajunge pe legătura cu numele magazinului: se apasă până la câmpul Email
    for (let index = 0; index < 4; index += 1) {
      await page.keyboard.press("Tab");
      const onEmail = await page
        .getByLabel("Email")
        .evaluate((el) => el === document.activeElement);
      if (onEmail) break;
    }
    await expect(page.getByLabel("Email")).toBeFocused();
    expect(await css(page.getByLabel("Email"), "box-shadow")).not.toBe("none");
  });
});

// ───────────────────────── 404, eroare, încărcare ─────────────────────────

test.describe("404, eroare, încărcare", () => {
  test("404 public: stare cu titlu, o frază și o singură acțiune principală; răspunde 404", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const response = await page.goto("/pagina-care-nu-exista");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Pagina nu a fost găsită" })).toBeVisible();
    await expect(page.locator('[data-surface="admin"]')).toHaveCount(1);
    expect(await primaryControls(page)).toEqual(["Înapoi la prima pagină"]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("404 în admin: stare în cadrul adminului (meniul rămâne), o singură acțiune principală («Înapoi la panou»)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, "/admin");
    const response = await page.goto("/admin/pagina-care-nu-exista");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Pagina nu a fost găsită" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Panou", exact: true }).first()).toBeVisible();
    expect(await primaryControls(page)).toEqual(["Înapoi la panou"]);
    // firimitura nu arată slug-ul brut al adresei, ci o etichetă fixă
    const crumb = page
      .getByRole("navigation", { name: "Poziția în pagină" })
      .locator("[aria-current=page]");
    await expect(crumb).toHaveText("Pagină negăsită");
    await expect(page.getByRole("navigation", { name: "Poziția în pagină" })).not.toContainText(
      "pagina-care-nu-exista",
    );
  });

  test("eroare în admin: titlu, o frază, «Reîncearcă» ca singur buton principal și cadrul adminului păstrat", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, "/admin");
    await page.goto("/admin/e2e-harness/eroare?arunca=1");
    await expect(page.getByRole("heading", { name: "Ceva nu a mers bine" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Reîncearcă" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Panou", exact: true }).first()).toBeVisible();
    expect(await primaryControls(page)).toEqual(["Reîncearcă"]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await pageOverflow(page)).toBeLessThanOrEqual(0);
  });

  test("încărcare în admin (PageSkeleton într-un Suspense): regiune cu stare anunțată («Se încarcă…») și schelete ascunse cititoarelor de ecran, fără buton principal", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await login(page, account, "/admin");
    await page.goto("/admin/e2e-harness/incarcare", { waitUntil: "commit" });
    const status = page.getByRole("status").filter({ hasText: "Se încarcă" });
    await expect(status).toBeVisible();
    await expect(
      page.locator('[aria-hidden="true"][class*="animate-pulse"]').first(),
    ).toBeVisible();
    expect(await primaryControls(page)).toEqual([]);
    // după încărcare, pagina propriu-zisă înlocuiește scheletul
    await expect(page.getByRole("heading", { name: "Pagină încărcată" })).toBeVisible({
      timeout: 30_000,
    });
  });
});
