import { expect, type APIRequestContext, type Page } from "@playwright/test";
import {
  E2E_ORDER_EMAIL_DOMAIN,
  promoteE2eUser,
  type E2eCartProduct,
} from "../../packages/core/test/e2e-support";
import { randomBytes } from "node:crypto";
import { uniqueClientIp } from "./client-ip";
import { expectResponseOk } from "./diagnostics";

/**
 * Pașii comuni ai testelor cu plată prin card (DEMO): coș, checkout până la plată, plasare cu «Card online» și conturi de admin
 * cu rol. Folosiți de `card-payments.spec.ts` și de `payments-admin.spec.ts`.
 */
export const CARD_EMAIL = (tag: string): string => `card-${tag}${E2E_ORDER_EMAIL_DOMAIN}`;

export async function addToCart(page: Page, product: E2eCartProduct): Promise<void> {
  await page.goto(`/produs/${product.slug}`);
  await page.locator("[data-add-button]").click();
  await expect(page.locator("[data-cart-drawer] [data-cart-line]").first()).toBeVisible();
}

export const step = (page: Page, id: string) => page.locator(`[data-step="${id}"]`);
const next = async (page: Page, id: string) => {
  await page.locator(`[data-continue="${id}"]`).click();
};

export async function toPayment(page: Page, email: string): Promise<void> {
  await page.goto("/cos");
  await page.locator("main [data-checkout]").click();
  await expect(page).toHaveURL(/\/checkout$/);
  await step(page, "contact").getByLabel("Adresa de email").fill(email);
  await step(page, "contact").getByLabel("Telefon").fill("0722 123 456");
  await next(page, "contact");
  const delivery = step(page, "delivery");
  await expect(delivery.getByLabel("Nume și prenume")).toBeVisible();
  await delivery.getByLabel("Nume și prenume").fill("Ion Popescu");
  await delivery.getByLabel("Județ").selectOption({ label: "Alba" });
  const locality = delivery.getByLabel("Localitate");
  await expect(locality).toBeEnabled();
  await expect(locality.locator("option")).not.toHaveCount(1);
  await locality.selectOption({ label: "Alba Iulia" });
  await delivery
    .getByLabel("Strada, numărul, blocul, apartamentul")
    .fill("Str. Exemplu 1, bl. A, ap. 2");
  await delivery.getByLabel("Cod poștal").fill("510005");
  await next(page, "delivery");
  await expect(step(page, "shipping").locator('[data-offer="demo:courier"]')).toBeVisible();
  await step(page, "shipping").locator('[data-offer="demo:courier"] input').check();
  await next(page, "shipping");
  await expect(step(page, "billing")).toBeVisible();
  await next(page, "billing");
  await expect(step(page, "payment").locator("[data-method]").first()).toBeVisible();
}

/** Plasează o comandă cu card și ajunge pe pagina procesatorului (DEMO). Întoarce numărul comenzii. */
export async function placeWithCard(
  page: Page,
  product: E2eCartProduct,
  email: string,
): Promise<string> {
  await addToCart(page, product);
  await toPayment(page, email);
  await step(page, "payment").locator('[data-method="card"] input').check();
  await next(page, "payment");
  await page.getByRole("checkbox", { name: /Am citit și sunt de acord/ }).check();
  await page.locator("[data-checkout-submit]").click();
  await expect(page).toHaveURL(/\/plata-demo\//);
  await expect(page.getByRole("note").filter({ hasText: "DEMO" })).toBeVisible();
  const text = await page.locator("main").innerText();
  const match = /E2E-\d{6}/.exec(text);
  expect(match, text).not.toBeNull();
  return match![0];
}

export const demoScenario = (page: Page, scenario: "paid" | "wrong" | "failed" | "triple") =>
  page.locator(`[data-demo-scenario="${scenario}"]`).click();

export const paymentState = (page: Page) => page.locator("[data-card-payment-state]");

export interface Account {
  email: string;
  password: string;
}

/** Cont nou cu rolul dat (`owner`, `manager`, `accountant`, `support`…), creat prin API-ul real de înregistrare. */
export async function createAccount(
  request: APIRequestContext,
  baseURL: string,
  role: string,
): Promise<Account> {
  const email = `e2e-${randomBytes(5).toString("hex")}@example.test`;
  const password = randomBytes(18).toString("base64url");
  const response = await request.post(`${baseURL}/api/auth/sign-up/email`, {
    headers: { origin: baseURL, "x-forwarded-for": uniqueClientIp() },
    data: { name: `${role} E2E`, email, password },
  });
  await expectResponseOk(response, "înregistrarea contului de test");
  await promoteE2eUser(email, role);
  return { email, password };
}

export async function login(page: Page, account: Account, next: string): Promise<void> {
  await page.goto(`/autentificare?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Parolă", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Intră în cont" }).click();
  await page.waitForURL((url) => url.pathname === next.split("?")[0]);
}
