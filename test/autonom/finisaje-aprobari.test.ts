import { describe, expect, it } from "vitest";
import { isApproved } from "../../scripts/autonom/aprobari";
import { blockingEntries, parseFinisaje } from "../../scripts/autonom/finisaje";

describe("docs/FINISAJE.md: intrările", () => {
  const sample = [
    "# Finisaje",
    "Text explicativ care pomenește S1 și S2 fără să fie intrare.",
    "",
    "- [ ] S3 | Media | alinierea butonului | captura-1.png",
    "- [x] S2 | Depozite | rând prea înalt | captura-2.png",
    "- [ ] S2 | Media | încărcarea se blochează | captura-3.png",
    "- [ ] S1 | Depozite | pierdere de date | captura-4.png",
    "* [X] S1 | Media | rezolvat | captura-5.png",
  ].join("\n");

  it("recunoaște doar liniile cu căsuță; severitatea e primul cuvânt, starea e căsuța", () => {
    const entries = parseFinisaje(sample);
    expect(entries.map((e) => [e.severity, e.open])).toEqual([
      ["S3", true],
      ["S2", false],
      ["S2", true],
      ["S1", true],
      ["S1", false],
    ]);
  });

  it("blochează doar S1 și S2 deschise (S3 deschis și intrările rezolvate nu blochează)", () => {
    const blocking = blockingEntries(parseFinisaje(sample));
    expect(blocking.map((e) => e.severity)).toEqual(["S2", "S1"]);
  });

  it("o intrare deschisă fără severitate recunoscută e tratată ca S2 (nivelul mai grav) și blochează", () => {
    const blocking = blockingEntries(
      parseFinisaje("- [ ] ceva neclasificat\n- [ ] s3 | minuscule"),
    );
    expect(blocking).toHaveLength(2);
    expect(blocking.every((e) => e.severity === "S2")).toBe(true);
  });

  it("o intrare marcată «în lucru» (căsuța cu ~) sau «blocată» (!) rămâne deschisă", () => {
    const blocking = blockingEntries(
      parseFinisaje("- [~] S2 | x | în lucru\n- [!] S1 | y | blocat"),
    );
    expect(blocking.map((e) => e.severity)).toEqual(["S2", "S1"]);
  });

  it("exemplele din blocuri de cod nu sunt intrări", () => {
    const text = ["```", "- [ ] S1 | exemplu | nu e real", "```", "- [ ] S3 | real | ok"].join(
      "\n",
    );
    expect(parseFinisaje(text)).toHaveLength(1);
    expect(blockingEntries(parseFinisaje(text))).toEqual([]);
  });

  it("păstrează numărul liniei pentru raport", () => {
    const entries = parseFinisaje(sample);
    expect(entries.find((e) => e.severity === "S1" && e.open)?.line).toBe(7);
  });
});

describe("docs/AUTONOM-APROBARI.md: aprobarea unei faze", () => {
  it("«aprobat» pentru faza respectivă, scris ca «- Faza N: aprobat …»", () => {
    expect(isApproved("- Faza 9: aprobat, 2026-12-01", "9")).toBe(true);
    expect(isApproved("* Faza 15b: Aprobat — verificat cap-coadă", "15b")).toBe(true);
    expect(isApproved("- Faza redesign-final: aprobat", "redesign-final")).toBe(true);
  });

  it("nu confundă fazele (9 față de 19, 15 față de 15b)", () => {
    expect(isApproved("- Faza 19: aprobat", "9")).toBe(false);
    expect(isApproved("- Faza 15b: aprobat", "15")).toBe(false);
    expect(isApproved("- Faza 15: aprobat", "15b")).toBe(false);
  });

  it("alte stări nu sunt aprobare: «neaprobat», «în așteptare», «respins», text liber", () => {
    for (const status of ["neaprobat", "în așteptare", "respins", "aprobare cerută", "da"]) {
      expect(isApproved(`- Faza 9: ${status}`, "9"), status).toBe(false);
    }
    expect(isApproved("Faza 9 e aprobată în conversație", "9")).toBe(false);
  });

  it("ultima mențiune a fazei decide (o aprobare retrasă nu mai trece)", () => {
    expect(isApproved("- Faza 9: aprobat\n- Faza 9: retras", "9")).toBe(false);
    expect(isApproved("- Faza 9: retras\n- Faza 9: aprobat", "9")).toBe(true);
  });

  it("ignoră exemplele din blocuri de cod și lipsa fișierului", () => {
    expect(isApproved("```\n- Faza 9: aprobat\n```", "9")).toBe(false);
    expect(isApproved("", "9")).toBe(false);
  });
});
