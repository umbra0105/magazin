import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  createE2eRole,
  promoteE2eUser,
  readE2eStock,
  readE2eStockAudit,
  removeE2eStock,
  removeE2eStockShared,
  seedE2eStock,
  setE2eStockSnapshot,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Faza 5, punctul 8, în browser: ecranul `/admin/produse/stoc` (cantități cu zecimale, pași, rest nevandabil, negestionat, digital,
 * «La comandă», banner-ul «stoc verificat la …»), ajustarea cu motiv și oră efectivă (validări proprii în română,
 * avertismente, jurnal de audit), istoricul și drepturile pe roluri. Produsele de probă au adresa `e2e-stoc-…` și se șterg
 * la final (inclusiv mișcările).
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

/** Autentificare; întoarce după ce s-a ieșit din pagina de autentificare (și pentru conturile care nu au voie în pagina cerută). */
async function login(page: Page, account: Account, next: string) {
  await page.goto(`/autentificare?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Parolă", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Intră în cont" }).click();
  await page.waitForURL((url) => url.pathname !== "/autentificare");
}

/** Data și ora în ora magazinului (București), în formatul din formular: «zz.ll.aaaa» și «hh:mm». */
function bucharest(date: Date): { date: string; time: string } {
  const parts = new Map(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Bucharest",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.get("day")}.${parts.get("month")}.${parts.get("year")}`,
    time: `${parts.get("hour")}:${parts.get("minute")}`,
  };
}

test.describe.configure({ mode: "serial", timeout: 150_000 });

const tag = randomBytes(3).toString("hex");
const search = `E2E ${tag}`;
let skus: string[] = [];
const [LINER, BISULFAT, MOZAIC, UNMANAGED, DIGITAL, HYBRID] = [0, 1, 2, 3, 4, 5];

test.beforeAll(async () => {
  skus = await seedE2eStock(
    tag,
    [
      {
        title: `Liner ${search}`,
        unit: { symbol: "mp", decimals: 2 },
        step: "41,25",
        variants: [{ sku: "L", physical: "100" }],
      },
      {
        title: `Bisulfat ${search}`,
        unit: { symbol: "kg", decimals: 0 },
        step: "25",
        variants: [{ sku: "B", physical: "80" }],
      },
      {
        title: `Mozaic ${search}`,
        unit: { symbol: "mp", decimals: 2 },
        step: "2,03",
        variants: [{ sku: "M", physical: "10" }],
      },
      {
        title: `Cartuș ${search}`,
        manageStock: false,
        stockStatus: "outofstock",
        variants: [{ sku: "C", physical: null }],
      },
      {
        title: `Ghid ${search}`,
        type: "digital",
        manageStock: false,
        variants: [{ sku: "G", physical: null }],
      },
      {
        title: `Pompă ${search}`,
        allowBackorder: true,
        variants: [{ sku: "P", physical: "0" }],
      },
    ],
    { asOfHoursAgo: 3 },
  );
  await setE2eStockSnapshot(3);
});

test.afterAll(async () => {
  await removeE2eStock({ tag });
  await removeE2eStockShared();
});

const row = (page: Page, sku: string): Locator => page.locator(`[data-variant-row="${sku}"]`);
const adjustButton = (scope: Locator): Locator =>
  scope.getByRole("button", { name: /^Ajustează stocul:/ });

function failOnNativeDialog(page: Page): void {
  page.on("dialog", async (dialog) => {
    await dialog.dismiss();
    throw new Error(`Dialog nativ neașteptat: ${dialog.message()}`);
  });
}

