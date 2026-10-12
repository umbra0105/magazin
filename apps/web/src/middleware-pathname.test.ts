import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "./middleware";

const forwarded = (res: Response) => res.headers.get("x-middleware-request-x-pathname");

describe("middleware: antetul intern x-pathname", () => {
  it("transmite calea + query către layout-uri, fără parametrul intern _rsc", () => {
    const res = middleware(
      new NextRequest("http://localhost:3000/admin/comenzi?pagina=2&_rsc=abc", {
        headers: { cookie: "better-auth.session_token=abc.def" },
      }),
    );
    expect(forwarded(res)).toBe("/admin/comenzi?pagina=2");
  });

  it("suprascrie o valoare trimisă de client (nu poate falsifica calea)", () => {
    const res = middleware(
      new NextRequest("http://localhost:3000/", { headers: { "x-pathname": "/admin/secret" } }),
    );
    expect(forwarded(res)).toBe("/");
  });
});
