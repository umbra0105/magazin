import { NextResponse, type NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";
import { REQUEST_ID_HEADER, resolveRequestId } from "@ecom/shared/request-id";
import { guardDecision } from "@/lib/route-guard";

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
    hasSessionCookie: getSessionCookie(request) !== null,
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
    response = NextResponse.next({ request: { headers: requestHeaders } });
  }
  response.headers.set(REQUEST_ID_HEADER, requestId);
  // Paginile protejate depind de cookie: nu se pun în cache partajat.
  if (decision.action !== "next") response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