test.describe("ecranul de stoc", () => {
  test("Manager: cantități cu zecimale, pași și rest nevandabil; negestionat, digital și «La comandă»; filtre", async ({
    page,
    request,
    baseURL,
  }) => {
    failOnNativeDialog(page);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, `/admin/produse/stoc?q=${encodeURIComponent(search)}`);
    await expect(page.getByRole("heading", { level: 1, name: "Stoc" })).toBeVisible();
    await expect(page.locator("[data-result-count]")).toHaveAttribute("data-result-count", "6");
    await expect(page.locator('[data-banner="fresh"]')).toContainText("Stoc verificat la");

    // liner: 100 mp, rola de 41,25 mp → 2 pași, rest 17,5 mp (exact la pragul «Stoc limitat»)
    const liner = row(page, skus[LINER] as string);
    await expect(liner.locator('[data-cell="unit"]')).toContainText("mp · pas 41,25");
    await expect(liner.locator('[data-cell="physical"]')).toContainText("100 mp");
    await expect(liner.locator('[data-cell="physical"]')).toContainText("valabilă la");
    await expect(liner.locator('[data-cell="available"]')).toContainText("= 2 pași");
    await expect(liner.locator('[data-cell="remainder"]')).toContainText("17,5 mp");
    await expect(liner.locator('[data-cell="state"]')).toContainText("Stoc limitat");
    await expect(liner.locator('[data-cell="state"]')).toContainText("mai sunt 2 pași");

    // bisulfat: 80 kg, sacul de 25 kg → 3 pași, rest 5 kg
    const bisulfat = row(page, skus[BISULFAT] as string);
    await expect(bisulfat.locator('[data-cell="physical"]')).toContainText("80 kg");
    await expect(bisulfat.locator('[data-cell="available"]')).toContainText("= 3 pași");
    await expect(bisulfat.locator('[data-cell="remainder"]')).toContainText("5 kg");
    await expect(bisulfat.locator('[data-cell="state"]')).toContainText("În stoc");

    // mozaic: 10 mp, cutia de 2,03 mp → 4 pași, rest 1,88 mp
    const mozaic = row(page, skus[MOZAIC] as string);
    await expect(mozaic.locator('[data-cell="available"]')).toContainText("10 mp");
    await expect(mozaic.locator('[data-cell="available"]')).toContainText("= 4 pași");
    await expect(mozaic.locator('[data-cell="remainder"]')).toContainText("1,88 mp");

    // negestionat: doar starea din dropdown, fără cantități și fără «Ajustează»
    const unmanaged = row(page, skus[UNMANAGED] as string);
    await expect(unmanaged).toHaveAttribute("data-kind", "unmanaged");
    await expect(unmanaged).toContainText("Negestionat până la inventar");
    await expect(unmanaged.locator('[data-cell="state"]')).toContainText("Stoc epuizat");
    await expect(adjustButton(unmanaged)).toHaveCount(0);

    // digital: fără stoc
    const digital = row(page, skus[DIGITAL] as string);
    await expect(digital).toHaveAttribute("data-kind", "digital");
    await expect(digital).toContainText("Digital, fără stoc");
    await expect(digital.locator('[data-cell="state"]')).toContainText("În stoc");
    await expect(adjustButton(digital)).toHaveCount(0);

    // gestionat, epuizat, cu «La comandă» permis
    const hybrid = row(page, skus[HYBRID] as string);
    await expect(hybrid.locator('[data-cell="state"]')).toContainText("La comandă");
    await expect(hybrid.locator('[data-cell="state"]')).toContainText("termen");
    await expect(adjustButton(hybrid)).toHaveCount(1);

    // filtrul de tip, prin formular (GET): rămâne doar produsul negestionat
    await page.getByLabel("Tip", { exact: true }).selectOption("unmanaged");
    await page.getByRole("button", { name: "Filtrează" }).click();
    await expect(page).toHaveURL(/tip=unmanaged/);
    await expect(page.locator("[data-result-count]")).toHaveAttribute("data-result-count", "1");
    await expect(row(page, skus[UNMANAGED] as string)).toBeVisible();
    await expect(row(page, skus[LINER] as string)).toHaveCount(0);
    // «Resetează» readuce lista întreagă
    await page.getByRole("link", { name: "Resetează" }).click();
    await expect(page).toHaveURL(/\/admin\/produse\/stoc$/);
  });

  test("banner-ul «stoc verificat la …»: fără poză, veche, proaspătă", async ({
    page,
    request,
    baseURL,
  }) => {
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, `/admin/produse/stoc?q=${encodeURIComponent(search)}`);
    await expect(page.locator('[data-banner="fresh"]')).toBeVisible();

    await setE2eStockSnapshot(null);
    await page.reload();
    const never = page.locator('[data-banner="never"]');
    await expect(never).toContainText("Nu există nicio poză SmartBill");
    await expect(never).toHaveAttribute("role", "alert");

    await setE2eStockSnapshot(30);
    await page.reload();
    const stale = page.locator('[data-banner="stale"]');
    await expect(stale).toContainText("Poza SmartBill e veche");
    await expect(stale).toContainText("Pragul este de 24 h");
    await expect(stale).toHaveAttribute("data-tone", "danger");

    await setE2eStockSnapshot(3);
    await page.reload();
    await expect(page.locator('[data-banner="fresh"]')).toContainText("acum 3 h");
  });
});

