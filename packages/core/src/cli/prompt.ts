import { createInterface } from "node:readline/promises";

/** Starea unei citiri de text ascuns: valoarea curentă și dacă suntem în mijlocul unei secvențe ESC. */
export interface HiddenInputState {
  value: string;
  escaping: boolean;
}

export type HiddenInputStatus = "reading" | "done" | "cancelled";

/**
 * Procesează caracterele primite în modul raw (fără echo): litere se adaugă, Backspace șterge un
 * caracter (cod Unicode întreg), Enter termină, Ctrl+C / Ctrl+D anulează, secvențele ESC (săgeți,
 * Delete) se ignoră. O lipire cu Enter la final se tratează corect (chunk cu mai multe caractere).
 */
export function applyKeys(
  state: HiddenInputState,
  chunk: string,
): { state: HiddenInputState; status: HiddenInputStatus } {
  let { value, escaping } = state;
  for (const ch of chunk) {
    if (escaping) {
      // Secvența ESC se termină la prima literă sau "~" (ex. \x1b[A, \x1b[3~).
      if (/[A-Za-z~]/.test(ch)) escaping = false;
      continue;
    }
    if (ch === "\u0003" || ch === "\u0004")
      return { state: { value: "", escaping }, status: "cancelled" };
    if (ch === "\r" || ch === "\n") return { state: { value, escaping }, status: "done" };
    if (ch === "\u001b") {
      escaping = true;
      continue;
    }
    if (ch === "\u007f" || ch === "\b") {
      value = Array.from(value).slice(0, -1).join("");
      continue;
    }
    if (ch < " ") continue; // alte caractere de control
    value += ch;
  }
  return { state: { value, escaping }, status: "reading" };
}

export interface TtyInput {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding: (encoding: BufferEncoding) => unknown;
  resume: () => unknown;
  pause: () => unknown;
  on: (event: "data", listener: (chunk: string | Buffer) => void) => unknown;
  off: (event: "data", listener: (chunk: string | Buffer) => void) => unknown;
}

export interface PromptOutput {
  write: (text: string) => unknown;
}

export class PromptCancelledError extends Error {
  constructor() {
    super("Anulat de utilizator");
    this.name = "PromptCancelledError";
  }
}

export class NotInteractiveError extends Error {
  constructor() {
    super(
      "Comanda cere un terminal interactiv. Parola nu se citește din argumente, variabile de mediu sau pipe.",
    );
    this.name = "NotInteractiveError";
  }
}

/**
 * Citește o valoare fără să o afișeze (nici ca asteriscuri). Refuză să ruleze fără terminal
 * interactiv, ca parola să nu poată veni dintr-un pipe, un fișier sau un script.
 */
export function promptHidden(
  question: string,
  input: TtyInput = process.stdin as unknown as TtyInput,
  output: PromptOutput = process.stdout,
): Promise<string> {
  if (!input.isTTY || !input.setRawMode) return Promise.reject(new NotInteractiveError());
  const setRaw = input.setRawMode.bind(input);
  return new Promise((resolve, reject) => {
    let state: HiddenInputState = { value: "", escaping: false };
    output.write(question);
    setRaw(true);
    input.setEncoding("utf8");
    input.resume();
    const onData = (chunk: string | Buffer) => {
      const result = applyKeys(state, chunk.toString());
      state = result.state;
      if (result.status === "reading") return;
      input.off("data", onData);
      setRaw(false);
      input.pause();
      output.write("\n");
      if (result.status === "cancelled") reject(new PromptCancelledError());
      else resolve(state.value);
    };
    input.on("data", onData);
  });
}

/** Citește o linie cu echo (email, nume). */
export async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}
