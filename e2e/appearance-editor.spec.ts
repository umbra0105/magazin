import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { promoteE2eUser, resetE2eAppearance } from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Editorul de temă (Nivel 2), `/admin/setari/aspect`: preset, culori, fonturi, rază, logo, variante de header și footer, bară de
 * anunț și CSS personalizat, cu previzualizare live. Se verifică ce vede utilizatorul: previzualizarea urmează formularul, salvarea
 * ajunge în `/theme.css` și în vitrina reală, erorile apar pe câmp și nu se salvează nimic, CSS-ul periculos e respins, accesul
 * fără permisiune e refuzat. Specul schimbă setări comune întregii aplicații: le readuce la implicit înainte și după.
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

let owner: Account;
let manager: Account;

test.beforeAll(async ({ request, baseURL }) => {
  await resetE2eAppearance();
  owner = await createAccount(request, baseURL as string, "owner");
  manager = await createAccount(request, baseURL as string, "manager");
});

test.afterAll(async () => {
  await resetE2eAppearance();
});

const light = (page: Page) => page.getByRole("group", { name: "Tema deschisă" });
const save = (page: Page) => page.getByRole("button", { name: "Salvează aspectul" });

async function previewStyle(page: Page): Promise<string> {
  return (await page.locator("[data-appearance-preview] style").first().textContent()) ?? "";
}

test("fără permisiunea de setări (Manager), pagina e refuzată", async ({ page }) => {
  await login(page, manager, "/admin");
  await page.goto("/admin/setari/aspect");
  await expect(page).toHaveURL(/\/admin\/acces-interzis$/);
  await page.goto("/admin/setari");
  await expect(page).toHaveURL(/\/admin\/acces-interzis$/);
});

test("meniul are grupul Setări cu elementul Aspect evidențiat, iar pagina are un singur H1", async ({
  page,
}) => {
  await login(page, owner, "/admin/setari");
  // «Setări» duce la primul element al grupului
  await expect(page).toHaveURL(/\/admin\/setari\/aspect$/);
  await expect(page.getByRole("heading", { level: 1, name: "Aspect" })).toHaveCount(1);
  const sidebar = page.getByRole("navigation", { name: "Navigare principală" });
  await expect(sidebar.getByRole("link", { name: "Aspect" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator("[data-appearance-preview]")).toBeVisible();
  // fără bară de taburi și fără element de meniu separat pentru Setări
  await expect(sidebar.getByRole("link", { name: "Setări" })).toHaveCount(0);
});

test("culoarea modificată: previzualizarea o urmează, salvarea ajunge în /theme.css și rămâne după reîncărcare", async ({
  page,
  request,
}) => {
  await login(page, owner, "/admin/setari/aspect");
  const action = light(page).getByLabel("Acțiune", { exact: true });
  await expect(action).toHaveValue("#0b5cad");
  await action.fill("#123456");
  await expect(page.getByText("Modificări nesalvate")).toBeVisible();
  // previzualizarea trece prin server, cu întârziere: așteptăm CSS-ul nou, nu un text care există deja
  await expect.poll(() => previewStyle(page)).toContain("--color-primary:#123456");

  await save(page).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Aspectul a fost salvat." }),
  ).toBeVisible();
  await expect(page.getByText("Modificări nesalvate")).toHaveCount(0);

  const theme = await (await request.get("/theme.css")).text();
  expect(theme).toContain("--color-primary:#123456");

  await page.reload();
  await expect(light(page).getByLabel("Acțiune", { exact: true })).toHaveValue("#123456");
});

test("culoare invalidă: eroare pe câmp, focus pe el la salvare, nimic nu se salvează", async ({
  page,
  request,
}) => {
  await login(page, owner, "/admin/setari/aspect");
  const bg = light(page).getByLabel("Fundal", { exact: true });
  await bg.fill("rosu");
  await expect(light(page).getByText("Folosește formatul #rrggbb.")).toBeVisible();
  await expect(bg).toHaveAttribute("aria-invalid", "true");
  await save(page).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Corectează câmpurile marcate" }),
  ).toBeVisible();
  await expect(bg).toBeFocused();
  const theme = await (await request.get("/theme.css")).text();
  expect(theme).not.toContain("rosu");
  expect(theme).toContain("--color-bg:#ffffff");
});