test.describe("ajustarea stocului", () => {
  test("Manager: «Vânzare în magazin» scade stocul, scrie mișcarea și auditul; istoricul o arată", async ({
    page,
    request,
    baseURL,
  }) => {
    failOnNativeDialog(page);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, `/admin/produse/stoc?q=${encodeURIComponent(search)}`);
    const liner = row(page, skus[LINER] as string);
    await adjustButton(liner).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Stoc fizic acum: 100 mp");

    await dialog.getByLabel("Motiv", { exact: true }).selectOption({ label: "Vânzare în magazin" });
    // «Vânzare în magazin» scade stocul: «Adaugă» nu e permis
    await expect(dialog.getByRole("radio", { name: "Scade" })).toBeChecked();
    await expect(dialog.getByRole("radio", { name: "Adaugă" })).toBeDisabled();
    await dialog.getByLabel("Cantitate", { exact: true }).fill("10");
    await dialog.getByLabel("Text (obligatoriu)").fill("bon E2E 123");
    await dialog.getByRole("button", { name: "Salvează ajustarea" }).click();

    // starea de după salvare: mesajul de succes apare doar acum
    const saved = dialog.locator("[data-saved]");
    await expect(saved).toContainText("100 mp → 90 mp");
    await expect(dialog.locator("[data-warnings]")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Închide" }).last().click();
    await expect(dialog).toBeHidden();
    // lista reîncărcată arată noul stoc (90 mp = 2 pași, rest 7,5)
    await expect(liner.locator('[data-cell="physical"]')).toContainText("90 mp");
    await expect(liner.locator('[data-cell="remainder"]')).toContainText("7,5 mp");

    // baza: mișcarea imuabilă cu motiv, text, autor și variația exactă; auditul
    const stock = await readE2eStock(skus[LINER] as string);
    expect(stock?.physical).toBe("900000");
    expect(stock?.movements).toHaveLength(1);
    expect(stock?.movements[0]).toMatchObject({
      kind: "adjustment",
      reason: "sale_in_store",
      note: "bon E2E 123",
      deltaPhysical: "-100000",
      physicalAfter: "900000",
      actorLabel: manager.email,
    });
    const audit = await readE2eStockAudit(stock?.variantId as string);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ outcome: "success", actorLabel: manager.email });
    expect(audit[0]?.after).toMatchObject({
      reason: "sale_in_store",
      delta: "-10",
      physical: "90",
    });

    // istoricul variantei
    await liner.getByRole("link", { name: /^Istoricul stocului:/ }).click();
    await page.waitForURL(/\/admin\/produse\/stoc\/[A-Za-z0-9_-]+$/);
    await expect(page.getByRole("heading", { level: 1 })).toContainText("Istoric stoc: Liner");
    await expect(page.getByRole("navigation", { name: "Poziția în pagină" })).toContainText(
      "Istoric",
    );
    const movement = page.locator('[data-movement="adjustment"]');
    await expect(movement).toHaveCount(1);
    await expect(movement).toContainText("Vânzare în magazin");
    await expect(movement).toContainText("bon E2E 123");
    await expect(movement.locator('[data-cell="delta-physical"]')).toContainText("-10 mp");
    await expect(movement.locator('[data-cell="physical-after"]')).toContainText("90 mp");
    await expect(movement).toContainText(manager.email);
    await expect(page.getByText("Istoricul nu se poate modifica sau șterge.")).toBeVisible();
    await page.getByRole("link", { name: "Înapoi la stoc" }).click();
    await page.waitForURL(/\/admin\/produse\/stoc$/);
  });

  test("validări proprii în română, fără widgeturi native; sub zero se refuză de la server", async ({
    page,
    request,
    baseURL,
  }) => {
    failOnNativeDialog(page);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, `/admin/produse/stoc?q=${encodeURIComponent(search)}`);
    await adjustButton(row(page, skus[MOZAIC] as string)).click();
    const dialog = page.getByRole("dialog");
    // formularul nu folosește validarea nativă a browserului
    await expect(dialog.locator("form")).toHaveAttribute("novalidate", "");

    await dialog.getByRole("button", { name: "Salvează ajustarea" }).click();
    await expect(dialog.getByText("Alege un motiv.")).toBeVisible();
    await expect(dialog.getByText("Cantitatea e obligatorie.")).toBeVisible();
    await expect(dialog.getByText("Textul este obligatoriu.")).toBeVisible();
    await expect(dialog.getByLabel("Motiv", { exact: true })).toBeFocused();

    await dialog.getByLabel("Motiv", { exact: true }).selectOption({ label: "Alt motiv" });
    const amount = dialog.getByLabel("Cantitate", { exact: true });
    const save = dialog.getByRole("button", { name: "Salvează ajustarea" });
    await amount.fill("abc");
    await save.click();
    await expect(dialog.getByText(/Scrie un număr, de exemplu 3 sau 2,5/)).toBeVisible();
    await expect(amount).toBeFocused();
    await amount.fill("0");
    await save.click();
    await expect(dialog.getByText("Cantitatea trebuie să fie mai mare decât zero.")).toBeVisible();
    await amount.fill("2,555");
    await save.click();
    await expect(dialog.getByText("Unitatea «mp» are cel mult 2 zecimale.")).toBeVisible();

    // data și ora ca text; mesaje proprii
    const dateField = dialog.getByLabel("Data efectivă (zz.ll.aaaa)");
    const timeField = dialog.getByLabel("Ora efectivă (hh:mm)");
    const nowDate = await dateField.inputValue();
    const nowTime = await timeField.inputValue();
    expect(nowDate).toMatch(/^\d{2}\.\d{2}\.\d{4}$/);
    expect(nowTime).toMatch(/^\d{2}:\d{2}$/);
    await amount.fill("1");
    await dialog.getByLabel("Text (obligatoriu)").fill("probă validări");
    await dateField.fill("31.02.2026");
    await save.click();
    await expect(
      dialog.getByText("Scrie data așa: zz.ll.aaaa, de exemplu 23.10.2026."),
    ).toBeVisible();
    await expect(dateField).toBeFocused();
    await dateField.fill(nowDate);
    await timeField.fill("25:00");
    await save.click();
    await expect(dialog.getByText("Scrie ora așa: hh:mm, de exemplu 14:30.")).toBeVisible();
    await timeField.fill(nowTime);
    await dateField.fill("01.01.2100");
    await save.click();
    await expect(dialog.getByText("Ora efectivă nu poate fi în viitor.")).toBeVisible();
    await dateField.fill(nowDate);

    // mai mult decât există: refuzat de server, dialogul rămâne deschis, stocul neschimbat
    await amount.fill("1000");
    await save.click();
    await expect(dialog.locator("[data-problem]")).toContainText("Stocul nu poate deveni negativ");
    await expect(dialog).toBeVisible();
    const stock = await readE2eStock(skus[MOZAIC] as string);
    expect(stock?.physical).toBe("100000");
    expect(stock?.movements).toHaveLength(0);
    await dialog.getByRole("button", { name: "Renunță" }).click();
    await expect(dialog).toBeHidden();
  });

  test("ora efectivă dinaintea pozei aplicate: ajustarea se salvează, cu avertisment în română", async ({
    page,
    request,
    baseURL,
  }) => {
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, `/admin/produse/stoc?q=${encodeURIComponent(search)}`);
    await adjustButton(row(page, skus[BISULFAT] as string)).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByLabel("Motiv", { exact: true })
      .selectOption({ label: "Inventariere (corecție)" });
    // «Inventariere» merge în ambele sensuri
    await expect(dialog.getByRole("radio", { name: "Adaugă" })).toBeEnabled();
    await dialog.getByRole("radio", { name: "Scade" }).check();
    await dialog.getByLabel("Cantitate", { exact: true }).fill("5");
    const earlier = bucharest(new Date(Date.now() - 5 * 3_600_000));
    await dialog.getByLabel("Data efectivă (zz.ll.aaaa)").fill(earlier.date);
    await dialog.getByLabel("Ora efectivă (hh:mm)").fill(earlier.time);
    await dialog.getByLabel("Text (obligatoriu)").fill("numărătoare E2E");
    await dialog.getByRole("button", { name: "Salvează ajustarea" }).click();

    await expect(dialog.locator("[data-saved]")).toContainText("80 kg → 75 kg");
    const warnings = dialog.locator("[data-warnings]");
    await expect(warnings).toContainText("Atenție");
    await expect(warnings).toContainText("Ora efectivă este dinaintea pozei SmartBill din");
    await dialog.getByRole("button", { name: "Închide" }).last().click();
    await expect(dialog).toBeHidden();
    await expect(
      row(page, skus[BISULFAT] as string).locator('[data-cell="physical"]'),
    ).toContainText("75 kg");
    const stock = await readE2eStock(skus[BISULFAT] as string);
    expect(stock?.movements[0]).toMatchObject({
      reason: "inventory_correction",
      deltaPhysical: "-50000",
    });
    const audit = await readE2eStockAudit(stock?.variantId as string);
    expect(audit[0]?.after).toMatchObject({ warnings: ["effective_before_snapshot"] });
  });
});

