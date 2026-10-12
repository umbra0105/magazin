import { redirect } from "next/navigation";
import { safeNextPath } from "./route-guard";
import { getCurrentResolution } from "./session";

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * `?next=` din URL, validat cu ACEEAȘI regulă ca middleware-ul (`safeNextPath`): doar căi relative
 * din același site. Orice altceva devine `null`.
 */
export async function readNextPath(searchParams: SearchParams): Promise<string | null> {
  const raw = (await searchParams)["next"];
  return safeNextPath(typeof raw === "string" ? raw : null);
}

/** Un utilizator deja autentificat nu are ce căuta pe paginile de autentificare. */
export async function redirectIfSignedIn(nextPath: string | null): Promise<void> {
  const resolution = await getCurrentResolution();
  if (resolution.status === "ok") redirect(nextPath ?? "/cont");
}

/** Sufixul `?next=…` pentru linkurile dintre paginile de autentificare. */
export function withNext(path: string, nextPath: string | null): string {
  return nextPath ? `${path}?next=${encodeURIComponent(nextPath)}` : path;
}
