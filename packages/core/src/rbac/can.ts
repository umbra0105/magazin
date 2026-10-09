import { ForbiddenError, UnauthenticatedError } from "@ecom/shared";
import type { PermissionKey } from "./catalog";

/** Rolul care are implicit toate permisiunile, inclusiv cele adăugate în versiuni viitoare. */
export const OWNER_ROLE_KEY = "owner";

/** Utilizatorul curent, așa cum îl văd verificările de acces. */
export interface PermissionSubject {
  userId: string;
  email: string;
  /** Cheile rolurilor (ex. `owner`, `support`). Gol = client obișnuit, fără acces în admin. */
  roles: readonly string[];
  permissions: ReadonlySet<string>;
}

/**
 * Accesul în zona de admin cere permisiunea explicită `admin.access` (Owner o are implicit) și cel
 * puțin un rol. Un rol fără `admin.access` și un client fără roluri nu intră în admin.
 */
export function hasAdminAccess(subject: PermissionSubject | null): subject is PermissionSubject {
  if (subject === null || subject.roles.length === 0) return false;
  return subject.roles.includes(OWNER_ROLE_KEY) || subject.permissions.has("admin.access");
}

/** Fără `admin.access` nicio altă permisiune nu contează: ea e poarta către toate acțiunile de admin. */
export function can(subject: PermissionSubject | null, permission: PermissionKey): boolean {
  if (!hasAdminAccess(subject)) return false;
  return subject.roles.includes(OWNER_ROLE_KEY) || subject.permissions.has(permission);
}

/** Aruncă `UnauthenticatedError` fără utilizator și `ForbiddenError` fără permisiune. */
export function assertCan(
  subject: PermissionSubject | null,
  permission: PermissionKey,
): asserts subject is PermissionSubject {
  if (!subject) throw new UnauthenticatedError();
  if (!can(subject, permission)) throw new ForbiddenError(permission);
}

export interface WithPermissionDeps {
  /** Utilizatorul curent din sesiune; `null` dacă nu e autentificat sau sesiunea admin a expirat. */
  getSubject: () => Promise<PermissionSubject | null>;
}

/**
 * Împachetează o server action de admin: verifică permisiunea ÎNAINTE de a rula acțiunea.
 *
 *   const withPermission = createWithPermission({ getSubject });
 *   export const saveTax = withPermission("settings.write", async (input, subject) => { ... });
 *
 * Verificarea se face pe server, la fiecare apel; ascunderea unui buton în UI nu o înlocuiește.
 */
export function createWithPermission({ getSubject }: WithPermissionDeps) {
  return function withPermission<I, O>(
    permission: PermissionKey,
    handler: (input: I, subject: PermissionSubject) => Promise<O>,
  ): (input: I) => Promise<O> {
    return async (input) => {
      const subject = await getSubject();
      assertCan(subject, permission);
      return handler(input, subject);
    };
  };
}
