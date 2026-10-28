import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { buildReport } from "../packages/integrations/src/spreadsheet/test-utils/report-workbook";
import {
  E2E_STOCK_IMPORT_FILE,
  createE2eRole,
  promoteE2eUser,
  readE2eAuditByEntity,
  readE2eStock,
  readE2eStockImports,
  readE2eStockAudit,
  removeE2eStock,
  removeE2eStockImports,
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
    await expect(page.locator('[data-banner="fresh"]')).toContainText("Actualizat acum 3 ore");

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

  test("banner-ul «Sincronizare SmartBill»: neimportat, neactualizat, la zi", async ({
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
    await expect(never).toContainText("Stocul nu a fost încă importat din SmartBill");
    await expect(never).toHaveAttribute("role", "alert");

    await setE2eStockSnapshot(30);
    await page.reload();
    const stale = page.locator('[data-banner="stale"]');
    await expect(stale).toContainText("Ultima actualizare: acum 30 de ore");
    await expect(stale).toContainText("Cantitățile pot fi depășite");
    await expect(stale).toHaveAttribute("data-tone", "danger");

    await setE2eStockSnapshot(3);
    await page.reload();
    await expect(page.locator('[data-banner="fresh"]')).toContainText("Actualizat acum 3 ore");
  });
});

