import { describe, expect, it } from "vitest";
import { countyDisplayName, displayName, normalizeDiacritics } from "./siruta-names";

describe("normalizeDiacritics", () => {
  it("sedila devine virgulă dedesubt: ş→ș, ţ→ț (și majusculele)", () => {
    expect(normalizeDiacritics("BUCUREŞTI")).toBe("BUCUREȘTI");
    expect(normalizeDiacritics("PIATRA-NEAMŢ")).toBe("PIATRA-NEAMȚ");
    expect(normalizeDiacritics("şţŞŢ")).toBe("șțȘȚ");
  });

  it("lasă neschimbate ă â î și virgula dedesubt deja corectă", () => {
    expect(normalizeDiacritics("ĂÂÎăâî")).toBe("ĂÂÎăâî");
    expect(normalizeDiacritics("ȘȚșț")).toBe("ȘȚșț");
  });

  it("e idempotentă și normalizează la NFC", () => {
    const once = normalizeDiacritics("TÂRGU-MUREŞ");
    expect(normalizeDiacritics(once)).toBe(once);
    // S + virgulă dedesubt combinată (S + U+0326) devine un singur caracter
    expect(normalizeDiacritics("Ș")).toBe("Ș");
    // sedilă combinată (S + U+0327) devine virgulă dedesubt
    expect(normalizeDiacritics("Ş")).toBe("Ș");
  });
});

describe("displayName", () => {
  const cases: Array<[string, string]> = [
    ["SFÂNTU GHEORGHE", "Sfântu Gheorghe"],
    ["TÂRGU-MUREȘ", "Târgu-Mureș"],
    ["PIATRA-NEAMȚ", "Piatra-Neamț"],
    ["VALEA LUI MIHAI", "Valea lui Mihai"],
    ["CETATEA DE BALTĂ", "Cetatea de Baltă"],
    ["VĂLENII DE MUNTE", "Vălenii de Munte"],
    ["BAIA DE ARAMĂ", "Baia de Aramă"],
    ["BUCUREȘTI SECTORUL 1", "București Sectorul 1"],
    ["MUNICIPIUL ALBA IULIA", "Municipiul Alba Iulia"],
    ["ORAȘ ABRUD", "Oraș Abrud"],
    ["CÂMPULUNG MOLDOVENESC", "Câmpulung Moldovenesc"],
    ["I.CUZA", "I.Cuza"],
    ["C.A.ROSETTI", "C.A.Rosetti"],
    ["DEALU CU FLORI", "Dealu cu Flori"],
    ["SUB PIATRĂ", "Sub Piatră"],
    ["DE LA DEAL", "De la Deal"],
    ["GURA VĂII", "Gura Văii"],
    ["CRAIOVA", "Craiova"],
    ["SATU MARE", "Satu Mare"],
  ];
  it.each(cases)("%s → %s", (input, expected) => {
    expect(displayName(input)).toBe(expected);
  });

  it("primul cuvânt e mereu cu inițială mare, chiar dacă e cuvânt de legătură", () => {
    expect(displayName("DIN VALE")).toBe("Din Vale");
  });

  it("intrarea goală dă șir gol, nu aruncă", () => {
    expect(displayName("")).toBe("");
  });

  it("cuvintele după cratimă au inițială mare, dar un cuvânt de legătură rămâne mic", () => {
    expect(displayName("SÂNTANA-DE-MUREȘ")).toBe("Sântana-de-Mureș");
  });
});

describe("countyDisplayName", () => {
  it("scoate «Județul» și «Municipiul» din numele județului", () => {
    expect(countyDisplayName("JUDEȚUL ALBA")).toBe("Alba");
    expect(countyDisplayName("JUDEȚUL SATU MARE")).toBe("Satu Mare");
    expect(countyDisplayName("JUDEȚUL CARAȘ-SEVERIN")).toBe("Caraș-Severin");
    expect(countyDisplayName("MUNICIPIUL BUCUREȘTI")).toBe("București");
  });
  it("un nume fără prefix rămâne cu aceeași regulă de litere", () => {
    expect(countyDisplayName("ALBA")).toBe("Alba");
  });
});
