import { NextResponse, type NextRequest } from "next/server";
import { REQUEST_ID_HEADER, resolveRequestId } from "@ecom/shared/request-id";
import { PATHNAME_HEADER, guardDecision } from "@/lib/route-guard";
import { hasSessionCookie } from "@/lib/session-cookie";

/** Calea + query, fără parametrii interni Next (`_rsc`) care nu fac parte din adresa vizibilă. */
function pathWithoutInternalParams(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.delete("_rsc");
  const query = params.toString();
  return query ? `${url.pathname}?${query}` : url.pathname;
}

/**
 * Fiecărei cereri îi atribuie un requestId (sau îl păstrează pe cel primit) și îl întoarce în
 * răspuns. În plus, protejează `/admin/*`, `/cont/*` și `/api/admin/*` de vizitatorii fără cookie
 * de sesiune. Verificarea reală a sesiunii și a permisiunilor se face pe server (layout, actions).
 */
export function middleware(request: NextRequest) {
  const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));

  const decision = guardDecision({
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    hasSessionCookie: hasSessionCookie(request.headers.get("cookie")),
  });

  let response: NextResponse;
  if (decision.action === "redirect") {
    const url = request.nextUrl.clone();
    const [path, query] = decision.location.split("?");
    url.pathname = path ?? "/";
    url.search = query ? `?${query}` : "";
    response = NextResponse.redirect(url);
  } else if (decision.action === "unauthorized") {
    response = NextResponse.json(
      { error: { code: "AUTH_UNAUTHENTICATED", message: "Autentificarea este necesară" } },
      { status: 401 },
    );
  } else {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(REQUEST_ID_HEADER, requestId);
    // Calea cererii pentru layout-uri/pagini (ex. `?next=` la redirectul de autentificare). Antetul
    // vine mereu din middleware: orice valoare trimisă de client e suprascrisă.
    requestHeaders.set(PATHNAME_HEADER, pathWithoutInternalParams(request.nextUrl));
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }
  response.headers.set(REQUEST_ID_HEADER, requestId);
  // Paginile protejate depind de cookie: nu se pun în cache partajat.
  if (decision.action !== "next") response.headers.set("Cache-Control", "private, no-store");
  return response;
}

/**
 * Rutele de ÎNCĂRCARE (media, documente de produs, fișiere de import) sunt scoase din middleware: cu middleware, Next
 * memorează corpul cererii înainte de orice verificare, iar pentru ele limita ar trebui ridicată la 50 MB, deci orice
 * anonim ar putea hrăni orice rută cu corpuri de 50 MB (Blocul C, C-07). Handlerele lor își citesc singure corpul pe flux,
 * cu limită proprie, și verifică origine, sesiune, permisiune și rată înaintea oricărei lucrări (testele de rută).
 * Restul rutelor rămân sub middleware, cu limita mică din `next.config.ts`.
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/media$|api/admin/product-imports$|api/admin/products/[^/]+/documents$).*)",
  ],
};
