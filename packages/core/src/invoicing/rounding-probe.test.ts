import { describe, expect, it } from "vitest";
import {
  PROBE_SCENARIOS,
  buildProbe,
  compareMinor,
  renderProbeReport,
  type ProbeResult,
} from "./rounding-probe";

/**
 * Comenzile de probă pentru verificarea rotunjirii în SmartBill: cifrele așteptate sunt cele din docs/06 și docs/09 §2, iar raportul
 * spune clar «identic» sau «diferență de N bani». Logică pură; nu se contactează niciun serviciu.
 */
describe("comenzile de probă", () => {
  const [one, two, three] = PROBE_SCENARIOS.map(buildProbe);

  it("sunt exact 3", () => {
    expect(PROBE_SCENARIOS).toHaveLength(3);
  });

  it("1 · coșul din docs/09: 751,81 + 240,00 + 9.490,00 = 10.481,81; TVA pe linii 1.819,15", () => {
    expect(one?.lines.map((l) => l.lineTotalMinor)).toEqual([75_181, 24_000, 949_000]);
    expect(one?.totalMinor).toBe(1_048_181);
    expect(one?.taxMinor).toBe(181_915);
  });

  it("2 · liner 41,25 × 89,90 = 3.708,38 (3.708,375 rotunjit în sus) + transport 35,00", () => {
    expect(two?.lines.map((l) => l.lineTotalMinor)).toEqual([370_838, 3_500]);
    expect(two?.totalMinor).toBe(374_338);
  });

  it("3 · mozaic + transport paletizat 350,00 + taxă de ramburs 15,00, fiecare linie separată", () => {
    expect(three?.lines.map((l) => [l.kind, l.lineTotalMinor])).toEqual([
      ["product", 75_181],
      ["shipping", 35_000],
      ["cod_fee", 1_500],
    ]);
    expect(three?.totalMinor).toBe(111_681);
  });

  it("totalul și TVA-ul facturii = ce a încasat magazinul, în toate cele 3", () => {
    for (const probe of [one, two, three]) {
      expect(probe?.totalMinor).toBe(probe?.order.totalMinor);
      expect(probe?.taxMinor).toBe(probe?.order.taxMinor);
      expect(probe?.docLines.length).toBe(probe?.lines.length);
    }
  });
});

describe("compararea", () => {
  it("identic, diferență în ambele sensuri, necitit", () => {
    expect(compareMinor(1_048_181, 1_048_181)).toEqual({ verdict: "identic", diffMinor: 0 });
    expect(compareMinor(1_048_181, 1_048_182)).toEqual({ verdict: "diferență", diffMinor: 1 });
    expect(compareMinor(1_048_181, 1_048_180)).toEqual({ verdict: "diferență", diffMinor: -1 });
    expect(compareMinor(100, null)).toEqual({ verdict: "necitit", diffMinor: null });
  });
});

describe("raportul", () => {
  const probes = PROBE_SCENARIOS.map(buildProbe);
  const result = (
    i: number,
    providerTotalMinor: number | null,
    error: string | null = null,
  ): ProbeResult => ({
    expectation: probes[i]!,
    document: error ? null : { series: "FCT", number: `00${i + 1}` },
    providerTotalMinor,
    pdfPath: error ? null : `local-data/verificare-rotunjire/p${i + 1}.pdf`,
    error,
  });

  it("toate identice: spune IDENTIC și cere compararea TVA-ului pe PDF", () => {
    const { text, allIdentical } = renderProbeReport(probes.map((p, i) => result(i, p.totalMinor)));
    expect(allIdentical).toBe(true);
    expect(text).toContain("IDENTIC");
    expect(text).toContain("10.481,81 lei");
    expect(text).toContain("TVA total 1.819,15 lei");
    expect(text).not.toContain("DIFERENȚĂ");
    expect(text).toContain("poți confirma testul");
  });

  it("o diferență de 1 ban: spune «DIFERENȚĂ de 1 ban», nu confirmă și avertizează", () => {
    const { text, allIdentical } = renderProbeReport([
      result(0, probes[0]!.totalMinor + 1),
      result(1, probes[1]!.totalMinor),
      result(2, probes[2]!.totalMinor),
    ]);
    expect(allIdentical).toBe(false);
    expect(text).toContain("DIFERENȚĂ de 1 ban");
    expect(text).toContain("NU trece în LIVE");
  });

  it("diferența de mai mulți bani se scrie la plural; un document neemis sau un total necitit nu trece", () => {
    const plural = renderProbeReport([result(0, probes[0]!.totalMinor - 2)]);
    expect(plural.text).toContain("DIFERENȚĂ de 2 bani");
    expect(renderProbeReport([result(0, null)]).allIdentical).toBe(false);
    const failed = renderProbeReport([result(0, null, "SmartBill a refuzat documentul")]);
    expect(failed.allIdentical).toBe(false);
    expect(failed.text).toContain("NU s-a putut emite documentul");
  });

  it("fără niciun rezultat nu se poate trece drept «identic»", () => {
    expect(renderProbeReport([]).allIdentical).toBe(false);
  });
});
