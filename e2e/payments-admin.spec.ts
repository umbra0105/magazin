import { randomBytes } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  clearE2eSettings,
  readE2eLastPaymentId,
  readE2ePayments,
  removeE2eCartStock,
  removeE2eCarts,
  removeE2eDemoPayments,
  removeE2eOrders,
  removeE2eProducts,
  seedE2eCartProduct,
  seedE2eCheckoutSettings,
  seedE2eDemoPayments,
  setE2eCartStock,
  setE2eSettings,
  type E2eCartProduct,
} from "../packages/core/test/e2e-support";
import {
  CARD_EMAIL,
  createAccount,
  demoScenario,
  login,
  paymentState,
  placeWithCard,
  type Account,
} from "./support/card-flow";

/**
 * Ecranele de plăți din admin (Faza 10): configurarea furnizorilor (cheile nu se afișează niciodată după salvare; trecerea în LIVE e
 * refuzată fără verificare în sandbox), permisiunile (Owner configurează, Manager rambursează, Contabil doar citește, Suport nu are
 * acces), rambursarea parțială și totală, rambursarea manuală și lista «Necesită atenție». Plățile se fac prin furnizorul DEMO.
 */
const tag = randomBytes(3).toString("hex");
const EMAIL = CARD_EMAIL(tag);

test.describe.configure({ mode: "serial" });

let produs: E2eCartProduct;
const SETTING_KEYS = [
  "company.legalName",
  "company.bankName",
  "company.iban",
  "shipping.pickupEnabled",
  "checkout.orderNumberPrefix",
  "checkout.orderNumberDigits",
  "checkout.anafTimeoutMs",
];
const SECRET_KEY = randomBytes(16).toString("hex");
const MERCHANT = `MID-${randomBytes(3).toString("hex")}`;

let owner: Account;
let manager: Account;
let accountant: Account;
let support: Account;

test.beforeAll(async ({ request, baseURL }) => {
  await seedE2eCheckoutSettings();
  await setE2eSettings({ "checkout.anafTimeoutMs": 500 });
  await seedE2eDemoPayments();
  produs = await seedE2eCartProduct(tag, "plati", { price: 19_900 });
  await setE2eCartStock(produs.variantId, "50");
  owner = await createAccount(request, baseURL as string, "owner");
  manager = await createAccount(request, baseURL as string, "manager");
  accountant = await createAccount(request, baseURL as string, "accountant");
  support = await createAccount(request, baseURL as string, "support");
});

test.afterAll(async () => {
  await removeE2eDemoPayments({ tag });
  await removeE2eOrders({ tag });
  await removeE2eCarts();
  await removeE2eCartStock([produs.variantId]);
  await removeE2eProducts();
  await clearE2eSettings(SETTING_KEYS);
});

const denied = (page: Page) => expect(page).toHaveURL(/\/admin\/acces-interzis|\/cont/);

