import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  insertE2eMedia,
  promoteE2eUser,
  removeE2eCatalogRefs,
  removeE2eProducts,
  seedE2eProducts,
  setE2eProductDescription,
} from "../packages/core/test/e2e-support";
import { uniqueClientIp } from "./support/client-ip";
import { expectResponseOk } from "./support/diagnostics";

/**
 * Descrierea bogată a produsului (15c), în browser: previzualizarea din administrare randează HTML-ul salvat prin aceeași
 * cale ca magazinul (re-sanitizare pe server, imagini din media, tabele derulabile, linkuri cu target și rel) și NU
 * execută nimic dintr-o valoare ostilă rămasă în bază. Produsele de probă au adresa `e2e-…`.
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

test.afterAll(async () => {
  await removeE2eProducts();
  await removeE2eCatalogRefs();
});

test.describe("descrierea bogată: previzualizarea din administrare", () => {
  test("randează formatarea, tabelul derulabil, linkurile și imaginea; nu execută nimic dintr-o valoare ostilă", async ({
    page,
    request,
    baseURL,
  }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const [title] = (await seedE2eProducts(tag, 1)) as [string];
    const slug = `e2e-${tag}-01`;
    const mediaId = await insertE2eMedia(owner.email, { name: `poza-${tag}.png`, status: "ready" });

    // valoare scrisă direct în bază (ocolind serviciul): bună + ostilă, ca să probăm re-sanitizarea de la randare
    await setE2eProductDescription(
      slug,
      `<h2>Caracteristici</h2><p>Text <strong>aldin</strong> și <em>italic</em>.</p>` +
        `<table><tbody><tr><td>Putere</td><td>0,75 kW</td></tr></tbody></table>` +
        `<p><a href="https://exemplu.ro/fisa" onclick="window.__xss=1">Fișa tehnică</a> ` +
        `<a href="javascript:window.__xss=2">link periculos</a></p>` +
        `<img data-media-id="${mediaId}" alt="Pompa montată">` +
        `<img src="https://evil.example/pixel.png" onerror="window.__xss=3">` +
        `<script>window.__xss=4</script><iframe src="https://evil.example/"></iframe>` +
        `<p onmouseover="window.__xss=5">Paragraf final</p>`,
      [mediaId],
    );

    // nicio fereastră nativă și nicio cerere către gazda ostilă
    const dialogs: string[] = [];
    page.on("dialog", (dialog) => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    const evilRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("evil.example")) evilRequests.push(req.url());
    });

    await login(page, owner, "/admin/produse");
    await openFromList(page, tag, title);

    const preview = page.locator("[data-description-preview]");
    await expect(preview.getByRole("heading", { name: "Previzualizare" })).toBeVisible();
    const body = preview.locator(".rich-text");

    // formatarea
    await expect(body.getByRole("heading", { level: 2, name: "Caracteristici" })).toBeVisible();
    await expect(body.locator("strong")).toHaveText("aldin");
    await expect(body.locator("em")).toHaveText("italic");

    // tabelul, într-o regiune derulabilă accesibilă (focalizabilă cu tastatura)
    const region = body.getByRole("region", { name: "Tabel derulabil" });
    await expect(region).toHaveAttribute("tabindex", "0");
    await expect(region.getByRole("cell", { name: "0,75 kW" })).toBeVisible();

    // linkul extern: target și rel de la server; cel periculos a rămas doar text
    const link = body.getByRole("link", { name: "Fișa tehnică" });
    await expect(link).toHaveAttribute("href", "https://exemplu.ro/fisa");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(link).not.toHaveAttribute("onclick", /.*/);
    await expect(body.getByRole("link", { name: "link periculos" })).toHaveCount(0);
    await expect(body).toContainText("link periculos");

    // imaginea din media: src generat de server, lazy, cu alt; cea cu src extern a dispărut
    const images = body.locator("img");
    await expect(images).toHaveCount(1);
    await expect(images.first()).toHaveAttribute("alt", "Pompa montată");
    await expect(images.first()).toHaveAttribute("loading", "lazy");
    await expect(images.first()).toHaveAttribute(
      "src",
      /^(https?:\/\/[^/]+)?\/media\/.+original\.png$/,
    );

    // nimic activ nu a rămas în DOM și nimic nu s-a executat
    await expect(body.locator("script, iframe, [onclick], [onerror], [onmouseover]")).toHaveCount(
      0,
    );
    await expect(body).toContainText("Paragraf final");
    expect(
      await page.evaluate(() => (window as unknown as { __xss?: number }).__xss),
    ).toBeUndefined();
    expect(dialogs).toEqual([]);
    expect(evilRequests).toEqual([]);
  });

  test("fără descriere nu există panou de previzualizare", async ({ page, request, baseURL }) => {
    const owner = await createAccount(request, baseURL as string, "owner");
    const tag = randomBytes(3).toString("hex");
    const [title] = (await seedE2eProducts(tag, 1)) as [string];
    await login(page, owner, "/admin/produse");
    await openFromList(page, tag, title);
    await expect(page.getByLabel("Descriere", { exact: true })).toBeVisible();
    await expect(page.locator("[data-description-preview]")).toHaveCount(0);
  });
});
