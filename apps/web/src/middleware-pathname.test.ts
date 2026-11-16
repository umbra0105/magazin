import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { createMiddleware } from "./middleware";

// fără citire reală a flagului de mentenanță (testele nu fac cereri de rețea): magazinul e deschis
const middleware = createMiddleware({ isInMaintenance: async () => false });

const forwarded = (res: Response) => res.headers.get("x-middleware-request-x-pathname");

describe("middleware: antetul intern x-pathname", () => {
  it("transmite calea + query către layout-uri, fără parametrul intern _rsc", async () => {
    const res = await middleware(
      new NextRequest("http://localhost:3000/admin/comenzi?pagina=2&_rsc=abc", {
        headers: { cookie: "better-auth.session_token=abc.def" },
      }),
    );
    expect(forwarded(res)).toBe("/admin/comenzi?pagina=2");
  });

  it("suprascrie o valoare trimisă de client (nu poate falsifica calea)", async () => {
    const res = await middleware(
      new NextRequest("http://localhost:3000/", { headers: { "x-pathname": "/admin/secret" } }),
    );
    expect(forwarded(res)).toBe("/");
  });
});