test.describe("Panoul: cardul «Sincronizare SmartBill»", () => {
  test("urmează starea sincronizării: la zi, neimportat, neactualizat, apoi la zi; cardul duce în pagina Stoc, unde e banner-ul", async ({
    page,
    request,
    baseURL,
  }) => {
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, "/admin");
    const card = page.locator('[data-alert="snapshot"]');
    try {
      // la zi (3 h)
      await expect(card).toHaveAttribute("data-status", "fresh");
      await expect(card).toHaveAttribute("data-tone", "ok");
      await expect(card).toContainText("Sincronizare SmartBill");
      await expect(card).toContainText("La zi");
      await expect(card).toContainText("Actualizat acum 3 ore");

      // niciun import
      await setE2eStockSnapshot(null);
      await page.reload();
      await expect(card).toHaveAttribute("data-status", "never");
      await expect(card).toHaveAttribute("data-tone", "danger");
      await expect(card).toContainText("Neimportat");
      await expect(card).toContainText("Stocul nu a fost încă importat din SmartBill");

      // ora ultimei actualizări mutată înapoi (30 h, pragul e 24 h): avertisment
      await setE2eStockSnapshot(30);
      await page.reload();
      await expect(card).toHaveAttribute("data-status", "stale");
      await expect(card).toHaveAttribute("data-tone", "danger");
      await expect(card).toContainText("Neactualizat");
      await expect(card).toContainText("Ultima actualizare: acum 30 de ore");
      await expect(card).toContainText("Cantitățile pot fi depășite");

      // cardul duce în pagina Stoc, unde banner-ul spune același lucru
      await card.click();
      await expect(page).toHaveURL(/\/admin\/produse\/stoc$/);
      await expect(page.locator('[data-banner="stale"]')).toBeVisible();
    } finally {
      await setE2eStockSnapshot(3);
    }
    await page.goto("/admin");
    await expect(card).toHaveAttribute("data-status", "fresh");
    await expect(card).toContainText("Actualizat acum 3 ore");
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

  test("ora efectivă dinaintea ultimei actualizări: ajustarea se salvează, cu avertisment în română", async ({
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
    await expect(warnings).toContainText(
      "Ora efectivă este dinaintea ultimei actualizări din SmartBill",
    );
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
      // doar inventory.read: grupul «Catalog» are un singur element (Stoc), deschis pe pagina lui
      const menu = readerPage.getByRole("navigation", { name: "Navigare principală" });
      const catalog = menu.getByRole("button", { name: "Catalog", exact: true });
      await expect(menu.locator('[data-nav-group="catalog"] ul').getByRole("link")).toHaveText([
        "Stoc",
      ]);
      await readerPage.goto("/admin");
      // un clic dat înainte de hidratare se pierde: repetăm până se deschide grupul
      await expect(async () => {
        if ((await catalog.getAttribute("aria-expanded")) !== "true") await catalog.click();
        await expect(catalog).toHaveAttribute("aria-expanded", "true", { timeout: 2_000 });
      }).toPass({ timeout: 15_000 });
      await menu.getByRole("link", { name: "Stoc", exact: true }).click();
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
      // vederea «Stoc mic» (?filtru=stoc-mic) se vede cu citire, dar fără «Prag» și fără «Ajustează»
      await readerPage.goto(`/admin/produse/stoc?q=${encodeURIComponent(search)}&filtru=stoc-mic`);
      await expect(readerPage.locator("[data-low-row]").first()).toBeVisible();
      await expect(
        readerPage.getByRole("button", { name: /^Setează pragul de stoc mic:/ }),
      ).toHaveCount(0);
      await expect(adjustButton(readerPage.locator("body"))).toHaveCount(0);
      await expect(
        readerPage
          .locator("[data-low-row]")
          .first()
          .getByRole("link", { name: /^Istoricul stocului:/ }),
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

/**
 * Faza 5, punctul 12c: importul «stoc la zi» din SmartBill în browser (`/admin/produse/stoc/import`). Fișiere FABRICATE
 * (rânduri inventate, cu structura raportului). Stau în fișierul care deține starea pozei de stoc: testele de aici creează
 * poze pe depozitul implicit și le șterg la final (la fel și alegerea gestiunilor), iar fișierul rulează serial.
 */
const tagImport = randomBytes(3).toString("hex");
const GEST = `Gestiune E2E ${tagImport}`;
let importSkus: string[] = [];

function reportFile(
  rows: Array<{ warehouse?: string; code: string; unit: string; quantity: number }>,
): { name: string; mimeType: string; buffer: Buffer } {
  return {
    name: E2E_STOCK_IMPORT_FILE,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: buildReport({
      format: "xlsx",
      // o dată veche, fixă: raportul nu e niciodată «de azi», deci ora are mereu avertismente
      dateText: "Data: 15.03.2020",
      rows: rows.map((r) => ({ warehouse: GEST, ...r })),
    }),
  };
}

test.describe("importul «stoc la zi»", () => {
  test.beforeAll(async () => {
    importSkus = await seedE2eStock(tagImport, [
      { title: `Import A E2E ${tagImport}`, variants: [{ sku: "IA", physical: "0" }] },
      { title: `Import B E2E ${tagImport}`, variants: [{ sku: "IB", physical: "2" }] },
    ]);
  });

  test.afterAll(async () => {
    await removeE2eStock({ tag: tagImport });
    await removeE2eStockImports();
    // pozele mutate de import nu trebuie să schimbe starea așteptată de restul fișierului
    await setE2eStockSnapshot(3);
  });

  test("Manager: alege gestiunea, verifică, bifează ora și aplică; stocul, istoricul și auditul se schimbă", async ({
    page,
    request,
    baseURL,
  }) => {
    failOnNativeDialog(page);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, "/admin/produse/stoc");
    await page.getByRole("link", { name: "Import stoc la zi" }).click();
    await expect(page).toHaveURL(/\/admin\/produse\/stoc\/import$/);
    await expect(
      page.getByRole("heading", { level: 1, name: "Import «stoc la zi» din SmartBill" }),
    ).toBeVisible();
    // «Stoc» rămâne evidențiat în meniu: ecranul nu are element propriu
    await expect(
      page
        .getByRole("navigation", { name: "Navigare principală" })
        .getByRole("link", { name: "Stoc", exact: true }),
    ).toHaveAttribute("aria-current", "page");

    const [A, B] = importSkus as [string, string];
    const file = reportFile([
      { code: A, unit: "BUC", quantity: 7 },
      { code: B, unit: "BUC", quantity: 5 },
      { code: skus[UNMANAGED] as string, unit: "BUC", quantity: 3 },
      { code: `NECUNOSCUT-${tagImport}`, unit: "BUC", quantity: 1 },
      { warehouse: "Alta gestiune E2E", code: A, unit: "BUC", quantity: 99 },
    ]);
    await page.locator("#stock-import-file").setInputFiles(file);
    await page.getByRole("button", { name: "Verifică fișierul" }).click();

    // gestiunea nu e aleasă: se listează cele din fișier, nealese, și nu se poate aplica
    const warehouse = page.locator(`[data-warehouse="${GEST}"]`);
    await expect(warehouse).toBeVisible();
    await expect(warehouse).toContainText("Nealeasă");
    await expect(page.getByText("Nu este aleasă nicio gestiune SmartBill")).toBeVisible();
    await expect(page.locator('[data-warehouse="Alta gestiune E2E"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Aplică raportul" })).toBeDisabled();
    await expect(page.locator("[data-counters]")).toHaveCount(0);

    // alege gestiunea și salvează: raportul apare (contoarele există doar după verificarea cu gestiunea aleasă)
    await warehouse.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Salvează gestiunile" }).click();
    await expect(page.locator('[data-counter="matched"]')).toHaveText("2");
    await expect(page.locator('[data-counter="unknown"]')).toHaveText("1");
    await expect(page.locator('[data-counter="unmanaged"]')).toHaveText("1");
    await expect(page.locator('[data-counter="otherWarehouses"]')).toHaveText("1");
    await expect(page.locator('[data-counter="errors"]')).toHaveText("0");
    await expect(page.locator(`[data-warehouse="${GEST}"]`)).toContainText("Aleasă");

    // negestionata nu se aplică (și nu i se pornește gestionarea)
    await expect(page.locator('[data-list="unmanaged"]')).toContainText(skus[UNMANAGED] as string);
    await expect(page.locator('[data-list="unknown"]')).toContainText(`NECUNOSCUT-${tagImport}`);
    // variantele lipsă din fișier: bifa «pune pe 0» există și NU este bifată
    const zero = page.locator("[data-zero-block]").getByRole("checkbox");
    await expect(zero).not.toBeChecked();

    // capturi (desktop și telefon) și verificarea că pe telefon pagina nu are derulare orizontală
    await page.screenshot({ path: "test-results/stock-import-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: "test-results/stock-import-phone.png", fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });

    // raportul din fișier are altă dată decât azi: avertisment și bifă obligatorie
    const apply = page.getByRole("button", { name: "Aplică raportul" });
    await expect(page.getByText("Avertismente despre oră")).toBeVisible();
    await expect(apply).toBeDisabled();
    await page.getByLabel("Am verificat ora și vreau să continui").check();
    await expect(apply).toBeEnabled();

    // nimic nu s-a schimbat până aici
    expect((await readE2eStock(A))?.physical).toBe("0");
    expect((await readE2eStockImports()).length).toBe(0);

    await apply.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("2 variante se schimbă");
    await dialog.getByRole("button", { name: "Aplică", exact: true }).click();
    await expect(page.locator("[data-import-result]")).toContainText("2 variante actualizate");
    await page.screenshot({ path: "test-results/stock-import-result.png", fullPage: true });

    // stocul s-a schimbat exact cu ce era în fișier; negestionata a rămas neatinsă
    expect((await readE2eStock(A))?.physical).toBe("70000");
    expect((await readE2eStock(B))?.physical).toBe("50000");
    expect((await readE2eStock(skus[UNMANAGED] as string))?.physical ?? null).toBeNull();
    expect((await readE2eStock(A))?.movements.map((m) => m.kind)).toContain("snapshot");

    // poza, istoricul și auditul
    const snapshots = await readE2eStockImports();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.fileHash).toMatch(/^[0-9a-f]{64}$/);
    const snapshotId = snapshots[0]?.id as string;
    await expect(page.locator(`[data-snapshot="${snapshotId}"]`)).toContainText(
      E2E_STOCK_IMPORT_FILE,
    );
    await expect(page.locator(`[data-snapshot="${snapshotId}"]`)).toContainText("2 schimbate");
    const audit = await readE2eAuditByEntity("stock.import.apply", snapshotId);
    expect(audit.map((r) => r.outcome)).toEqual(["success"]);
    expect(audit[0]?.after).toMatchObject({ applied: 2, zeroedMissing: 0 });
  });

  test("același fișier încă o dată: «neschimbate», fără mișcări noi", async ({
    page,
    request,
    baseURL,
  }) => {
    failOnNativeDialog(page);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, "/admin/produse/stoc/import");
    const [A, B] = importSkus as [string, string];
    const before = (await readE2eStock(A))?.movements.length;
    await page.locator("#stock-import-file").setInputFiles(
      reportFile([
        { code: A, unit: "BUC", quantity: 7 },
        { code: B, unit: "BUC", quantity: 5 },
      ]),
    );
    await page.getByRole("button", { name: "Verifică fișierul" }).click();
    await expect(page.locator('[data-counter="unchanged"]')).toHaveText("2");
    await expect(page.locator('[data-counter="changed"]')).toHaveText("0");
    expect((await readE2eStock(A))?.movements.length).toBe(before);
  });

  test("fișier cu unitate greșită: erori listate, aplicarea blocată, nimic modificat", async ({
    page,
    request,
    baseURL,
  }) => {
    failOnNativeDialog(page);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, "/admin/produse/stoc/import");
    const [A] = importSkus as [string];
    await page
      .locator("#stock-import-file")
      .setInputFiles(reportFile([{ code: A, unit: "KG", quantity: 9 }]));
    await page.getByRole("button", { name: "Verifică fișierul" }).click();
    await expect(page.locator('[data-counter="errors"]')).toHaveText("1");
    await expect(page.locator('[data-list="errors"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Aplică raportul" })).toBeDisabled();
    await expect(
      page.getByText("Raportul are erori: corectează fișierul și verifică din nou."),
    ).toBeVisible();
    expect((await readE2eStock(A))?.physical).toBe("70000");
  });

  test("un fișier care nu e Excel e refuzat cu mesaj în română", async ({
    page,
    request,
    baseURL,
  }) => {
    failOnNativeDialog(page);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, "/admin/produse/stoc/import");
    await page.locator("#stock-import-file").setInputFiles({
      name: "raport.xls",
      mimeType: "application/vnd.ms-excel",
      buffer: Buffer.from("Gestiune;Cod;U.M.;Stoc final\nA;B;C;1\n"),
    });
    await page.getByRole("button", { name: "Verifică fișierul" }).click();
    await expect(page.locator("[data-problem]")).toContainText("nu este un registru Excel");
    await expect(page.locator("[data-counters]")).toHaveCount(0);
  });

  test("fără fișier ales: mesaj propriu, fără baloane native", async ({
    page,
    request,
    baseURL,
  }) => {
    failOnNativeDialog(page);
    const manager = await createAccount(request, baseURL as string, "manager");
    await login(page, manager, "/admin/produse/stoc/import");
    await page.getByRole("button", { name: "Verifică fișierul" }).click();
    await expect(page.locator("[data-problem]")).toHaveText("Alege mai întâi un fișier.");
  });

  test("doar inventory.read: vede istoricul, dar nu poate încărca; fără drepturi: acces interzis", async ({
    page,
    request,
    baseURL,
    browser,
  }) => {
    failOnNativeDialog(page);
    await createE2eRole("e2e-stoc-citire", ["admin.access", "inventory.read"]);
    const reader = await createAccount(request, baseURL as string, "e2e-stoc-citire");
    await login(page, reader, "/admin/produse/stoc/import");
    await expect(
      page.getByRole("heading", { level: 1, name: "Import «stoc la zi» din SmartBill" }),
    ).toBeVisible();
    await expect(page.getByText("Poți vedea istoricul pozelor, dar nu poți încărca")).toBeVisible();
    await expect(page.locator("#stock-import-file")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Istoricul pozelor" })).toBeVisible();

    // ruta de încărcare refuză și forțată, fără permisiune
    const forced = await page.request.post("/api/admin/stock-imports?mode=preview", {
      headers: { origin: baseURL as string },
      data: "x",
    });
    expect(forced.status()).toBe(403);

    const other = await browser.newContext({ baseURL: baseURL as string });
    try {
      const editorPage = await other.newPage();
      const editor = await createAccount(request, baseURL as string, "editor");
      await login(editorPage, editor, "/admin/produse/stoc/import");
      await expect(editorPage).not.toHaveURL(/\/stoc\/import/);
    } finally {
      await other.close();
    }
  });

  test("anonim: trimis la autentificare; ruta de încărcare refuză cu 401", async ({
    page,
    request,
    baseURL,
  }) => {
    await page.goto("/admin/produse/stoc/import");
    await expect(page).toHaveURL(/\/autentificare/);
    const res = await request.post(`${baseURL}/api/admin/stock-imports?mode=preview`, {
      headers: { origin: baseURL as string, "x-forwarded-for": uniqueClientIp() },
      data: "x",
    });
    expect(res.status()).toBe(401);
  });
});
