import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  NotInteractiveError,
  PromptCancelledError,
  applyKeys,
  promptHidden,
  type TtyInput,
} from "./prompt";

const fresh = () => ({ value: "", escaping: false });

describe("applyKeys", () => {
  it("adaugă caractere și se oprește la Enter (\\r pe Windows, \\n în alte terminale)", () => {
    expect(applyKeys(fresh(), "abc").state.value).toBe("abc");
    expect(applyKeys(fresh(), "abc\r")).toMatchObject({ status: "done", state: { value: "abc" } });
    expect(applyKeys(fresh(), "abc\n").status).toBe("done");
  });

  it("Backspace șterge un caracter întreg (inclusiv Unicode), fără să treacă de început", () => {
    expect(applyKeys(fresh(), "ab\u007f").state.value).toBe("a");
    expect(applyKeys(fresh(), "ab\b\b\b\u007f").state.value).toBe("");
    expect(applyKeys(fresh(), "aș😀\u007f\u007f").state.value).toBe("a");
  });

  it("Ctrl+C și Ctrl+D anulează și goală valoarea", () => {
    expect(applyKeys(fresh(), "abc\u0003")).toMatchObject({
      status: "cancelled",
      state: { value: "" },
    });
    expect(applyKeys(fresh(), "x\u0004").status).toBe("cancelled");
  });

  it("ignoră săgețile și Delete (secvențe ESC), inclusiv când vin în bucăți", () => {
    expect(applyKeys(fresh(), "a\u001b[Ab\u001b[3~c").state.value).toBe("abc");
    const half = applyKeys(fresh(), "a\u001b[");
    expect(half.state.escaping).toBe(true);
    expect(applyKeys(half.state, "Db").state.value).toBe("ab");
  });

  it("ignoră caracterele de control (Tab etc.) și acceptă spații în parolă", () => {
    expect(applyKeys(fresh(), "a\tb c").state.value).toBe("ab c");
  });

  it("o lipire (paste) cu Enter la final în același chunk funcționează", () => {
    expect(applyKeys(fresh(), "parola lipita\r")).toMatchObject({
      status: "done",
      state: { value: "parola lipita" },
    });
  });
});

function fakeTty(opts: { isTTY: boolean }) {
  let listener: ((chunk: string | Buffer) => void) | undefined;
  const raw: boolean[] = [];
  const tty: TtyInput = {
    isTTY: opts.isTTY,
    setRawMode: (mode) => raw.push(mode),
    setEncoding: () => undefined,
    resume: () => undefined,
    pause: () => undefined,
    on: (_e, l) => {
      listener = l;
    },
    off: () => {
      listener = undefined;
    },
  };
  return { tty, raw, type: (text: string) => listener?.(text), listening: () => !!listener };
}

describe("promptHidden", () => {
  it("nu afișează NIMIC din ce se tastează (nici asteriscuri) și întoarce valoarea", async () => {
    const secret = randomBytes(12).toString("base64url");
    const { tty, raw, type } = fakeTty({ isTTY: true });
    const written: string[] = [];
    const promise = promptHidden("Parolă: ", tty, { write: (t) => written.push(t) });
    for (const ch of secret) type(ch); // caracter cu caracter, ca la tastare
    type("\r");
    expect(await promise).toBe(secret);

    const output = written.join("");
    expect(output).toBe("Parolă: \n"); // doar întrebarea și newline
    for (const ch of new Set(secret)) {
      if (!"Parolă: \n".includes(ch)) expect(output).not.toContain(ch);
    }
    expect(output).not.toContain("*");
    expect(raw).toEqual([true, false]); // modul raw pornit, apoi readus la normal
  });

  it("Ctrl+C anulează cu PromptCancelledError și readuce terminalul la normal", async () => {
    const { tty, raw, type, listening } = fakeTty({ isTTY: true });
    const promise = promptHidden("Parolă: ", tty, { write: () => undefined });
    type("abc\u0003");
    await expect(promise).rejects.toBeInstanceOf(PromptCancelledError);
    expect(raw).toEqual([true, false]);
    expect(listening()).toBe(false);
  });

  it("refuză fără terminal interactiv (pipe, fișier, script): parola nu poate veni de acolo", async () => {
    const write = vi.fn();
    const { tty } = fakeTty({ isTTY: false });
    await expect(promptHidden("Parolă: ", tty, { write })).rejects.toBeInstanceOf(
      NotInteractiveError,
    );
    expect(write).not.toHaveBeenCalled();
  });
});
