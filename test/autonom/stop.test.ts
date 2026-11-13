import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkStop } from "../../scripts/autonom/stop-core";

/** Frâna de mână (docs/20 §6.4): `STOP.txt` în rădăcina proiectului oprește lucrul după pasul curent. */
const dirs: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ecom-stop-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("checkStop", () => {
  it("fără STOP.txt în rădăcină, poți continua", () => {
    expect(checkStop(temp())).toEqual({ stop: false, message: expect.any(String) });
  });

  it("cu STOP.txt în rădăcină (chiar gol), trebuie să te oprești, cu mesaj despre ce faci", () => {
    const dir = temp();
    writeFileSync(join(dir, "STOP.txt"), "");
    const result = checkStop(dir);
    expect(result.stop).toBe(true);
    expect(result.message).toMatch(/comite/i);
    expect(result.message).toMatch(/PROGRESS/);
  });

  it("un STOP.txt dintr-un subdirector nu contează (doar rădăcina)", () => {
    const dir = temp();
    writeFileSync(join(dir, "alt.txt"), "");
    expect(checkStop(dir).stop).toBe(false);
  });

  it("nu confundă cu alt fișier (stop.txt cu litere mici nu e frâna pe sistemele care deosebesc literele)", () => {
    const dir = temp();
    writeFileSync(join(dir, "STOP.txt.bak"), "");
    expect(checkStop(dir).stop).toBe(false);
  });
});
