import { expect, test } from "@playwright/test";
import { uniqueClientIp } from "./support/client-ip";

/**
 * Blocul C, C-07, în aplicația reală (build de producție): corpurile mari nu se mai memorează pentru rutele obișnuite,
 * iar rutele de încărcare, scoase din middleware, își fac singure verificările (fără sesiune: refuz, nu timeout).
 */

test("un corp de 6 MB trimis la autentificare e refuzat repede, fără să fie procesat", async ({
  request,
  baseURL,
}) => {
  const started = Date.now();
  const response = await request.post(`${baseURL}/api/auth/sign-in/email`, {
    headers: {
      origin: baseURL as string,
      "content-type": "application/json",
      "x-forwarded-for": uniqueClientIp(),
    },
    data: JSON.stringify({ email: `${"a".repeat(6 * 1024 * 1024)}@test.invalid`, password: "x" }),
  });
  expect([400, 401, 413, 422]).toContain(response.status());
  expect(response.status()).not.toBe(200);
  expect(Date.now() - started).toBeLessThan(15_000);
});

test("încărcarea de media fără sesiune e refuzată de handler (nu de middleware), și pentru un corp mare", async ({
  request,
  baseURL,
}) => {
  const response = await request.post(`${baseURL}/api/media`, {
    headers: { origin: baseURL as string, "x-forwarded-for": uniqueClientIp() },
    multipart: {
      file: { name: "mare.png", mimeType: "image/png", buffer: Buffer.alloc(3 * 1024 * 1024, 1) },
    },
  });
  expect([401, 403]).toContain(response.status());
});
