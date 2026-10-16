/**
 * Export WooCommerce SINTETIC pentru teste: aceeași structură ca exportul real al magazinului (antete în
 * română, 79 de coloane, aceeași ordine), dar cu conținut INVENTAT: nume, descrieri, categorii, branduri și
 * coduri de fantezie. Nimic din fișierul real (`local-data/`) nu intră aici. Coloana `Meta: _pret_intrare`
 * (prețul de intrare) are o valoare-santinelă, ca testele să dovedească că nu ajunge nicăieri.
 */

export const WOO_HEADERS = [
  "ID",
  "Tip",
  "SKU",
  "GTIN, UPC, EAN sau ISBN",
  "Nume",
  "Publicat",
  "Este reprezentativ?",
  "Vizibilitate în catalog",
  "Descriere scurtă",
  "Descriere",
  "Dată începere promoție",
  "Dată încheiere promoție",
  "Stare taxă",
  "Clasă de impozitare",
  "În stoc?",
  "Stoc",
  "Cantitate mică în stoc",
  "Precomenzile sunt permise?",
  "Vândut individual?",
  "Greutate (kg)",
  "Lungime (cm)",
  "Lățime (cm)",
  "Înălțime (cm)",
  "Permiți recenzii de la clienți?",
  "Notă de cumpărare",
  "Preț promoțional",
  "Preț obișnuit",
  "Categorii",
  "Etichete",
  "Clasă de livrare",
  "Imagini",
  "Limită de descărcări",
  "Zile de expirare descărcare",
  "Părinte",
  "Produse grupate",
  "Upsells",
  "Vânzări încrucișate",
  "URL extern",
  "Text buton",
  "Poziție",
  "Branduri",
  "Meta: _wp_page_template",
  "Meta: _wp_old_date",
  "Meta: rank_math_analytic_object_id",
  "Meta: rank_math_internal_links_processed",
  "Nume atribut 1",
  "Valoare (valori) atribut 1",
  "Vizibilitate atribut 1",
  "Atribut 1 global",
  "Nume atribut 2",
  "Valoare (valori) atribut 2",
  "Vizibilitate atribut 2",
  "Atribut 2 global",
  "Meta: _woodmart_product-background",
  "Nume atribut 3",
  "Valoare (valori) atribut 3",
  "Vizibilitate atribut 3",
  "Atribut 3 global",
  "Meta: cmplz_hide_cookiebanner",
  "Meta: woodmart_price_unit_of_measure",
  "Meta: rank_math_seo_score",
  "Meta: piese_schimb",
  "Meta: fisa_tehnica",
  "Meta: manual_utilizare",
  "Meta: dimensiuni",
  "Meta: _elementor_edit_mode",
  "Meta: _elementor_template_type",
  "Meta: _elementor_version",
  "Meta: _elementor_pro_version",
  "Meta: rank_math_primary_product_cat",
  "Meta: _pret_intrare",
  "Meta: _smartbill_sku",
  "Meta: _elementor_data",
  "Meta: _elementor_element_cache",
  "Meta: alte_info",
  "Meta: rank_math_primary_product_brand",
  "Meta: _woodmart_new_label_date",
  "Meta: _price_partener",
  "Meta: _price_premium",
] as const;

export type WooHeader = (typeof WOO_HEADERS)[number];
export type WooFixtureRow = Partial<Record<WooHeader, string>>;

/** Valoarea-santinelă din coloana prețului de intrare: nu are voie să apară în plan, raport, loguri sau audit. */
export const WOO_COST_SENTINEL = "SANTINELA-INTRARE-7654321";

const LONG_HTML = [
  '<h2 class="titlu">Caracteristici</h2>',
  '<p style="color:red">Pompă <strong>silențioasă</strong> pentru piscine private. Vezi <a href="https://exemplu.invalid/fisa.pdf">fișa tehnică</a>.</p>',
  '<img src="https://exemplu.invalid/poza.jpg" alt="poză">',
  "<table><tbody><tr><td>Putere</td><td>0,75 kW</td></tr><tr><td>Debit maxim</td><td>12&nbsp;m³/h</td></tr></tbody></table>",
  "<ul><li>Corp din material plastic</li><li>Garanție 24 de luni</li></ul>",
  "[caption id=&quot;attachment_9&quot;]Montaj[/caption] [gallery ids=&quot;1,2&quot;]",
  "<style>.titlu{color:blue}</style>",
].join("\n");

