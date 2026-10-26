import { describe, expect, it } from "vitest";
import { productFailure } from "./product-action-support";

/**
 * Blocul C, C-19: erorile necunoscute ale acțiunilor se rearuncă (Next le jurnalizează, iar Sentry le primește). O eroare
 * Prisma/Postgres poartă în mesaj valori (de ex. «Unable to fit integer value '30000000000' into an INT4», rândul care a
 * încălcat un CHECK cu `costPrice`), iar redactarea din jurnale lucrează pe NUME de câmp, nu pe text. Erorile de bază de
 * date se rearuncă deci curățate: doar codul și, dacă există, modelul și câmpurile (nume de coloane), niciodată valorile.
 */

const SECRET = "30000000011";

function prismaError(code: string, message: string, meta?: Record<string, unknown>) {
  const error = new Error(message) as Error & { code: string; meta?: Record<string, unknown> };
  error.name = "PrismaClientKnownRequestError";
  error.code = code;
  if (meta) error.meta = meta;
  return error;
}

function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("nu a aruncat");
}

describe("productFailure: erori de bază de date", () => {
  it("rearuncă o eroare Prisma fără textul ei: codul, modelul și câmpurile, nu valorile", () => {
    const original = prismaError(
      "P2002",
      `Unique constraint failed on the fields: (\`sku\`) value '${SECRET}'`,
      { modelName: "ProductVariant", target: ["sku"], value: SECRET },
    );
    const thrown = thrownBy(() => productFailure(original));
    expect(thrown.message).not.toContain(SECRET);
    expect(thrown.message).toContain("P2002");
    expect(thrown.message).toContain("ProductVariant");
    expect(thrown.message).toContain("sku");
    expect((thrown as { cause?: unknown }).cause).toBeUndefined();
    expect(thrown.stack ?? "").not.toContain(SECRET);
    expect(JSON.stringify(thrown, Object.getOwnPropertyNames(thrown))).not.toContain(SECRET);
  });

  it("aceeași curățare pentru erorile de driver Postgres (cod SQLSTATE, fără nume Prisma)", () => {
    const pg = new Error(`Failing row contains (1, ${SECRET}, 2026-01-01)`) as Error & {
      code: string;
      severity: string;
      detail: string;
    };
    pg.name = "error";
    pg.code = "23514";
    pg.severity = "ERROR";
    pg.detail = `Failing row contains (1, ${SECRET}, 2026-01-01).`;
    const thrown = thrownBy(() => productFailure(pg));
    expect(thrown.message).not.toContain(SECRET);
    expect(thrown.message).toContain("23514");
  });

  it("o eroare de programare obișnuită rămâne neschimbată (stack-ul trebuie să se vadă)", () => {
    const original = new TypeError("Cannot read properties of null");
    expect(thrownBy(() => productFailure(original))).toBe(original);
  });

  it("erorile de domeniu cu cod stabil se clasifică, nu se rearuncă", () => {
    expect(productFailure({ code: "VALIDATION_ERROR", message: "Valoare invalidă" })).toMatchObject(
      {
        ok: false,
        code: "VALIDATION_ERROR",
      },
    );
  });
});

describe("productFailure: erorile de stoc sunt erori de domeniu (se arată administratorului, nu se rearuncă)", () => {
  const stockCodes = [
    "STOCK_ADJUSTMENT_INVALID_REASON",
    "STOCK_ADJUSTMENT_NOTE_REQUIRED",
    "STOCK_ADJUSTMENT_NOTE_TOO_LONG",
    "STOCK_ADJUSTMENT_ZERO",
    "STOCK_ADJUSTMENT_WRONG_SIGN",
    "STOCK_ADJUSTMENT_INVALID_TIME",
    "STOCK_ADJUSTMENT_FUTURE",
    "STOCK_ADJUSTMENT_PRECISION",
    "STOCK_ADJUSTMENT_BELOW_ZERO",
    "STOCK_ADJUSTMENT_OVERFLOW",
    "STOCK_ADJUSTMENT_AMBIGUOUS_QUANTITY",
    "STOCK_NOT_MANAGED",
    "STOCK_THRESHOLD_INVALID",
    "STOCK_VARIANT_NOT_FOUND",
    "STOCK_NO_WAREHOUSE",
    "QUANTITY_INVALID_FORMAT",
    "QUANTITY_TOO_MANY_DECIMALS",
    "QUANTITY_OVERFLOW",
    "QUANTITY_NEGATIVE",
    "QUANTITY_NOT_POSITIVE",
  ];

  it.each(stockCodes)("%s → eșec cu cod și mesaj", (code) => {
    const error = Object.assign(new Error("Mesaj pentru administrator"), { code });
    expect(productFailure(error)).toEqual({
      ok: false,
      code,
      message: "Mesaj pentru administrator",
    });
  });
});
