import { describe, expect, it } from "vitest";
import { ro } from "./ro";

/**
 * Numărătorile din mesaje se acordă cu funcția comună `pluralRo` (1 = singular; 0 și 2–19 = plural; 20+ cu «de»): raportul
 * importului Woo, rezumatul aplicării, maparea, istoricul, lista de fișe, atributele, brandurile și categoriile.
 */
const imp = ro.admin.productImport;
const woo = imp.woo;

describe("numărători acordate în română", () => {
  it("raportul Woo: «1 brand», «1 atribut», «1 categorie», plural și «de» după 20", () => {
    expect(woo.report.brands(1)).toBe("1 brand de creat");
    expect(woo.report.attributes(1)).toBe("1 atribut de creat");
    expect(woo.report.categories(1)).toBe("1 categorie de creat");
    expect(woo.report.brands(2)).toBe("2 branduri de creat");
    expect(woo.report.brands(0)).toBe("0 branduri de creat");
    expect(woo.report.categories(20)).toBe("20 de categorii de creat");
    expect(woo.report.attributes(119)).toBe("119 atribute de creat");
  });

  it("«Se vor crea …» folosește aceleași forme", () => {
    expect(woo.apply(1, 1, 1)).toBe(
      "Se vor crea 1 categorie, 1 brand și 1 atribut înaintea produselor.",
    );
    expect(woo.apply(2, 0, 25)).toBe(
      "Se vor crea 2 categorii, 0 branduri și 25 de atribute înaintea produselor.",
    );
    expect(woo.apply(0, 0, 0)).toBe("");
  });

  it("clasele de livrare, atributele și maparea: rânduri", () => {
    expect(woo.shipping.products(1)).toBe("1 rând");
    expect(woo.shipping.products(21)).toBe("21 de rânduri");
    expect(woo.attributes.products(3)).toBe("3 rânduri");
    expect(imp.mapping.rows(1)).toBe("1 rând de date");
    expect(imp.mapping.rows(100)).toBe("100 de rânduri de date");
  });

  it("rezumatul aplicării și imaginile", () => {
    expect(imp.apply.summary(1, 1)).toBe("1 produs nou și 1 produs actualizat.");
    expect(imp.apply.summary(20, 3)).toBe("20 de produse noi și 3 produse actualizate.");
    expect(woo.imagesApply(1)).toBe(" O imagine va fi adusă în fundal, după produse.");
    expect(woo.imagesApply(30)).toBe(" 30 de imagini vor fi aduse în fundal, după produse.");
    expect(woo.imagesApply(0)).toBe("");
  });

  it("istoricul exporturilor: rânduri și produse", () => {
    expect(imp.history.exports.rowsAndProducts(1, 1)).toBe("1 rând, 1 produs");
    expect(imp.history.exports.rowsAndProducts(25, 120)).toBe("25 de rânduri, 120 de produse");
  });

  it("istoricul importurilor: «Create: …» cu acord", () => {
    expect(imp.history.created(6, 2, 1)).toBe("Create: 6 categorii, 2 branduri, 1 atribut");
    expect(imp.history.created(1, 1, 20)).toBe("Create: 1 categorie, 1 brand, 20 de atribute");
  });

  it("istoricul exporturilor: «Se afișează …» cu acord", () => {
    expect(imp.history.exports.shown(1)).toBe("Se afișează cel mai nou export.");
    expect(imp.history.exports.shown(5)).toBe("Se afișează cele mai noi 5 exporturi.");
    expect(imp.history.exports.shown(25)).toBe("Se afișează cele mai noi 25 de exporturi.");
  });

  it("fișe explodate, atribute, branduri și categorii", () => {
    expect(ro.admin.diagrams.counts.hotspots(20)).toBe("20 de hotspot-uri");
    expect(ro.admin.brands.products(20)).toBe("20 de produse");
    expect(ro.admin.brands.products(1)).toBe("1 produs");
    expect(ro.admin.categories.products(45)).toBe("45 de produse");
  });
});