test.describe("drepturi", () => {
  test("Depozit poate ajusta; doar cu «inventory.read» vede stocul fără butonul «Ajustează»", async ({
    page,
    browser,
    request,
    baseURL,
  }) => {
    const warehouse = await createAccount(request, baseURL as string, "warehouse");
    await login(page, warehouse, `/admin/produse/stoc?q=${encodeURIComponent(search)}`);
    await expect(adjustButton(row(page, skus[LINER] as string))).toHaveCount(1);
    await expect(page.getByRole("link", { name: "Stoc", exact: true })).toBeVisible();

    await createE2eRole("e2e-stoc-citire", ["admin.access", "inventory.read"]);
    const reader = await createAccount(request, baseURL as string, "e2e-stoc-citire");
    const second = await browser.newContext({ baseURL: baseURL as string });
    try {
      const readerPage = await second.newPage();
      await login(readerPage, reader, `/admin/produse/stoc?q=${encodeURIComponent(search)}`);
      await expect(readerPage.getByRole("heading", { level: 1, name: "Stoc" })).toBeVisible();
      // doar inventory.read: bara are un singur tab (Stoc), iar «Produse» din meniu duce direct la el
      const bar = readerPage.getByRole("navigation", { name: "Secțiunile produselor" });
      await expect(bar.getByRole("link")).toHaveText(["Stoc"]);
      await readerPage.goto("/admin");
      await readerPage
        .getByRole("navigation", { name: "Navigare principală" })
        .getByRole("link", { name: "Produse", exact: true })
        .click();
      await expect(readerPage).toHaveURL(/\/admin\/produse\/stoc$/);
      await readerPage.goto("/admin/produse");
      await expect(readerPage).toHaveURL(/\/admin\/acces-interzis/);
      await readerPage.goto(`/admin/produse/stoc?q=${encodeURIComponent(search)}`);
      await expect(
        readerPage.getByText("Poți vedea stocul, dar nu îl poți modifica."),
      ).toBeVisible();
      await expect(row(readerPage, skus[LINER] as string)).toBeVisible();
      await expect(adjustButton(readerPage.locator("body"))).toHaveCount(0);
      // istoricul rămâne vizibil cu citire
      await expect(
        row(readerPage, skus[LINER] as string).getByRole("link", { name: /^Istoricul stocului:/ }),
      ).toBeVisible();
    } finally {
      await second.close();
    }
  });

  for (const role of ["editor", "support"]) {
    test(`${role}: nu vede stocul (acces interzis), iar meniul nu are «Stoc»`, async ({
      page,
      request,
      baseURL,
    }) => {
      const account = await createAccount(request, baseURL as string, role);
      await login(page, account, "/admin/produse/stoc");
      await expect(page).not.toHaveURL(/\/admin\/produse\/stoc/);
      await expect(page.getByRole("link", { name: "Stoc", exact: true })).toHaveCount(0);
      await page.goto("/admin/produse/stoc");
      await expect(page).not.toHaveURL(/\/admin\/produse\/stoc/);
      await expect(page.getByRole("heading", { level: 1, name: "Stoc" })).toHaveCount(0);
    });
  }

  test("anonim: trimis la autentificare", async ({ page }) => {
    await page.goto("/admin/produse/stoc");
    await expect(page).toHaveURL(/\/autentificare/);
  });
});
