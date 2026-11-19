import { describe, expect, it } from "vitest";
import {
  addressErrors,
  companyErrors,
  contactErrors,
  isEmail,
  isPostalCode,
  isRoPhone,
} from "./checkout-validation";

describe("validări de checkout (în browser, doar pentru experiență)", () => {
  it("email", () => {
    for (const ok of ["a@b.ro", " ion.popescu+test@exemplu.co.uk "])
      expect(isEmail(ok), ok).toBe(true);
    for (const bad of ["", "a@b", "a b@c.ro", "@c.ro", "a@.ro", `${"x".repeat(250)}@b.ro`]) {
      expect(isEmail(bad), bad).toBe(false);
    }
  });
  it("telefon românesc, cu separatori", () => {
    for (const ok of [
      "0722123456",
      "0722 123 456",
      "+40 722.123-456",
      "0040722123456",
      "021 123 4567",
    ]) {
      expect(isRoPhone(ok), ok).toBe(true);
    }
    for (const bad of ["", "722123456", "07221234", "+4072212345678", "abc"]) {
      expect(isRoPhone(bad), bad).toBe(false);
    }
  });
  it("cod poștal: exact 6 cifre", () => {
    expect(isPostalCode("510005")).toBe(true);
    for (const bad of ["51000", "5100050", "51000a", ""])
      expect(isPostalCode(bad), bad).toBe(false);
  });
  it("mesajele sunt în română și cheile au prefix la adresa de facturare", () => {
    expect(contactErrors({ email: "x", phone: "1" })).toEqual({
      email: "Scrie o adresă de email validă.",
      phone: "Scrie un număr de telefon românesc valid (de exemplu 0722 123 456).",
    });
    const errors = addressErrors(
      { fullName: "", countyCode: "", localityCode: "", street: "", postalCode: "1" },
      "billing",
    );
    expect(Object.keys(errors).sort()).toEqual([
      "billing.countyCode",
      "billing.fullName",
      "billing.localityCode",
      "billing.postalCode",
      "billing.street",
    ]);
    expect(
      addressErrors({
        fullName: "Ion Popescu",
        countyCode: "1",
        localityCode: "2",
        street: "Str. A 1",
        postalCode: "123456",
      }),
    ).toEqual({});
    expect(companyErrors({ companyName: "", vatId: "" })).toHaveProperty("companyName");
    expect(companyErrors({ companyName: "Firma SRL", vatId: "14399840" })).toEqual({});
  });
});
