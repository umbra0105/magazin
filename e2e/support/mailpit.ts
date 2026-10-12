/**
 * Citește emailurile din Mailpit (SMTP-ul de dezvoltare/CI) prin API-ul lui HTTP. Mailpit trebuie
 * să ruleze (docker compose local, serviciu în CI). Fiecare test folosește o adresă unică, deci
 * nu se amestecă mesajele între teste.
 */
const MAILPIT_URL = process.env["MAILPIT_URL"] ?? "http://localhost:8025";

export interface ReceivedEmail {
  id: string;
  subject: string;
  text: string;
  html: string;
}

interface Summary {
  ID: string;
  Subject: string;
}

async function findMessages(to: string): Promise<Summary[]> {
  const response = await fetch(
    `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
  );
  if (!response.ok) throw new Error(`Mailpit a răspuns ${response.status}`);
  const body = (await response.json()) as { messages?: Summary[] };
  return body.messages ?? [];
}

/**
 * Așteaptă un email pentru `to` (opțional, cu subiectul potrivit `subject`) și îl întoarce.
 * Un cont nou primește întâi emailul de verificare, deci testele cer subiectul pe care îl așteaptă.
 */
export async function waitForEmail(
  to: string,
  options: { subject?: RegExp; timeoutMs?: number } = {},
): Promise<ReceivedEmail> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const start = Date.now();
  for (;;) {
    const found = (await findMessages(to)).find(
      (m) => !options.subject || options.subject.test(m.Subject),
    );
    const id = found?.ID;
    if (id) {
      const response = await fetch(`${MAILPIT_URL}/api/v1/message/${id}`);
      const body = (await response.json()) as { Subject: string; Text: string; HTML: string };
      return { id, subject: body.Subject, text: body.Text, html: body.HTML };
    }
    if (Date.now() - start > timeoutMs) throw new Error(`Nu a ajuns niciun email pentru ${to}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Confirmă că NU ajunge niciun email pentru `to` în `ms` milisecunde. */
export async function expectNoEmail(to: string, ms = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if ((await findMessages(to)).length > 0)
      throw new Error(`A ajuns un email neașteptat pentru ${to}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** Linkul cu `#token=` din corpul unui email. */
export function extractTokenLink(body: string): string {
  const match = /https?:\/\/[^\s\])"<>]+#token=[A-Za-z0-9_%.-]+/.exec(body);
  if (!match) throw new Error("Nu am găsit linkul cu token în email");
  return match[0];
}
