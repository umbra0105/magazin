import type * as SentryNs from "@sentry/nextjs";
import { REQUEST_ID_HEADER, getLogger, getRequestContext } from "@ecom/shared";

type SentryModule = typeof SentryNs;
type RequestErrorArgs = Parameters<SentryModule["captureRequestError"]>;

/**
 * Pune requestId-ul ca tag pe eveniment: din contextul curent (loguri) sau, în lipsă, din header-ul
 * cererii (setat de middleware), pe care Sentry îl atașează oricum evenimentului.
 */
export function tagRequestId<T extends SentryNs.ErrorEvent>(event: T): T {
  const header = event.request?.headers?.[REQUEST_ID_HEADER];
  const requestId = getRequestContext()?.requestId ?? (Array.isArray(header) ? header[0] : header);
  if (requestId) event.tags = { ...event.tags, requestId };
  return event;
}

export interface SentryControllerDeps {
  /** Citește DSN-ul din setări (`monitoring.sentryDsn`). */
  getDsn: () => Promise<string>;
  /** Încarcă SDK-ul DOAR când e nevoie: fără DSN nu se importă deloc. */
  loadSentry: () => Promise<SentryModule>;
}

/**
 * Pornește/oprește Sentry pe server în funcție de DSN-ul din setări.
 * Fără DSN: niciun import al SDK-ului, nicio inițializare, nicio cerere de rețea.
 */
export function createSentryController({ getDsn, loadSentry }: SentryControllerDeps) {
  let activeDsn = "";

  async function sync(): Promise<void> {
    let dsn = "";
    try {
      dsn = await getDsn();
    } catch (error) {
      // DB/Redis indisponibile la boot: rămâne inactiv, aplicația pornește oricum.
      getLogger().warn({ err: error }, "nu pot citi DSN-ul Sentry, monitorizarea rămâne inactivă");
    }
    if (dsn === activeDsn) return;

    if (!dsn) {
      const Sentry = await loadSentry();
      await Sentry.close();
      activeDsn = "";
      return;
    }

    const Sentry = await loadSentry();
    Sentry.init({
      dsn,
      // Doar erori: fără tracing și fără date personale (IP, cookies) implicit.
      tracesSampleRate: 0,
      dataCollection: { userInfo: false },
      beforeSend: tagRequestId,
    });
    activeDsn = dsn;
  }

  async function captureRequestError(...[error, request, context]: RequestErrorArgs) {
    if (!activeDsn) return;
    const Sentry = await loadSentry();
    const header = request.headers[REQUEST_ID_HEADER];
    const requestId = Array.isArray(header) ? header[0] : header;
    Sentry.withScope((scope) => {
      if (requestId) scope.setTag("requestId", requestId);
      Sentry.captureRequestError(error, request, context);
    });
  }

  return { sync, captureRequestError, isActive: () => activeDsn !== "" };
}
