import { describe, expect, it } from "vitest";
import { checkSnapshotTime } from "./stock-report-time";

const TZ = "Europe/Bucharest";
// 28 octombrie 2026: România e deja la ora de iarnă (UTC+2; trecerea a fost pe 25 octombrie 2026)
const now = new Date("2026-10-28T12:00:00+02:00");

describe("ora pozei: avertismente, nu blocaje", () => {
  it("ora confirmată = acum, data din fișier = azi: fără avertismente", () => {
    const result = checkSnapshotTime({
      takenAt: now,
      now,
      fileDate: { year: 2026, month: 10, day: 28 },
      timeZone: TZ,
    });
    expect(result).toEqual({ ok: true, warnings: [] });
  });

  it("data din fișier diferă de azi: avertisment cu ambele date", () => {
    const result = checkSnapshotTime({
      takenAt: now,
      now,
      fileDate: { year: 2026, month: 10, day: 27 },
      timeZone: TZ,
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.kind)).toContain("file_date_not_today");
    const message = result.warnings.find((w) => w.kind === "file_date_not_today")!.message;
    expect(message).toContain("27.10.2026");
    expect(message).toContain("28.10.2026");
  });

  it("ora confirmată în viitor: avertisment", () => {
    const result = checkSnapshotTime({
      takenAt: new Date(now.getTime() + 3 * 3600_000),
      now,
      fileDate: { year: 2026, month: 10, day: 28 },
      timeZone: TZ,
    });
    expect(result.warnings.map((w) => w.kind)).toEqual(["taken_at_in_future"]);
  });

  it("ora confirmată pe altă zi decât data din fișier: avertisment", () => {
    const result = checkSnapshotTime({
      takenAt: new Date("2026-10-29T09:00:00+02:00"),
      now: new Date("2026-10-29T10:00:00+02:00"),
      fileDate: { year: 2026, month: 10, day: 28 },
      timeZone: TZ,
    });
    expect(result.warnings.map((w) => w.kind).sort()).toEqual([
      "file_date_not_today",
      "taken_at_not_on_file_date",
    ]);
  });

  it("ziua se socotește în fusul magazinului, nu în UTC (23:30 UTC = 02:30 a doua zi la București)", () => {
    const late = new Date("2026-10-27T23:30:00Z");
    const result = checkSnapshotTime({
      takenAt: late,
      now: late,
      fileDate: { year: 2026, month: 10, day: 28 },
      timeZone: TZ,
    });
    expect(result.warnings).toEqual([]);
  });

  it("fără data din fișier: nicio comparație cu ea, dar viitorul tot se semnalează", () => {
    const result = checkSnapshotTime({
      takenAt: new Date(now.getTime() + 60_000),
      now,
      fileDate: null,
      timeZone: TZ,
    });
    expect(result.warnings.map((w) => w.kind)).toEqual(["taken_at_in_future"]);
  });

  it("dată invalidă: respinsă, nu doar avertizată", () => {
    const result = checkSnapshotTime({
      takenAt: new Date("nu e dată"),
      now,
      fileDate: null,
      timeZone: TZ,
    });
    expect(result.ok).toBe(false);
    expect(result.warnings.map((w) => w.kind)).toEqual(["taken_at_invalid"]);
  });
});