const HOSTILE_HTML =
  '<p>Text normal &amp; sigur.</p><script>alert("x")</script><iframe src="https://exemplu.invalid/x"></iframe><p onclick="x()">Final</p>';

/** Rândurile fixture-ului, cu valori inventate. Fiecare caz e descris în comentariu. */
export function syntheticWooRows(): WooFixtureRow[] {
  const common: WooFixtureRow = {
    Publicat: "1",
    "Este reprezentativ?": "0",
    "Vizibilitate în catalog": "visible",
    "Stare taxă": "taxable",
    "În stoc?": "1",
    "Precomenzile sunt permise?": "0",
    "Vândut individual?": "0",
    "Permiți recenzii de la clienți?": "1",
    Poziție: "0",
    Imagini: "https://exemplu.invalid/imagini/produs.jpg",
    "Meta: _wp_page_template": "default",
    "Meta: _pret_intrare": WOO_COST_SENTINEL,
  };
  const row = (values: WooFixtureRow): WooFixtureRow => ({ ...common, ...values });
  return [
    // 1. produs simplu complet: HTML bogat, promoție cu date, clasă paletizată, 2 categorii, brand nou, relații
    row({
      ID: "101",
      Tip: "simple",
      SKU: "FIX-101",
      "GTIN, UPC, EAN sau ISBN": "5901234123457",
      Nume: "Pompă de circulație Aqua 100",
      "Descriere scurtă": "<p>Silențioasă, <em>clasa A</em></p>",
      Descriere: LONG_HTML,
      "Dată începere promoție": "2026-11-01",
      "Dată încheiere promoție": "2026-11-30",
      "Greutate (kg)": "12,5",
      "Lungime (cm)": "40,5",
      "Lățime (cm)": "30",
      "Înălțime (cm)": "25",
      "Preț promoțional": "1099",
      "Preț obișnuit": "1299,50",
      Categorii: "Pompe > Pompe de circulație, Accesorii",
      Etichete: "pompe, piscine",
      "Clasă de livrare": "Paletizat",
      Branduri: "Marca Fixture A",
      Upsells: "id:103, NEEXISTENT-1",
      "Vânzări încrucișate": "id:104",
      "Meta: _smartbill_sku": "SB-101",
      "Meta: _price_partener": "900",
    }),
    // 2. SKU numeric cu zero la început, supradimensionat, fără promoție, clasă necunoscută pe alt rând
    row({
      ID: "102",
      Tip: "simple",
      SKU: "00123",
      Nume: "Filtru cu nisip Modul 400",
      Descriere: "Filtru pentru piscine de până la 40 m³.\nSe livrează cu ventil.",
      "Greutate (kg)": "0,5",
      "Lungime (cm)": "12,5",
      "Preț obișnuit": "349.90",
      Categorii: "Filtrare > Filtre cu nisip",
      "Clasă de livrare": "Supradimensionat",
      Branduri: "Marca Fixture B",
    }),
    // 3. fără SKU (WC-103), descriere ostilă (script, iframe, eveniment), clasă necunoscută
    row({
      ID: "103",
      Tip: "simple",
      SKU: "",
      Nume: "Set accesorii mentenanță",
      Descriere: HOSTILE_HTML,
      "Preț obișnuit": "89",
      Categorii: "Accesorii",
      "Clasă de livrare": "Curier special",
    }),
    // 4. virgulă escapată în categorie, nepublicat
    row({
      ID: "104",
      Tip: "simple",
      SKU: "FIX-104",
      Nume: "Perie pentru fundul bazinului",
      Publicat: "0",
      "Preț obișnuit": "59,99",
      Categorii: "Accesorii\\, diverse",
      Branduri: "Marca Fixture A",
    }),
    // 5. produs variabil cu 2 variații (opțiunea «Putere») și un atribut simplu («Material»)
    row({
      ID: "200",
      Tip: "variable",
      SKU: "",
      Nume: "Sistem de filtrare Modular",
      Descriere: "<p>Se poate configura în două puteri.</p>",
      Categorii: "Filtrare > Filtre cu nisip",
      Branduri: "Marca Fixture B",
      "Nume atribut 1": "Putere",
      "Valoare (valori) atribut 1": "0,5 kW, 0,75 kW",
      "Vizibilitate atribut 1": "1",
      "Atribut 1 global": "0",
      "Nume atribut 2": "Material",
      "Valoare (valori) atribut 2": "Polipropilenă",
      "Vizibilitate atribut 2": "1",
      "Atribut 2 global": "0",
    }),
    row({
      ID: "201",
      Tip: "variation",
      SKU: "FIX-VAR-05",
      Nume: "Sistem de filtrare Modular - 0,5 kW",
      Părinte: "id:200",
      "Preț obișnuit": "1800",
      "Greutate (kg)": "7",
      "Nume atribut 1": "Putere",
      "Valoare (valori) atribut 1": "0,5 kW",
      Categorii: "",
    }),
    row({
      ID: "202",
      Tip: "variation",
      SKU: "FIX-VAR-075",
      Nume: "Sistem de filtrare Modular - 0,75 kW",
      Părinte: "id:200",
      "Preț promoțional": "1950",
      "Preț obișnuit": "2100",
      "Greutate (kg)": "8,25",
      "Nume atribut 1": "Putere",
      "Valoare (valori) atribut 1": "0,75 kW",
    }),
    // 6. tipuri neacceptate: grupat și extern
    row({
      ID: "300",
      Tip: "grouped",
      SKU: "FIX-GRP",
      Nume: "Pachet piscină",
      "Produse grupate": "FIX-101, FIX-104",
    }),
    row({
      ID: "301",
      Tip: "external",
      SKU: "FIX-EXT",
      Nume: "Produs la partener",
      "URL extern": "https://exemplu.invalid/p",
    }),
    // 7. rânduri murdare
    row({ ID: "105", Tip: "simple", SKU: "FIX-105", Nume: "Preț greșit", "Preț obișnuit": "abc" }),
    row({ ID: "106", Tip: "simple", SKU: "FIX-101", Nume: "SKU repetat", "Preț obișnuit": "10" }),
    row({
      ID: "107",
      Tip: "variation",
      SKU: "FIX-ORF",
      Nume: "Variație fără părinte",
      Părinte: "id:98765",
      "Preț obișnuit": "10",
    }),
    row({
      ID: "108",
      Tip: "simple",
      SKU: "FIX-108",
      Nume: "Categorie prea adâncă",
      "Preț obișnuit": "10",
      Categorii: "N1 > N2 > N3 > N4 > N5 > N6",
    }),
    row({
      ID: "109",
      Tip: "simple",
      SKU: "FIX-109",
      Nume: "Categorie cu bară",
      "Preț obișnuit": "10",
      Categorii: "Pompe | Filtre",
    }),
    row({
      ID: "110",
      Tip: "simple",
      SKU: "FIX-110",
      Nume: "Greutate cu fracțiune de gram",
      "Preț obișnuit": "10",
      "Greutate (kg)": "0,0005",
    }),
  ];
}

const needsQuotes = (value: string): boolean => /[",\n\r]/.test(value) || value !== value.trim();

/** CSV standard WooCommerce: UTF-8 cu BOM, virgulă ca separator, câmpuri între ghilimele când e nevoie. */
export function wooCsv(rows: readonly WooFixtureRow[]): Uint8Array {
  const line = (cells: readonly string[]): string =>
    cells.map((cell) => (needsQuotes(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)).join(",");
  const body = [
    line(WOO_HEADERS),
    ...rows.map((r) => line(WOO_HEADERS.map((header) => r[header] ?? ""))),
  ].join("\n");
  return new TextEncoder().encode(`${String.fromCharCode(0xfeff)}${body}\n`);
}
