import { describe, expect, it } from "vitest";
import {
  FILTER_PARAMS,
  filterQueryString,
  parseOrderListParams,
  sanitizeSavedQuery,
} from "./order-list-params";

const TZ = "Europe/Bucharest";
const parse = (qs: string) =>
  parseOrderListParams(new URLSearchParams(qs), {
    timeZone: TZ,
    labels: {
      statuses: { pending: "În așteptare", confirmed: "Confirmată" },
      methods: { cod: "Ramburs" },
      deliveryKinds: { pickup: "Ridicare personală" },
    },
  });

describe("parametrii listei de comenzi", () => {
  it("fără parametri: vederea «toate», pagina 1, 25 de rânduri, fără filtre", () => {
    const parsed = parse("");
    expect(parsed.view).toBe("all");
    expect(parsed.query).toEqual({ pageSize: 25, page: 1 });
    expect(parsed.applied).toEqual([]);
    expect(parsed.errors).toEqual({});
  });

  it("valorile din liste albe trec, restul se ignoră (nu ajung în interogare)", () => {
    const parsed = parse(
      "stare=pending,confirmed,hack&metoda=cod,altceva&livrare=ridicare&vedere=atentie",
    );
    expect(parsed.query).toMatchObject({
      status: ["pending", "confirmed"],
      paymentMethod: ["cod"],
      delivery: "pickup",
      view: "attention",
    });
    expect(parse("stare=hack").query.status).toBeUndefined();
    expect(parse("vedere=oricare").view).toBe("all");
  });

  it("etichetele eliminabile: câte una pentru fiecare valoare dintr-o listă, cu textul din mesaje", () => {
    const parsed = parse("stare=pending,confirmed&livrare=ridicare&furnizor=1&q=%20WEB-12%20");
    expect(parsed.applied.map((a) => `${a.param}:${a.value ?? ""}:${a.label}`)).toEqual([
      "q::«WEB-12»",
      "stare:pending:În așteptare",
      "stare:confirmed:Confirmată",
      "livrare::Ridicare personală",
      "furnizor::La furnizor",
    ]);
  });

  it("datele: de la inclusiv, până la inclusiv (se transformă în limita exclusivă a zilei următoare, ora locală)", () => {
    const { query, errors } = parse("de-la=2026-11-10&pana-la=2026-11-12");
    expect(errors).toEqual({});
    // 10 nov 2026, miezul nopții la București (EET, UTC+2) = 22:00 UTC din ziua precedentă
    expect(query.from?.toISOString()).toBe("2026-11-09T22:00:00.000Z");
    expect(query.to?.toISOString()).toBe("2026-11-12T22:00:00.000Z");
  });

  it("peste schimbarea orei: ziua de după se calculează în ora locală, nu cu 24 de ore fixe", () => {
    // 25 octombrie 2026: trecerea la ora de iarnă (ziua are 25 de ore)
    const { query } = parse("de-la=2026-10-25&pana-la=2026-10-25");
    expect(query.from?.toISOString()).toBe("2026-10-24T21:00:00.000Z");
    expect(query.to?.toISOString()).toBe("2026-10-25T22:00:00.000Z");
  });

  it("date invalide (31 februarie, text, ordine inversă) dau eroare pe câmp și nu intră în interogare", () => {
    expect(parse("de-la=2026-02-31").errors).toEqual({ "de-la": "date" });
    expect(parse("pana-la=ieri").errors).toEqual({ "pana-la": "date" });
    const reversed = parse("de-la=2026-11-12&pana-la=2026-11-10");
    expect(reversed.errors).toEqual({ "de-la": "range" });
    expect(reversed.query.from).toBeUndefined();
    expect(reversed.query.to).toBeUndefined();
  });

  it("sumele sunt în lei (virgulă sau punct, cel mult 2 zecimale) și se salvează în bani", () => {
    const { query, errors } = parse("suma-min=100&suma-max=1.234,50".replace("1.234,50", "1234.5"));
    expect(errors).toEqual({});
    expect(query).toMatchObject({ minTotalMinor: 10_000, maxTotalMinor: 123_450 });
    expect(parse("suma-min=abc").errors).toEqual({ "suma-min": "amount" });
    expect(parse("suma-min=10.123").errors).toEqual({ "suma-min": "amount" });
    expect(parse("suma-min=200&suma-max=100").errors).toEqual({ "suma-min": "amountRange" });
  });

  it("sortarea, dimensiunea paginii și pagina: valori necunoscute revin la implicit; pagina e limitată", () => {
    expect(parse("sortare=total-desc").query.sort).toBe("total_desc");
    expect(parse("sortare=oricum").query.sort).toBeUndefined();
    expect(parse("pe-pagina=50").query.pageSize).toBe(50);
    expect(parse("pe-pagina=7").query.pageSize).toBe(25);
    expect(parse("pagina=3").query.page).toBe(3);
    expect(parse("pagina=-2").query.page).toBe(1);
    expect(parse("pagina=999999999").query.page).toBe(100_000);
  });

  it("căutarea se taie la 100 de caractere", () => {
    expect(parse(`q=${"x".repeat(150)}`).query.q).toHaveLength(100);
  });
});

describe("vederile salvate păstrează doar filtrele", () => {
  it("pagina, dimensiunea paginii și orice parametru necunoscut se aruncă; ordinea e stabilă", () => {
    expect(sanitizeSavedQuery("?pagina=4&pe-pagina=50&metoda=cod&hack=1&stare=pending")).toBe(
      "stare=pending&metoda=cod",
    );
    expect(filterQueryString(new URLSearchParams("sortare=noi&q=%20ab%20&vedere=atentie"))).toBe(
      "vedere=atentie&q=ab&sortare=noi",
    );
  });

  it("lista parametrilor de filtru nu conține pagina și nu poate purta date din afara listei", () => {
    expect(FILTER_PARAMS).not.toContain("pagina" as never);
    expect(FILTER_PARAMS).not.toContain("pe-pagina" as never);
  });
});