test.describe("configurarea furnizorilor", () => {
  test("cheile se salvează criptat și nu se mai afișează; formatul se validează; LIVE e refuzat fără verificare", async ({
    page,
  }) => {
    await login(page, owner, "/admin/setari/plati");
    await expect(page.getByRole("heading", { level: 1, name: "Plăți cu card" })).toBeVisible();
    const euplatesc = page.getByRole("form", { name: "EuPlătesc" });
    await expect(euplatesc).toBeVisible();
    await expect(page.getByRole("form", { name: "Netopia Payments" })).toBeVisible();
    await expect(page.getByRole("form", { name: /DEMO/ })).toBeVisible();
    // câmpurile de chei sunt mascate (tip parolă), niciodată pre-completate
    await expect(euplatesc.getByLabel(/Cheie secretă/)).toHaveAttribute("type", "password");
    await expect(euplatesc.getByLabel(/Cheie secretă/)).toHaveValue("");
    await expect(euplatesc).toContainText("neconfirmat");

    // format greșit → mesaj, nimic salvat
    await euplatesc.getByLabel(/ID comerciant/).fill(MERCHANT);
    await euplatesc.getByLabel(/Cheie secretă/).fill("nu-e-hexazecimal");
    await euplatesc.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(euplatesc.getByRole("alert")).toContainText("nu are formatul corect");

    await euplatesc.getByLabel(/Cheie secretă/).fill(SECRET_KEY);
    await euplatesc.getByRole("button", { name: "Salvează", exact: true }).click();
    await expect(euplatesc.getByText("Configurarea a fost salvată.")).toBeVisible();

    // după reîncărcare: «Salvat», câmp gol, nicio urmă a cheii în pagină
    await page.reload();
    const again = page.getByRole("form", { name: "EuPlătesc" });
    await expect(again.getByLabel(/Cheie secretă/)).toHaveValue("");
    await expect(again.getByLabel(/Cheie secretă/)).toHaveAttribute(
      "placeholder",
      /Salvat \(lasă gol/,
    );
    await expect(again.getByText("Salvat", { exact: true }).first()).toBeVisible();
    const html = await page.content();
    expect(html).not.toContain(SECRET_KEY);
    expect(html).not.toContain(SECRET_KEY.slice(0, 12));

    // LIVE: refuzat, cu mesaj clar
    await again.getByRole("button", { name: "Treci în LIVE…" }).click();
    const dialog = page.getByRole("dialog", { name: "Treci în LIVE" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Treci în LIVE", exact: true }).click();
    await expect(page.getByRole("form", { name: "EuPlătesc" }).getByRole("alert")).toContainText(
      "Trecerea în LIVE e refuzată",
    );
    await expect(page.getByRole("form", { name: "EuPlătesc" })).toContainText("Test (sandbox)");
    // jurnalul de audit nu conține cheia (verificat și de testele de integrare); aici doar că acțiunea a răspuns fără scurgeri
    expect(await page.content()).not.toContain(SECRET_KEY);
  });

  test("DEMO: testarea conexiunii și alegerea furnizorului pentru butonul «Card online»", async ({
    page,
  }) => {
    await login(page, owner, "/admin/setari/plati");
    const demo = page.getByRole("form", { name: /DEMO/ });
    await demo.getByRole("button", { name: "Testează conexiunea" }).click();
    await expect(demo.getByRole("status").filter({ hasText: "Furnizor DEMO" })).toBeVisible();

    const choice = page.getByLabel("Furnizorul folosit");
    await choice.selectOption({ label: "EuPlătesc" });
    await expect(page.getByText(/Acest furnizor nu e activ și configurat/)).toBeVisible();
    await choice.selectOption({ label: "DEMO (doar dezvoltare)" });
    await expect(page.getByText(/Acest furnizor nu e activ și configurat/)).toHaveCount(0);
    await page.getByRole("button", { name: "Salvează alegerea" }).click();
    await expect(page.getByText("Alegerea a fost salvată.")).toBeVisible();
  });

  test("IPN-urile respinse apar într-un banner cu instrucțiune", async ({
    page,
    request,
    baseURL,
  }) => {
    const response = await request.post(`${baseURL}/api/webhooks/payments/demo`, {
      data: { eventId: "fals", paymentRef: "nimic", outcome: "paid", amountMinor: 1 },
    });
    expect(response.status()).toBe(401);
    expect(await response.text()).not.toContain("fals");
    await login(page, owner, "/admin/setari/plati");
    await expect(
      page.getByRole("alert").filter({ hasText: "IPN-uri respinse în ultimele 24 h" }),
    ).toBeVisible();
    await expect(
      page.getByRole("alert").filter({ hasText: "IPN-uri respinse în ultimele 24 h" }),
    ).toContainText("Verifică cheile");
  });
});

test.describe("permisiuni", () => {
  /** Un browser curat pentru fiecare cont: o sesiune deja deschisă ar ocoli ecranul de autentificare. */
  async function asAccount(browser: Browser, account: Account, path: string) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await login(page, account, path);
    return { page, close: () => context.close() };
  }

  test("Suport nu vede plățile; Manager le vede, dar nu configurează; Contabilul doar citește", async ({
    browser,
  }) => {
    const s = await asAccount(browser, support, "/admin");
    await s.page.goto("/admin/comenzi/plati");
    await denied(s.page);
    await s.page.goto("/admin/setari/plati");
    await denied(s.page);
    await s.close();

    const m = await asAccount(browser, manager, "/admin/comenzi/plati");
    await expect(m.page.getByRole("heading", { level: 1, name: /Plăți cu cardul/ })).toBeVisible();
    await m.page.goto("/admin/setari/plati");
    await denied(m.page);
    await m.close();

    const a = await asAccount(browser, accountant, "/admin/comenzi/plati");
    await expect(a.page.getByRole("heading", { level: 1, name: /Plăți cu cardul/ })).toBeVisible();
    await a.page.goto("/admin/setari/plati");
    await denied(a.page);
    await a.close();
  });

  test("meniul arată «Plăți» doar celor care au dreptul", async ({ browser }) => {
    const a = await asAccount(browser, accountant, "/admin/comenzi/plati");
    await expect(a.page.getByRole("link", { name: "Plăți", exact: true })).toBeVisible();
    await a.close();
    const s = await asAccount(browser, support, "/admin");
    await expect(s.page.getByRole("link", { name: "Plăți", exact: true })).toHaveCount(0);
    await s.close();
  });
});

test.describe("rambursări și «necesită atenție»", () => {
  test("rambursare parțială apoi totală din admin; plafonul se aplică; Contabilul nu vede formularul", async ({
    page,
    browser,
  }) => {
    const number = await placeWithCard(page, produs, EMAIL);
    await demoScenario(page, "paid");
    await expect(paymentState(page)).toHaveAttribute("data-card-payment-state", "paid", {
      timeout: 30_000,
    });
    const paymentId = (await readE2eLastPaymentId(number)) as string;

    // Contabil: citește, nu rambursează
    const readerContext = await browser.newContext();
    const reader = await readerContext.newPage();
    await login(reader, accountant, `/admin/comenzi/plati/${paymentId}`);
    await expect(reader.getByRole("heading", { level: 1 })).toContainText(number);
    await expect(reader.getByRole("button", { name: "Rambursează…" })).toHaveCount(0);
    await expect(reader.getByText("Poți vedea plățile, dar nu poți rambursa.")).toBeVisible();
    await readerContext.close();

    // Manager: rambursează parțial 50,00 lei
    await login(page, manager, `/admin/comenzi/plati/${paymentId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(number);
    await page.getByLabel("Suma de rambursat (lei)").fill("50,00");
    // fără motiv: eroare pe câmp, nimic trimis
    await page.getByRole("button", { name: "Rambursează…" }).click();
    await expect(page.getByText("Scrie motivul rambursării.")).toBeVisible();
    await page.getByLabel("Motivul rambursării").fill("Un produs a ajuns deteriorat");
    // peste plafon
    await page.getByLabel("Suma de rambursat (lei)").fill("999,00");
    await page.getByRole("button", { name: "Rambursează…" }).click();
    await expect(page.getByText("Suma depășește ce a rămas de rambursat.")).toBeVisible();
    // suma corectă, cu confirmare în dialog
    await page.getByLabel("Suma de rambursat (lei)").fill("50,00");
    await page.getByRole("button", { name: "Rambursează…" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirmi rambursarea?" });
    await expect(dialog).toContainText("50,00");
    await dialog.getByRole("button", { name: "Rambursează", exact: true }).click();
    await expect(page.getByText("Rambursarea a fost trimisă.")).toBeVisible();
    await expect
      .poll(async () => (await readE2ePayments(number))?.orderPaymentStatus)
      .toBe("partially_refunded");
    const partial = await readE2ePayments(number);
    expect(partial?.payments[0]?.refundCommittedMinor).toBe(5_000);
    expect(partial?.refunds).toHaveLength(1);
    expect(partial?.refunds[0]).toMatchObject({
      amountMinor: 5_000,
      status: "confirmed",
      kind: "admin",
    });
    expect(partial?.orderStatus).toBe("confirmed"); // rambursarea face doar banii
    expect(partial?.commitments).toBe(1); // stocul nu se atinge

    // restul, cu butonul «Rambursează tot»
    await page.reload();
    await page.getByRole("button", { name: /Rambursează tot/ }).click();
    await expect(page.getByLabel("Suma de rambursat (lei)")).toHaveValue("174,00");
    await page.getByLabel("Motivul rambursării").fill("Restul comenzii");
    await page.getByRole("button", { name: "Rambursează…" }).click();
    await page
      .getByRole("dialog", { name: "Confirmi rambursarea?" })
      .getByRole("button", { name: "Rambursează", exact: true })
      .click();
    await expect
      .poll(async () => (await readE2ePayments(number))?.orderPaymentStatus)
      .toBe("refunded");
    const full = await readE2ePayments(number);
    expect(full?.payments[0]).toMatchObject({ status: "refunded", refundCommittedMinor: 22_400 });
    await page.reload();
    await expect(page.getByRole("button", { name: "Rambursează…" })).toHaveCount(0);
  });

  test("rambursare manuală necesară: apare în «Necesită atenție», se închide cu referință și confirmare", async ({
    page,
  }) => {
    await seedE2eDemoPayments("manual_required");
    const number = await placeWithCard(page, produs, EMAIL);
    await demoScenario(page, "paid");
    await expect(paymentState(page)).toHaveAttribute("data-card-payment-state", "paid", {
      timeout: 30_000,
    });
    const paymentId = (await readE2eLastPaymentId(number)) as string;
    await login(page, manager, `/admin/comenzi/plati/${paymentId}`);
    await page.getByLabel("Suma de rambursat (lei)").fill("10,00");
    await page.getByLabel("Motivul rambursării").fill("Test manual");
    await page.getByRole("button", { name: "Rambursează…" }).click();
    await page
      .getByRole("dialog", { name: "Confirmi rambursarea?" })
      .getByRole("button", { name: "Rambursează", exact: true })
      .click();
    await expect(page.getByText("Manuală necesară").first()).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: /Necesită atenție: Rambursare manuală/ }),
    ).toBeVisible();
    await expect(page.getByText(/Rambursează din contul procesatorului/).first()).toBeVisible();

    // lista «Necesită atenție» o conține
    await page.goto("/admin/comenzi/plati?vedere=atentie");
    await expect(page.getByRole("link", { name: number })).toBeVisible();

    // «Am rambursat manual»
    await page.goto(`/admin/comenzi/plati/${paymentId}`);
    await page.getByLabel("Referința operațiunii din contul procesatorului").fill("TX-E2E-1");
    await page.getByRole("button", { name: "Am rambursat manual…" }).click();
    await page
      .getByRole("dialog", { name: /Confirmi că suma a fost rambursată/ })
      .getByRole("button", { name: "Da, am rambursat" })
      .click();
    await expect(page.getByText("TX-E2E-1")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Confirmată").first()).toBeVisible();
    await seedE2eDemoPayments("confirmed");
    const snapshot = await readE2ePayments(number);
    expect(snapshot?.refunds[0]).toMatchObject({ status: "confirmed", amountMinor: 1_000 });
  });

  test("suma greșită apare în «Necesită atenție», cu instrucțiune în română", async ({ page }) => {
    const number = await placeWithCard(page, produs, EMAIL);
    await demoScenario(page, "wrong");
    await expect(paymentState(page)).toHaveAttribute("data-card-payment-state", "attention", {
      timeout: 30_000,
    });
    const paymentId = (await readE2eLastPaymentId(number)) as string;
    await login(page, manager, "/admin/comenzi/plati?vedere=atentie");
    await expect(page.getByRole("link", { name: number })).toBeVisible();
    await page.goto(`/admin/comenzi/plati/${paymentId}`);
    await expect(
      page.getByRole("heading", { name: /Necesită atenție: Sumă diferită/ }),
    ).toBeVisible();
    await expect(page.getByText(/Comanda NU a fost confirmată/)).toBeVisible();
  });
});
