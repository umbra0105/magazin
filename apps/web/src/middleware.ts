import { NextResponse, type NextRequest } from "next/server";
import { REQUEST_ID_HEADER, resolveRequestId } from "@ecom/shared/request-id";
import { PATHNAME_HEADER, guardDecision } from "@/lib/route-guard";
import {
  MAINTENANCE_FLAG_PATH,
  MAINTENANCE_PATH,
  MAINTENANCE_RETRY_AFTER_SECONDS,
  createMaintenanceProbe,
  isMaintenanceExempt,
} from "@/lib/maintenance";
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
export function createMiddleware(deps: { isInMaintenance: (origin: string) => Promise<boolean> }) {
  return async function middleware(request: NextRequest): Promise<NextResponse> {
    const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));

    const decision = guardDecision({
      pathname: request.nextUrl.pathname,
      search: request.nextUrl.search,
      hasSessionCookie: hasSessionCookie(request.headers.get("cookie")),
    });

    // Mentenanță: vizitatorii vitrinei primesc pagina de mentenanță cu 503; adminul, API-ul și fișierele statice rămân accesibile.
    if (decision.action === "next" && !isMaintenanceExempt(request.nextUrl.pathname)) {
      if (await deps.isInMaintenance(request.nextUrl.origin)) {
        const target = request.nextUrl.clone();
        target.pathname = MAINTENANCE_PATH;
        target.search = "";
        const blocked = NextResponse.rewrite(target, {
          status: 503,
          headers: { "Retry-After": String(MAINTENANCE_RETRY_AFTER_SECONDS) },
        });
        blocked.headers.set(REQUEST_ID_HEADER, requestId);
        blocked.headers.set("Cache-Control", "no-store");
        return blocked;
      }
    }

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
  };
}

/** Citirea flagului de mentenanță printr-o cerere către aplicație (Edge nu are acces la baza de date), cu cache scurt în proces. */
const defaultProbe = createMaintenanceProbe({
  read: async (origin) => {
    const response = await fetch(`${origin}${MAINTENANCE_FLAG_PATH}`, { cache: "no-store" });
    if (!response.ok) return false;
    const body = (await response.json()) as { enabled?: unknown };
    return body.enabled === true;
  },
  now: () => Date.now(),
});

export const middleware = createMiddleware({ isInMaintenance: defaultProbe });

/**
 * Rutele de ÎNCĂRCARE (media, documente de produs, fișiere de import) sunt scoase din middleware: cu middleware, Next
 * memorează corpul cererii înainte de orice verificare, iar pentru ele limita ar trebui ridicată la 50 MB, deci orice
 * anonim ar putea hrăni orice rută cu corpuri de 50 MB (Blocul C, C-07). Handlerele lor își citesc singure corpul pe flux,
 * cu limită proprie, și verifică origine, sesiune, permisiune și rată înaintea oricărei lucrări (testele de rută).
 * Restul rutelor rămân sub middleware, cu limita mică din `next.config.ts`.
 */
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|api/media$|api/admin/product-imports$|api/admin/stock-imports$|api/admin/stock-activations$|api/admin/products/[^/]+/documents$).*)",
  ],
};