test("CSS personalizat: cel cu url() e respins pe câmp; cel valid ajunge în temă, împachetat în vitrină", async ({
  page,
  request,
}) => {
  await login(page, owner, "/admin/setari/aspect");
  const css = page.getByLabel("Reguli CSS");

  await css.fill(".x{background:url(https://evil.test/a.png)}");
  await expect(page.getByText("construcție interzisă")).toBeVisible();
  await expect(css).toHaveAttribute("aria-invalid", "true");
  await save(page).click();
  await expect(css).toBeFocused();
  expect(await (await request.get("/theme.css")).text()).not.toContain("evil.test");

  await css.fill(".card-demo{border-radius:2px}");
  await expect(css).not.toHaveAttribute("aria-invalid", "true");
  await save(page).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Aspectul a fost salvat." }),
  ).toBeVisible();
  const theme = await (await request.get("/theme.css")).text();
  expect(theme).toContain('html [data-surface="storefront"]{.card-demo{border-radius:2px}}');
});

test("presetul se aplică după confirmare și înlocuiește culorile, fonturile și raza; Renunță nu schimbă nimic", async ({
  page,
}) => {
  await login(page, owner, "/admin/setari/aspect");
  const primary = light(page).getByLabel("Acțiune", { exact: true });
  const before = await primary.inputValue();

  await page.getByRole("button", { name: "Aplică presetul Bold" }).click();
  const dialog = page.getByRole("dialog", { name: "Înlocuiești valorile cu cele ale presetului?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Renunță", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(primary).toHaveValue(before);

  await page.getByRole("button", { name: "Aplică presetul Bold" }).click();
  await dialog.getByRole("button", { name: "Înlocuiește" }).click();
  await expect(dialog).toBeHidden();
  await expect(primary).toHaveValue("#c2410c");
  await expect(page.getByLabel("Font pentru titluri")).toHaveValue("montserrat");
  await expect(page.getByLabel("Font pentru text")).toHaveValue("openSans");
  // CSS-ul personalizat salvat mai devreme rămâne (presetul nu îl atinge)
  await expect(page.getByLabel("Reguli CSS")).toHaveValue(".card-demo{border-radius:2px}");
  await expect.poll(() => previewStyle(page)).toContain("--color-primary:#c2410c");
  await expect(page.getByText("Presetul curent")).toBeVisible();
});

test("variante de pagină și bară de anunț: salvate, apar în vitrina reală; textul lipsă e semnalat", async ({
  page,
}) => {
  await login(page, owner, "/admin/setari/aspect");
  await page.getByLabel("Header", { exact: true }).selectOption("glass");
  await page.getByLabel("Footer", { exact: true }).selectOption("compact");
  await page.getByLabel("Afișează bara de anunț").check();

  // fără text, salvarea e oprită cu mesaj pe câmp
  await save(page).click();
  await expect(page.getByText("Scrie textul anunțului sau oprește bara.")).toBeVisible();
  await expect(page.getByLabel("Textul anunțului")).toBeFocused();

  await page.getByLabel("Textul anunțului").fill("Livrare gratuită în weekend");
  await page.getByLabel("Link (opțional)").fill("/livrare-si-plata");
  await save(page).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Aspectul a fost salvat." }),
  ).toBeVisible();

  await page.goto("/");
  const bar = page.getByRole("complementary", { name: "Anunț" });
  await expect(bar).toContainText("Livrare gratuită în weekend");
  await expect(bar.getByRole("link")).toHaveAttribute("href", "/livrare-si-plata");
  await expect(page.locator('[data-surface="storefront"]')).toHaveAttribute("data-header", "glass");
  await expect(page.getByRole("contentinfo").getByRole("heading")).toHaveCount(0);
});

test("anunț cu destinație periculoasă: respins pe câmp, nimic nu se salvează", async ({ page }) => {
  await login(page, owner, "/admin/setari/aspect");
  await page.getByLabel("Link (opțional)").fill("javascript:alert(1)");
  await save(page).click();
  await expect(
    page.getByText("Folosește o cale care începe cu / sau o adresă https://."),
  ).toBeVisible();
  await expect(page.getByLabel("Link (opțional)")).toBeFocused();
  await page.goto("/");
  await expect(
    page.getByRole("complementary", { name: "Anunț" }).getByRole("link"),
  ).toHaveAttribute("href", "/livrare-si-plata");
});

test("captură a editorului (doar când E2E_CAPTURES_DIR e setat; pentru verificarea vizuală)", async ({
  page,
}) => {
  test.skip(!process.env["E2E_CAPTURES_DIR"], "doar la cerere");
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, owner, "/admin/setari/aspect");
  await expect(page.locator("[data-appearance-preview]")).toBeVisible();
  await page.waitForTimeout(1200);
  await page.screenshot({
    path: `${process.env["E2E_CAPTURES_DIR"]}/editor-aspect.png`,
    fullPage: true,
  });
});

