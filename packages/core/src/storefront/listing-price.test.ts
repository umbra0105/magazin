import { describe, expect, it } from "vitest";
import { displayedPrice, listingPrice, type PricedVariant } from "./listing-price";

const NOW = new Date("2030-06-15T12:00:00Z");
const DAY = 86_400_000;
const at = (offsetDays: number): Date => new Date(NOW.getTime() + offsetDays * DAY);

const plain = (price: number): PricedVariant => ({
  price,
  salePrice: null,
  saleStartsAt: null,
  saleEndsAt: null,
});
const onSale = (price: number, salePrice: number, start = -1, end = 1): PricedVariant => ({
  price,
  salePrice,
  saleStartsAt: at(start),
  saleEndsAt: at(end),
});

describe("displayedPrice (prețul unei variante afișat în vitrină)", () => {
  it("cu afișarea reducerilor OPRITĂ arată mereu prețul întreg, fără preț tăiat, chiar dacă promoția e activă", () => {
    expect(displayedPrice(onSale(19900, 14900), NOW, false)).toEqual({
      amount: 19900,
      compareAt: null,
    });
    expect(displayedPrice(plain(19900), NOW, false)).toEqual({ amount: 19900, compareAt: null });
  });

  it("cu afișarea pornită: promoția activă dă prețul redus și prețul întreg ca preț tăiat", () => {
    expect(displayedPrice(onSale(19900, 14900), NOW, true)).toEqual({
      amount: 14900,
      compareAt: 19900,
    });
  });

  it("promoție programată (încă neîncepută) sau încheiată: prețul întreg, fără preț tăiat", () => {
    expect(displayedPrice(onSale(19900, 14900, 2, 5), NOW, true)).toEqual({
      amount: 19900,
      compareAt: null,
    });
    expect(displayedPrice(onSale(19900, 14900, -5, -1), NOW, true)).toEqual({
      amount: 19900,
      compareAt: null,
    });
  });

  it("limitele ferestrei: începutul e inclusiv, sfârșitul e exclusiv", () => {
    const start = { ...onSale(19900, 14900), saleStartsAt: NOW, saleEndsAt: at(1) };
    expect(displayedPrice(start, NOW, true).amount).toBe(14900);
    const end = { ...onSale(19900, 14900), saleStartsAt: at(-1), saleEndsAt: NOW };
    expect(displayedPrice(end, NOW, true).amount).toBe(19900);
  });

  it("un preț redus egal cu cel întreg nu produce preț tăiat", () => {
    expect(displayedPrice(onSale(19900, 19900), NOW, true)).toEqual({
      amount: 19900,
      compareAt: null,
    });
  });

  it("promoție fără limite de dată e activă; prețul redus nu depășește niciodată prețul întreg", () => {
    const open: PricedVariant = {
      price: 1000,
      salePrice: 900,
      saleStartsAt: null,
      saleEndsAt: null,
    };
    expect(displayedPrice(open, NOW, true)).toEqual({ amount: 900, compareAt: 1000 });
    const odd: PricedVariant = { ...open, salePrice: 1200 };
    expect(displayedPrice(odd, NOW, true)).toEqual({ amount: 1000, compareAt: null });
  });
});

describe("listingPrice (prețul produsului în listă: «de la»)", () => {
  it("fără variante nu există preț", () => {
    expect(listingPrice([], NOW, false)).toBeNull();
  });

  it("o variantă: prețul ei, fără interval", () => {
    expect(listingPrice([plain(5900)], NOW, false)).toEqual({
      amount: 5900,
      compareAt: null,
      isRange: false,
    });
  });

  it("mai multe variante cu prețuri diferite: cel mai mic preț, marcat ca interval, fără preț tăiat", () => {
    expect(listingPrice([plain(8000), onSale(5000, 4000), plain(6000)], NOW, true)).toEqual({
      amount: 4000,
      compareAt: null,
      isRange: true,
    });
  });

  it("variante cu același preț nu sunt interval; prețul tăiat al variantei alese se păstrează", () => {
    expect(listingPrice([plain(5900), plain(5900)], NOW, false)).toEqual({
      amount: 5900,
      compareAt: null,
      isRange: false,
    });
    expect(listingPrice([onSale(5000, 4000), onSale(5000, 4000)], NOW, true)).toEqual({
      amount: 4000,
      compareAt: 5000,
      isRange: false,
    });
  });

  it("o diferență de un singur ban face tot interval", () => {
    expect(listingPrice([plain(5901), plain(5900)], NOW, false)).toEqual({
      amount: 5900,
      compareAt: null,
      isRange: true,
    });
  });

  it("cu reducerile oprite, intervalul se judecă pe prețurile întregi, nu pe cele reduse", () => {
    expect(listingPrice([onSale(5000, 4000), plain(5000)], NOW, false)).toEqual({
      amount: 5000,
      compareAt: null,
      isRange: false,
    });
  });
});
