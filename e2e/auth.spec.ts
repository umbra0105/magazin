import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";

/**
 * Paginile de autentificare, în browser. Nu creează conturi și nu ating date reale: folosesc un
 * email inexistent, generat la fiecare rulare (limitele de cereri sunt pe email).
 */
const uniqueEmail = () => `e2e-${randomBytes(5).toString("hex")}@example.test`;
const WRONG_PASSWORD = () => randomBytes(12).toString("base64url");

test.describe("autentificare", () => {
  test("formularul are etichete, autocomplete corect și buton de afișare a parolei", async ({
    page,
  }) => {
    await page.goto("/autentificare");
    await expect(page.getByRole("heading", { level: 1, name: "Autentificare" })).toBeVisible();

    const email = page.getByLabel("Email");
    const password = page.getByLabel("Parolă", { exact: true });
    await expect(email).toHaveAttribute("autocomplete", "email");
    await expect(email).toHaveAttribute("type", "email");
    await expect(password).toHaveAttribute("autocomplete", "current-password");
    await expect(password).toHaveAttribute("type", "password");

    const toggle = page.getByRole("button", { name: "Arată parola" });
    await toggle.click();
    await expect(password).toHaveAttribute("type", "text");
    await expect(page.getByRole("button", { name: "Ascunde parola" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("button", { name: "Ascunde parola" }).click();
    await expect(password).toHaveAttribute("type", "password");
  });

  test("câmpuri goale: erori în română, legate de câmp prin ARIA, fără cerere către server", async ({
    page,
  }) => {
    let apiCalls = 0;
    page.on("request", (r) => {
      if (r.url().includes("/api/auth/")) apiCalls += 1;
    });
    await page.goto("/autentificare");
    await page.getByRole("button", { name: "Intră în cont" }).click();
    await expect(page.getByText("Câmpul este obligatoriu.")).toHaveCount(2);
    await expect(page.getByLabel("Email")).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByLabel("Email")).toHaveAttribute("aria-describedby", "login-email-error");
    expect(apiCalls).toBe(0);
  });

  test("credențiale greșite: mesaj generic, iar emailul și parola nu ajung în URL", async ({
    page,
  }) => {
    const email = uniqueEmail();
    const password = WRONG_PASSWORD();
    await page.goto("/autentificare");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Parolă", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Intră în cont" }).click();
    await expect(page.locator("main [role=alert]")).toHaveText("Email sau parolă incorecte.");
    expect(page.url()).not.toContain(encodeURIComponent(email));
    expect(page.url()).not.toContain(password);
    expect(new URL(page.url()).search).toBe("");
  });

  test("după 5 încercări, a 6-a spune în română peste câte minute poți reîncerca", async ({
    page,
  }) => {
    const email = uniqueEmail();
    await page.goto("/autentificare");
    for (let i = 0; i < 5; i++) {
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Parolă", { exact: true }).fill(WRONG_PASSWORD());
      await page.getByRole("button", { name: "Intră în cont" }).click();
      await expect(page.locator("main [role=alert]")).toHaveText("Email sau parolă incorecte.");
    }
    await page.getByLabel("Parolă", { exact: true }).fill(WRONG_PASSWORD());
    await page.getByRole("button", { name: "Intră în cont" }).click();
    await expect(page.locator("main [role=alert]")).toContainText(
      /Prea multe încercări\. Poți încerca din nou peste \d+ minute?\./,
    );
  });

  test("/admin fără sesiune duce la autentificare cu ?next, iar un ?next extern e ignorat", async ({
    page,
  }) => {
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/autentificare\?next=%2Fadmin$/);

    await page.goto("/autentificare?next=https%3A%2F%2Fevil.example%2F");
    const registerLink = page.getByRole("link", { name: "Creează un cont" });
    await expect(registerLink).toHaveAttribute("href", "/inregistrare");
  });

  test("telefon: fără scroll orizontal, câmpuri de cel puțin 44px înălțime", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto("/autentificare");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
    const box = await page.getByLabel("Email").boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    const submit = await page.getByRole("button", { name: "Intră în cont" }).boundingBox();
    expect(submit?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});

test.describe("celelalte pagini", () => {
  test("înregistrare: parolă nouă cu autocomplete=new-password și cerință de lungime", async ({
    page,
  }) => {
    await page.goto("/inregistrare");
    await expect(page.getByRole("heading", { level: 1, name: "Creează un cont" })).toBeVisible();
    await expect(page.getByLabel("Nume")).toHaveAttribute("autocomplete", "name");
    await expect(page.getByLabel("Parolă", { exact: true })).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
    await page.getByLabel("Nume").fill("Test");
    await page.getByLabel("Email").fill(uniqueEmail());
    await page.getByLabel("Parolă", { exact: true }).fill("scurta");
    await page.getByRole("button", { name: "Creează contul" }).click();
    await expect(page.getByText("Parola trebuie să aibă cel puțin 12 de caractere.")).toBeVisible();
  });

  test("recuperare parolă: validare de email", async ({ page }) => {
    await page.goto("/recuperare-parola");
    await expect(page.getByRole("heading", { level: 1, name: "Ai uitat parola?" })).toBeVisible();
    await page.getByLabel("Email").fill("nu-e-email");
    await page.getByRole("button", { name: "Trimite instrucțiunile" }).click();
    await expect(page.getByText("Introdu o adresă de email validă.")).toBeVisible();
  });

  test("resetare: fără token în fragment = mesaj; cu token în fragment = formular cu parolă nouă", async ({
    page,
  }) => {
    await page.goto("/resetare-parola");
    await expect(page.locator("main [role=alert]")).toContainText("incomplet");
    await page.goto("/resetare-parola#token=abcdefghijklmnopqrstuvwxyz012345");
    await expect(page.getByLabel("Parolă nouă")).toHaveAttribute("autocomplete", "new-password");
    // Tokenul e scos din adresă după citire.
    expect(page.url()).not.toContain("token");
  });

  test("verificare email: fără token = mesaj clar și retrimitere; cu token = buton de confirmare", async ({
    page,
  }) => {
    await page.goto("/verificare-email");
    await expect(
      page.getByRole("heading", { level: 1, name: "Link invalid sau expirat" }),
    ).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();

    await page.goto("/verificare-email#token=abcdefghijklmnopqrstuvwxyz012345");
    await expect(page.getByRole("button", { name: "Confirmă adresa de email" })).toBeVisible();
    expect(page.url()).not.toContain("token");
  });
});
