import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import {
  insertE2eMedia,
  promoteE2eUser,
  readE2eDescriptionMediaIds,
  readE2eProductDescription,
  removeE2eCatalogRefs,
  removeE2eProducts,
  seedE2eProducts,
  setE2eProductDescription,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Editorul vizual al descrierii (15c, pasul 6), în browser: toolbar cu tastatură, formatare, link prin dialog propriu,
 * tabel, imagine din biblioteca media, lipire de conținut ostil, salvare sanitizată pe server, drepturi pe roluri și lipsa
 * falsei stări «modificat». Produsele de probă au adresa `e2e-…`.
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
  await page.waitForURL((url) => url.pathname === new URL(next, "http://x").pathname);
}

async function openFromList(page: Page, tag: string, title: string) {
  await page.goto(`/admin/produse?q=${encodeURIComponent(`E2E ${tag}`)}`);
  await page.getByRole("link", { name: `Deschide produsul ${title}` }).click();
  await page.waitForURL(/\/admin\/produse\/[A-Za-z0-9_-]+(\?|$)/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(title);
}

const save = (page: Page) => page.getByRole("button", { name: "Salvează", exact: true });
const editorOf = (page: Page): Locator =>
  page.getByRole("textbox", { name: "Descriere", exact: true });
const toolbarOf = (page: Page): Locator =>
  page.getByRole("toolbar", { name: "Formatarea descrierii" });

async function setup(page: Page, request: APIRequestContext, baseURL: string, role = "owner") {
  const account = await createAccount(request, baseURL, role);
  const tag = randomBytes(3).toString("hex");
  const [title] = (await seedE2eProducts(tag, 1)) as [string];
  return { account, tag, title, slug: `e2e-${tag}-01` };
}

test.describe.configure({ mode: "serial", timeout: 150_000 });

test.afterEach(async () => {
  await removeE2eProducts();
  await removeE2eCatalogRefs();
});

test.describe("editorul vizual al descrierii", () => {
  test("scrie, formatează, pune link, tabel și imagine; salvează sanitizat; după reîncărcare conținutul persistă", async ({
    page,
    request,
    baseURL,
  }) => {
    const { account, tag, title, slug } = await setup(page, request, baseURL as string);
    const imageName = `poza-${tag}.png`;
    const mediaId = await insertE2eMedia(account.email, { name: imageName, status: "ready" });
    await login(page, account, "/admin/produse");
    await openFromList(page, tag, title);

    const editor = editorOf(page);
    const toolbar = toolbarOf(page);
    await expect(toolbar).toBeVisible();
    await editor.click();

    // titlu: se scrie întâi textul, apoi blocul devine «Titlu 2»
    await page.keyboard.type("Prezentare generală");
    await toolbar.getByLabel("Format text").selectOption({ label: "Titlu 2" });
    await expect(editor.locator("h2")).toHaveText("Prezentare generală");

    // paragraf cu aldin pornit/oprit din buton
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Text ");
    await toolbar.getByRole("button", { name: "Aldin" }).click();
    await expect(toolbar.getByRole("button", { name: "Aldin" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.keyboard.type("aldin");
    await toolbar.getByRole("button", { name: "Aldin" }).click();
    await page.keyboard.type(" și normal.");
    await expect(editor.locator("strong")).toHaveText("aldin");

    // listă cu buline
    await page.keyboard.press("Enter");
    await toolbar.getByRole("button", { name: "Listă cu buline" }).click();
    await page.keyboard.type("unu");
    await page.keyboard.press("Enter");
    await page.keyboard.type("doi");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(editor.locator("ul li")).toHaveCount(2);

    // link: textul selectat primește adresa din dialogul propriu (fără prompt nativ); adresa fără schemă primește https
    await page.keyboard.type("Fișa tehnică");
    await page.keyboard.press("Shift+Home");
    await toolbar.getByRole("button", { name: "Link", exact: true }).click();
    const linkDialog = page.getByRole("dialog", { name: "Adaugă link" });
    await linkDialog.getByLabel("Adresa linkului").fill("javascript:alert(1)");
    await linkDialog.getByRole("button", { name: "Aplică" }).click();
    await expect(linkDialog.getByText("Adresa nu e acceptată")).toBeVisible();
    await linkDialog.getByLabel("Adresa linkului").fill("exemplu.ro/fisa");
    await linkDialog.getByRole("button", { name: "Aplică" }).click();
    await expect(linkDialog).toBeHidden();
    await expect(editor).toBeFocused();
    await expect(editor.getByRole("link", { name: "Fișa tehnică" })).toHaveAttribute(
      "href",
      "https://exemplu.ro/fisa",
    );

    // tabel 2 × 2 cu antet, completat cu Tab (cursorul merge la sfârșitul documentului: textul cu link rămâne neatins)
    await page.keyboard.press("Control+End");
    await toolbar.getByRole("button", { name: "Tabel", exact: true }).click();
    const tableDialog = page.getByRole("dialog", { name: "Inserează un tabel" });
    await tableDialog.getByLabel("Rânduri").fill("2");
    await tableDialog.getByLabel("Coloane").fill("2");
    await tableDialog.getByRole("button", { name: "Inserează" }).click();
    await expect(tableDialog).toBeHidden();
    await expect(editor).toBeFocused();
    await expect(editor.locator("table")).toHaveCount(1);
    await page.keyboard.type("Caracteristică");
    await page.keyboard.press("Tab");
    await page.keyboard.type("Valoare");
    await page.keyboard.press("Tab");
    await page.keyboard.type("Putere");
    await page.keyboard.press("Tab");
    await page.keyboard.type("0,75 kW");
    // unelte de tabel apar doar cu cursorul în tabel
    await expect(page.getByRole("group", { name: "Unelte tabel" })).toBeVisible();

    // imagine din biblioteca media, cu text alternativ, după tabel (cursorul iese din tabel la sfârșitul documentului)
    await page.keyboard.press("Control+End");
    await toolbar.getByRole("button", { name: "Imagine din bibliotecă" }).click();
    const picker = page.getByRole("dialog", { name: "Alege imaginea pentru descriere" });
    await picker.getByLabel("Caută după nume, text alternativ sau tag").fill(tag);
    await picker.getByRole("button", { name: "Caută" }).click();
    await picker.getByRole("button", { name: new RegExp(`^(Alege )?poza-${tag}`) }).click();
    await picker.getByRole("button", { name: "Alege 1 imagine" }).click();
    await expect(editor.locator("img[data-media-id]")).toHaveCount(1);
    await page.getByLabel("Text alternativ al imaginii").fill("Pompa montată");

    // până aici nimic nu s-a trimis: căutarea din selectorul media și celelalte dialoguri nu salvează produsul
    await expect(page.getByRole("status").filter({ hasText: "salvate" })).toHaveCount(0);
    expect(await readE2eProductDescription(slug)).toBeNull();

    // salvare
    await save(page).click();
    await expect(page.getByRole("status").filter({ hasText: "salvate" })).toBeVisible();

    const stored = (await readE2eProductDescription(slug)) ?? "";
    expect(stored).toContain("<h2>Prezentare generală</h2>");
    expect(stored).toContain("<p>Text <strong>aldin</strong> și normal.</p>");
    expect(stored).toContain("<ul><li><p>unu</p></li><li><p>doi</p></li></ul>");
    expect(stored).toContain(
      '<a href="https://exemplu.ro/fisa" target="_blank" rel="noopener noreferrer">Fișa tehnică</a>',
    );
    expect(stored).toMatch(
      /<table>.*<th><p>Caracteristică<\/p><\/th>.*<td><p>0,75 kW<\/p><\/td>.*<\/table>/s,
    );
    expect(stored).toContain(`<img alt="Pompa montată" data-media-id="${mediaId}" />`);
    // niciun src, class sau style din editor nu a ajuns în bază
    expect(stored).not.toMatch(/\ssrc=|\sclass=|\sstyle=|\scolwidth=/);
    expect(await readE2eDescriptionMediaIds(slug)).toEqual([mediaId]);

    // previzualizarea (server) arată același conținut
    const preview = page.locator("[data-description-preview] .rich-text");
    await expect(
      preview.getByRole("heading", { level: 2, name: "Prezentare generală" }),
    ).toBeVisible();
    await expect(preview.getByRole("cell", { name: "0,75 kW" })).toBeVisible();

    // după reîncărcare, editorul pornește cu același conținut, fără stare «modificat»
    await page.reload();
    await expect(editorOf(page).locator("h2")).toHaveText("Prezentare generală");
    await expect(editorOf(page).locator("img[data-media-id]")).toHaveCount(1);
    await expect(editorOf(page).locator("table")).toHaveCount(1);
    await expect(page.getByRole("tab", { name: /^General/ })).not.toContainText("nesalvate");
  });

  test("conținut ostil lipit în editor nu se execută și nu se salvează; fără ferestre native", async ({
    page,
    request,
    baseURL,
  }) => {
    const { account, tag, title, slug } = await setup(page, request, baseURL as string);
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    const evilRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("evil.example")) evilRequests.push(req.url());
    });

    await login(page, account, "/admin/produse");
    await openFromList(page, tag, title);
    const editor = editorOf(page);
    await editor.click();

    const hostile =
      '<p>ok</p><img src=x onerror="window.__xss=1"><script>window.__xss=2</script>' +
      '<a href="javascript:window.__xss=3">link</a><iframe src="https://evil.example/"></iframe>' +
      '<img src="https://evil.example/pixel.png"><p style="color:red" onmouseover="window.__xss=4">mouse</p>';
    await editor.evaluate((element, html) => {
      const data = new DataTransfer();
      data.setData("text/html", html);
      data.setData("text/plain", "text simplu");
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, hostile);

    await expect(editor).toContainText("ok");
    await expect(editor).toContainText("mouse");
    await expect(
      editor.locator("script, iframe, img, [onerror], [onmouseover], [style]"),
    ).toHaveCount(0);
    await expect(editor.getByRole("link")).toHaveCount(0);

    await save(page).click();
    await expect(page.getByRole("status").filter({ hasText: "salvate" })).toBeVisible();
    const stored = (await readE2eProductDescription(slug)) ?? "";
    expect(stored).toContain("ok");
    expect(stored).toContain("mouse");
    expect(stored).not.toMatch(
      /script|iframe|onerror|onmouseover|javascript:|style=|evil\.example|<img/i,
    );
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
    expect(dialogs).toEqual([]);
    expect(evilRequests).toEqual([]);
  });

  test("tastatură: bara de unelte e un singur punct de Tab cu săgeți; Ctrl+B formatează în editor", async ({
    page,
    request,
    baseURL,
  }) => {
    const { account, tag, title } = await setup(page, request, baseURL as string);
    await login(page, account, "/admin/produse");
    await openFromList(page, tag, title);

    const toolbar = toolbarOf(page);
    const buttons = toolbar.getByRole("button");
    const first = buttons.first();
    await first.focus();
    await expect(first).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(buttons.nth(1)).toBeFocused();
    await page.keyboard.press("End");
    await expect(buttons.last()).toBeFocused();
    // Home duce la primul element al barei: lista «Format text»
    await page.keyboard.press("Home");
    await expect(toolbar.getByLabel("Format text")).toBeFocused();
    // un singur punct de Tab: din bară, Tab duce în editor
    await page.keyboard.press("Tab");
    await expect(editorOf(page)).toBeFocused();

    await page.keyboard.type("a ");
    await page.keyboard.press("Control+b");
    await page.keyboard.type("gros");
    await expect(editorOf(page).locator("strong")).toHaveText("gros");
  });

  test("fără drept de conținut, editorul e doar pentru citire: fără bară de unelte, previzualizarea rămâne", async ({
    page,
    request,
    baseURL,
  }) => {
    const { account, tag, title, slug } = await setup(
      page,
      request,
      baseURL as string,
      "warehouse",
    );
    await setE2eProductDescription(slug, "<h2>Titlu</h2><p>Text de citit.</p>");
    await login(page, account, "/admin/produse");
    await openFromList(page, tag, title);

    const editor = editorOf(page);
    await expect(editor).toContainText("Text de citit.");
    await expect(editor).toHaveAttribute("contenteditable", "false");
    await expect(toolbarOf(page)).toHaveCount(0);
    await expect(page.locator("[data-description-preview] .rich-text")).toContainText(
      "Text de citit.",
    );
  });

  test("golirea editorului și salvarea scriu NULL, nu un paragraf gol; previzualizarea dispare", async ({
    page,
    request,
    baseURL,
  }) => {
    const { account, tag, title, slug } = await setup(page, request, baseURL as string);
    await setE2eProductDescription(slug, "<p>De șters.</p>");
    await login(page, account, "/admin/produse");
    await openFromList(page, tag, title);

    const editor = editorOf(page);
    await editor.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await save(page).click();
    await expect(page.getByRole("status").filter({ hasText: "salvate" })).toBeVisible();
    await expect.poll(async () => await readE2eProductDescription(slug)).toBeNull();
    await expect(page.locator("[data-description-preview]")).toHaveCount(0);
  });

  test("Enter în dialogurile editorului le aplică, fără să trimită formularul (produsul nu se salvează)", async ({
    page,
    request,
    baseURL,
  }) => {
    const { account, tag, title, slug } = await setup(page, request, baseURL as string);
    await login(page, account, "/admin/produse");
    await openFromList(page, tag, title);
    const editor = editorOf(page);
    const toolbar = toolbarOf(page);
    await editor.click();
    await page.keyboard.type("Vezi pagina");
    await page.keyboard.press("Shift+Home");

    await toolbar.getByRole("button", { name: "Link", exact: true }).click();
    const linkDialog = page.getByRole("dialog", { name: "Adaugă link" });
    await linkDialog.getByLabel("Adresa linkului").fill("https://exemplu.ro/pagina");
    await page.keyboard.press("Enter");
    await expect(linkDialog).toBeHidden();
    await expect(editor.getByRole("link", { name: "Vezi pagina" })).toBeVisible();

    await page.keyboard.press("Control+End");
    await toolbar.getByRole("button", { name: "Tabel", exact: true }).click();
    const tableDialog = page.getByRole("dialog", { name: "Inserează un tabel" });
    await tableDialog.getByLabel("Rânduri").fill("2");
    await page.keyboard.press("Enter");
    await expect(tableDialog).toBeHidden();
    await expect(editor.locator("table")).toHaveCount(1);

    // nimic nu s-a trimis: niciun mesaj «salvate» și baza e neatinsă; abia butonul «Salvează» scrie
    await expect(page.getByRole("status").filter({ hasText: "salvate" })).toHaveCount(0);
    expect(await readE2eProductDescription(slug)).toBeNull();
    await save(page).click();
    await expect(page.getByRole("status").filter({ hasText: "salvate" })).toBeVisible();
    expect(await readE2eProductDescription(slug)).toContain("Vezi pagina");
  });

  test("scrierea și ștergerea într-un editor gol nu lasă produsul în starea «modificat»", async ({
    page,
    request,
    baseURL,
  }) => {
    const { account, tag, title } = await setup(page, request, baseURL as string);
    await login(page, account, "/admin/produse");
    await openFromList(page, tag, title);
    const editor = editorOf(page);
    await editor.click();
    await page.keyboard.type("temporar");
    await expect(page.getByRole("tab", { name: /^General/ })).toContainText("nesalvate");
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await expect(page.getByRole("tab", { name: /^General/ })).not.toContainText("nesalvate");
  });

  test("o descriere salvată cu tabel, imagine, link și exponent se deschide fără a părea modificată", async ({
    page,
    request,
    baseURL,
  }) => {
    const { account, tag, title, slug } = await setup(page, request, baseURL as string);
    const mediaId = await insertE2eMedia(account.email, {
      name: `poza-${tag}.png`,
      status: "ready",
    });
    await setE2eProductDescription(
      slug,
      `<h2>Titlu</h2><p>x<sup>2</sup> și H<sub>2</sub>O <a href="https://exemplu.ro/x" target="_blank" rel="noopener noreferrer">l</a></p>` +
        `<table><tbody><tr><th>A</th><td>B</td></tr></tbody></table><img alt="Poză" data-media-id="${mediaId}" />` +
        `<ol><li><p>unu</p></li></ol><blockquote><p>citat</p></blockquote><hr />`,
      [mediaId],
    );
    await login(page, account, "/admin/produse");
    await openFromList(page, tag, title);

    const editor = editorOf(page);
    await expect(editor.locator("sup")).toHaveText("2");
    await expect(editor.locator("sub")).toHaveText("2");
    await expect(editor.locator("table")).toHaveCount(1);
    await expect(editor.locator("img[data-media-id]")).toHaveCount(1);
    await expect(editor.locator("blockquote")).toHaveCount(1);
    await expect(editor.locator("hr")).toHaveCount(1);
    await expect(page.getByRole("tab", { name: /^General/ })).not.toContainText("nesalvate");
    await save(page).click();
    await expect(page.getByText("Nu ai modificat nimic.")).toBeVisible();
  });
});
