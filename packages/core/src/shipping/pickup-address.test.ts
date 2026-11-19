import { describe, expect, it } from "vitest";
import {
  formatPickupAddress,
  isPickupAddressComplete,
  normalizePickupAddress,
  pickupAddressTextFromSnapshot,
  type PickupAddress,
} from "./pickup-address";

const address = (over: Partial<PickupAddress> = {}): PickupAddress => ({
  street: "Strada Exemplu 1",
  city: "Alba Iulia",
  county: "Alba",
  postalCode: "510000",
  country: "RO",
  ...over,
});

describe("adresa de ridicare: completitudine", () => {
  it("e completă doar cu stradă ȘI oraș", () => {
    expect(isPickupAddressComplete(address())).toBe(true);
    expect(isPickupAddressComplete(address({ street: "" }))).toBe(false);
    expect(isPickupAddressComplete(address({ city: "" }))).toBe(false);
    expect(isPickupAddressComplete(address({ street: "", city: "" }))).toBe(false);
  });

  it("spațiile nu contează ca text", () => {
    expect(isPickupAddressComplete(address({ street: "   " }))).toBe(false);
    expect(isPickupAddressComplete(address({ city: "\t \n" }))).toBe(false);
  });

  it("județul și codul poștal lipsă nu o fac incompletă (le cere doar strada și orașul)", () => {
    expect(isPickupAddressComplete(address({ county: "", postalCode: "" }))).toBe(true);
  });

  it("nicio adresă înseamnă incompletă", () => {
    expect(isPickupAddressComplete(null)).toBe(false);
  });
});

describe("adresa de ridicare: formatare", () => {
  it("stradă, oraș, județ, cod poștal, țară, separate prin virgulă", () => {
    expect(formatPickupAddress(address())).toBe("Strada Exemplu 1, Alba Iulia, Alba, 510000, RO");
  });

  it("sare peste părțile goale, fără virgule duble", () => {
    expect(formatPickupAddress(address({ county: "", postalCode: "  " }))).toBe(
      "Strada Exemplu 1, Alba Iulia, RO",
    );
  });

  it("taie spațiile din jurul fiecărei părți", () => {
    expect(
      formatPickupAddress(address({ street: "  Strada Exemplu 1 ", city: " Alba Iulia" })),
    ).toBe("Strada Exemplu 1, Alba Iulia, Alba, 510000, RO");
  });
});

describe("adresa de ridicare: normalizare pentru snapshot", () => {
  it("păstrează părțile tăiate și textul formatat", () => {
    expect(normalizePickupAddress(address({ street: " Strada Exemplu 1 " }))).toEqual({
      street: "Strada Exemplu 1",
      city: "Alba Iulia",
      county: "Alba",
      postalCode: "510000",
      country: "RO",
      text: "Strada Exemplu 1, Alba Iulia, Alba, 510000, RO",
    });
  });

  it("întoarce null pentru o adresă incompletă sau lipsă", () => {
    expect(normalizePickupAddress(address({ city: "" }))).toBeNull();
    expect(normalizePickupAddress(null)).toBeNull();
  });
});

describe("adresa de ridicare citită din snapshot-ul comenzii", () => {
  it("întoarce textul salvat la plasare", () => {
    expect(
      pickupAddressTextFromSnapshot({
        kind: "pickup",
        pickupAddress: { text: "Strada X 1, Orașul" },
      }),
    ).toBe("Strada X 1, Orașul");
  });

  it("o comandă veche, fără adresă în snapshot, nu inventează una", () => {
    expect(
      pickupAddressTextFromSnapshot({ kind: "pickup", carrier: "Ridicare personală" }),
    ).toBeNull();
  });

  it("valori ciudate sau goale dau null, nu o eroare", () => {
    expect(pickupAddressTextFromSnapshot(null)).toBeNull();
    expect(pickupAddressTextFromSnapshot("text")).toBeNull();
    expect(pickupAddressTextFromSnapshot({ pickupAddress: "text" })).toBeNull();
    expect(pickupAddressTextFromSnapshot({ pickupAddress: { text: 5 } })).toBeNull();
    expect(pickupAddressTextFromSnapshot({ pickupAddress: { text: "   " } })).toBeNull();
  });
});
