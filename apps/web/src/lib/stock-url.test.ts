import { describe, expect, it } from "vitest";
import {
  LOW_STOCK_FILTER as CORE_LOW_STOCK_FILTER,
  LOW_STOCK_REASON_PARAMS as CORE_REASON_PARAMS,
  parseStockOverviewQuery,
} from "@ecom/core";
import { LOW_STOCK_FILTER, LOW_STOCK_REASON_PARAMS, stockHref } from "./stock-url";

/** Adresa paginii Stoc: filtrele în adresă (`?q=&tip=&stare=&filtru=stoc-mic&pagina=`), identice cu ce citește nucleul. */

describe("stockHref", () => {
  it("fără filtre: adresa goală a paginii; pagina 1 nu se scrie", () => {
    expect(stockHref({})).toBe("/admin/produse/stoc");
    expect(stockHref({ page: 1 })).toBe("/admin/produse/stoc");
  });

  it("filtrele în ordinea q, tip, stare, filtru, pagina; «Stoc mic» = ?filtru=stoc-mic", () => {
    expect(
      stockHref({
        search: "liner",
        kind: "managed",
        state: "limited",
        lowStockOnly: true,
        page: 3,
      }),
    ).toBe("/admin/produse/stoc?q=liner&tip=managed&stare=limited&filtru=stoc-mic&pagina=3");
    expect(stockHref({ lowStockOnly: true })).toBe("/admin/produse/stoc?filtru=stoc-mic");
    expect(stockHref({ lowStockOnly: false })).toBe("/admin/produse/stoc");
  });

  it("pagina dată explicit bate pe cea din interogare", () => {
    expect(stockHref({ search: "a", page: 2 }, { page: 5 })).toBe(
      "/admin/produse/stoc?q=a&pagina=5",
    );
    expect(stockHref({ search: "a", page: 2 }, { page: 1 })).toBe("/admin/produse/stoc?q=a");
  });

  it("valoarea din adresă e aceeași cu cea din nucleu (altfel comutatorul și filtrul s-ar rupe în tăcere)", () => {
    expect(LOW_STOCK_FILTER).toBe(CORE_LOW_STOCK_FILTER);
  });

  it("adresa construită aici o citește nucleul înapoi, neschimbată", () => {
    const queries = [
      { search: "pompă cu ghilimele", lowStockOnly: true },
      { kind: "managed", state: "unavailable", page: 2 },
      { search: "x&y=z", kind: "digital", lowStockOnly: true, page: 4 },
      {},
    ] as const;
    for (const query of queries) {
      const url = new URL(stockHref(query), "http://x");
      const raw = Object.fromEntries(url.searchParams);
      expect(parseStockOverviewQuery(raw), JSON.stringify(query)).toEqual(query);
    }
  });
});

describe("stockHref: filtrul pe motiv (?motiv=…)", () => {
  it("motivul vine după filtru și înainte de pagină; fiecare motiv are valoarea lui", () => {
    expect(stockHref({ lowStockOnly: true, reason: "remainder_only" })).toBe(
      "/admin/produse/stoc?filtru=stoc-mic&motiv=rest-nevandabil",
    );
    expect(
      stockHref({
        search: "liner",
        kind: "managed",
        state: "unavailable",
        lowStockOnly: true,
        reason: "out_of_stock",
        page: 2,
      }),
    ).toBe(
      "/admin/produse/stoc?q=liner&tip=managed&stare=unavailable&filtru=stoc-mic&motiv=epuizat&pagina=2",
    );
    expect(stockHref({ lowStockOnly: true, reason: "below_threshold" })).toContain(
      "motiv=sub-prag",
    );
  });

  it("un motiv fără steag pornește oricum vederea (un motiv există doar în «Stoc mic»)", () => {
    expect(stockHref({ reason: "out_of_stock" })).toBe(
      "/admin/produse/stoc?filtru=stoc-mic&motiv=epuizat",
    );
  });

  it("valorile din adresă sunt aceleași cu cele din nucleu", () => {
    expect(LOW_STOCK_REASON_PARAMS).toEqual(CORE_REASON_PARAMS);
  });

  it("adresa construită aici o citește nucleul înapoi, neschimbată", () => {
    for (const reason of ["out_of_stock", "remainder_only", "below_threshold"] as const) {
      const href = stockHref({ lowStockOnly: true, reason, search: "pompă", page: 3 });
      const raw = Object.fromEntries(new URL(href, "http://x").searchParams);
      expect(parseStockOverviewQuery(raw), reason).toEqual({
        lowStockOnly: true,
        reason,
        search: "pompă",
        page: 3,
      });
    }
  });
});
