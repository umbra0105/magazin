import { describe, expect, it } from "vitest";
import type { StockAlerts, WarehouseFreshness } from "@ecom/core";
import { alertCardsView } from "./stock-alerts";

/** Cardurile de stoc din Panou: numere, legături spre vederea «Stoc mic» și starea pozei SmartBill. */

const settings = {
  lowStockSteps: 2,
  defaultLeadTimeDays: 14,
  snapshotStaleHours: 24,
  timeZone: "Europe/Bucharest",
};

const freshness = (over: Partial<WarehouseFreshness> = {}): WarehouseFreshness => ({
  warehouseId: "w1",
  name: "Depozit principal",
  status: "fresh",
  takenAt: new Date("2026-10-26T10:00:00Z"),
  ageHours: 3,
  ...over,
});

const alerts = (
  over: Partial<StockAlerts> = {},
): Pick<StockAlerts, "lowStock" | "freshness" | "settings"> => ({
  lowStock: { total: 6, outOfStock: 3, remainderOnly: 1, belowThreshold: 2 },
  freshness: freshness(),
  settings,
  ...over,
});

describe("alertCardsView", () => {
  it("«Stoc mic»: totalul (toate motivele) și epuizatele, cu legătură spre vederea «Stoc mic»", () => {
    expect(alertCardsView(alerts()).lowStock).toEqual({
      total: 6,
      outOfStock: 3,
      href: "/admin/produse/stoc?filtru=stoc-mic",
    });
  });

  it("«Doar rest nevandabil»: numărul lui, cu legătură spre același filtru + motivul", () => {
    expect(alertCardsView(alerts()).remainder).toEqual({
      count: 1,
      href: "/admin/produse/stoc?filtru=stoc-mic&motiv=rest-nevandabil",
    });
  });

  it("zero nu dispare: cardurile arată 0, cu aceleași legături", () => {
    const view = alertCardsView(
      alerts({ lowStock: { total: 0, outOfStock: 0, remainderOnly: 0, belowThreshold: 0 } }),
    );
    expect(view.lowStock).toMatchObject({ total: 0, outOfStock: 0 });
    expect(view.remainder.count).toBe(0);
    expect(view.remainder.href).toContain("motiv=rest-nevandabil");
  });

  it("poza SmartBill: la zi (ton ok), veche (ton roșu, cu pragul), lipsă (roșu) sau fără stoc în depozit (informativ)", () => {
    const fresh = alertCardsView(alerts()).snapshot;
    expect(fresh).toMatchObject({ status: "fresh", tone: "ok", href: "/admin/produse/stoc" });
    expect(fresh.text).toContain("Stoc verificat la");
    expect(fresh.text).toContain("acum 3 h");

    const stale = alertCardsView(
      alerts({ freshness: freshness({ status: "stale", ageHours: 30 }) }),
    ).snapshot;
    expect(stale).toMatchObject({ status: "stale", tone: "danger" });
    expect(stale.text).toContain("Poza SmartBill e veche");
    expect(stale.text).toContain("24 h");

    const never = alertCardsView(
      alerts({ freshness: freshness({ status: "never", takenAt: null, ageHours: null }) }),
    ).snapshot;
    expect(never).toMatchObject({ status: "never", tone: "danger" });
    expect(never.text).toContain("Nu există nicio poză SmartBill");

    const none = alertCardsView(alerts({ freshness: null })).snapshot;
    expect(none).toMatchObject({ status: "none", tone: "info" });
    expect(none.text).toContain("Nu există încă stoc gestionat");
  });
});
