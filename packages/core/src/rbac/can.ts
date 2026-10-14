import { ForbiddenError, UnauthenticatedError, runWithRequestContext } from "@ecom/shared";
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

/**
 * Permisiuni care se obțin și printr-una mai largă: `products.write` (prețuri, stoc, variante...)
 * include editarea conținutului. Invers NU: `products.content.write` nu dă acces la preț, stoc sau cost.
 */
const IMPLIED_BY: Partial<Record<PermissionKey, readonly PermissionKey[]>> = {
  "products.content.write": ["products.write"],
};

/** Fără `admin.access` nicio altă permisiune nu contează: ea e poarta către toate acțiunile de admin. */
export function can(subject: PermissionSubject | null, permission: PermissionKey): boolean {
  if (!hasAdminAccess(subject)) return false;
  if (subject.roles.includes(OWNER_ROLE_KEY) || subject.permissions.has(permission)) return true;
  return (IMPLIED_BY[permission] ?? []).some((broader) => subject.permissions.has(broader));
}

/** Aruncă `UnauthenticatedError` fără utilizator și `ForbiddenError` fără permisiune. */
export function assertCan(
  subject: PermissionSubject | null,
  permission: PermissionKey,
): asserts subject is PermissionSubject {
  if (!subject) throw new UnauthenticatedError();
  if (!can(subject, permission)) throw new ForbiddenError(permission);
}

/** O încercare refuzată: nu s-a rulat nimic și nu s-a modificat nimic. */
export interface DeniedAttempt {
  /** `null` = neautentificat sau sesiune de admin expirată. */
  subject: PermissionSubject | null;
  permission: PermissionKey;
  reason: "unauthenticated" | "forbidden";
  /** Acțiunea încercată (din metadatele `withPermission`), pentru jurnal. */
  action?: string;
  entity?: string;
}

export interface WithPermissionDeps {
  /** Utilizatorul curent din sesiune; `null` dacă nu e autentificat sau sesiunea admin a expirat. */
  getSubject: () => Promise<PermissionSubject | null>;
  /**
   * Apelat la o încercare refuzată (ex. înregistrare în jurnalul de audit ca `denied`). O eroare
   * aici NU înlocuiește refuzul: utilizatorul primește oricum `ForbiddenError`/`UnauthenticatedError`.
   */
  onDenied?: (attempt: DeniedAttempt) => Promise<void> | void;
  /** `requestId`-ul cererii curente; handlerul rulează în contextul lui (apare în jurnal și loguri). */
  getRequestId?: () => Promise<string | null>;
}

/** Ce acțiune reprezintă o funcție împachetată; folosit doar la înregistrarea încercărilor refuzate. */
export interface ActionMeta {
  action: string;
  entity: string;
}

/**
 * Împachetează o server action de admin: verifică permisiunea ÎNAINTE de a rula acțiunea.
 *
 *   const withPermission = createWithPermission({ getSubject, onDenied });
 *   export const saveTax = withPermission("settings.write", async (input, subject) => { ... },
 *     { action: "settings.update", entity: "setting" });
 *
 * Verificarea se face pe server, la fiecare apel; ascunderea unui buton în UI nu o înlocuiește.
 * La refuz, handlerul NU rulează, încercarea e raportată prin `onDenied`, apoi se aruncă eroarea.
 */
export function createWithPermission({ getSubject, onDenied, getRequestId }: WithPermissionDeps) {
  return function withPermission<I, O>(
    permission: PermissionKey,
    handler: (input: I, subject: PermissionSubject) => Promise<O>,
    meta?: ActionMeta,
  ): (input: I) => Promise<O> {
    return async (input) => {
      const run = async (): Promise<O> => {
        const subject = await getSubject();
        const reason = !subject
          ? "unauthenticated"
          : !can(subject, permission)
            ? "forbidden"
            : null;
        if (reason) {
          try {
            await onDenied?.({
              subject,
              permission,
              reason,
              ...(meta && { action: meta.action, entity: meta.entity }),
            });
          } catch {
            // jurnalul de refuzuri nu trebuie să schimbe răspunsul
          }
          throw reason === "unauthenticated"
            ? new UnauthenticatedError()
            : new ForbiddenError(permission);
        }
        assertCan(subject, permission);
        return handler(input, subject);
      };
      const requestId = (await getRequestId?.()) ?? null;
      return requestId ? runWithRequestContext({ requestId }, run) : run();
    };
  };
}