test.describe("mod de mentenanță (503 pentru vizitatori, adminul rămâne accesibil)", () => {
  const MESSAGE = "Revenim la ora 18:00, după inventar";

  test("fără mentenanță, adresa /mentenanta nu există (404) și vitrina răspunde 200", async ({
    request,
  }) => {
    expect((await request.get("/mentenanta")).status()).toBe(404);
    expect((await request.get("/")).status()).toBe(200);
  });

  test("pornit din admin: vizitatorii primesc 503 cu Retry-After și mesajul; admin, autentificare, tema și API rămân accesibile", async ({
    page,
    request,
  }) => {
    await login(page, owner, "/admin/setari/mentenanta");
    await expect(page.getByRole("heading", { level: 1, name: "Mentenanță" })).toHaveCount(1);
    await page.getByLabel("Pornește modul de mentenanță").check();
    await page.getByLabel("Mesaj pentru vizitatori").fill(MESSAGE);
    await page.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Setările mentenanței au fost salvate." }),
    ).toBeVisible();
    await expect(page.locator("[data-maintenance-state]")).toHaveText(
      "Vitrina este în mentenanță acum.",
    );

    // middleware-ul citește flagul cu un cache de câteva secunde
    await expect
      .poll(async () => (await request.get("/", { maxRedirects: 0 })).status(), { timeout: 20_000 })
      .toBe(503);
    const home = await request.get("/", { maxRedirects: 0 });
    expect(home.headers()["retry-after"]).toBe("3600");
    expect(home.headers()["cache-control"]).toBe("no-store");
    const html = await home.text();
    expect(html).toContain("Revenim în curând");
    expect(html).toContain(MESSAGE);
    expect(html).toMatch(/<meta name="robots" content="noindex/);

    // orice pagină a vitrinei, nu doar prima
    expect((await request.get("/produs/pompa", { maxRedirects: 0 })).status()).toBe(503);
    expect((await request.get("/pagina-care-nu-exista", { maxRedirects: 0 })).status()).toBe(503);

    // ce rămâne accesibil
    expect((await request.get("/autentificare")).status()).toBe(200);
    expect((await request.get("/theme.css")).status()).toBe(200);
    expect((await request.get("/api/health")).status()).toBe(200);
    expect((await request.get("/admin", { maxRedirects: 0 })).status()).toBe(307);

    // adminul autentificat își vede în continuare paginile
    await page.goto("/admin/setari/mentenanta");
    await expect(page.getByRole("heading", { level: 1, name: "Mentenanță" })).toBeVisible();
  });

  test("oprit din admin: vitrina se redeschide (200), iar /mentenanta redevine 404", async ({
    page,
    request,
  }) => {
    await login(page, owner, "/admin/setari/mentenanta");
    await page.getByLabel("Pornește modul de mentenanță").uncheck();
    await page.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Setările mentenanței au fost salvate." }),
    ).toBeVisible();
    await expect
      .poll(async () => (await request.get("/", { maxRedirects: 0 })).status(), { timeout: 20_000 })
      .toBe(200);
    expect((await request.get("/mentenanta")).status()).toBe(404);
  });

  test("Managerul (fără settings.read) nu vede pagina de mentenanță", async ({ page }) => {
    await login(page, manager, "/admin");
    await page.goto("/admin/setari/mentenanta");
    await expect(page).toHaveURL(/\/admin\/acces-interzis$/);
  });
});
