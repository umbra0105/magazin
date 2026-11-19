import { describe, expect, it } from "vitest";
import { TEMPLATE_CATALOG, templateDefinition } from "./catalog";
import { SAMPLE_MERCHANT, renderTemplateEmail, sampleContext } from "./render-template";
import { TEMPLATE_KEYS } from "./template-model";
import { interpolate, placeholdersOf, validateOverride } from "./template-text";
import type { EmailTheme } from "./theme";

const theme: EmailTheme = {
  storeName: "Piscine Demo",
  logoUrl: null,
  colors: {
    bg: "#fafafa",
    fg: "#111111",
    muted: "#555555",
    border: "#dddddd",
    primary: "#0b5fff",
    primaryFg: "#ffffff",
  },
  fontFamily: "Arial, Helvetica, sans-serif",
  radiusPx: 8,
};

const def = (key: string) => {
  const found = templateDefinition(key);
  if (!found) throw new Error(`lipsește șablonul ${key}`);
  return found;
};

describe("catalogul șabloanelor", () => {
  it("fiecare cheie din listă are o definiție, fără dubluri", () => {
    expect(TEMPLATE_CATALOG.map((d) => d.key).sort()).toEqual([...TEMPLATE_KEYS].sort());
  });

  it("toate lista din docs/02 §B8 pentru zona comenzilor e acoperită și legată", () => {
    for (const key of [
      "order.confirmation",
      "order.proforma",
      "order.payment_received",
      "order.payment_failed",
      "order.processing",
      "order.shipped",
      "order.delivered",
      "order.cancelled",
      "order.refunded",
      "order.stock_lost",
      "internal.order_new",
      "internal.stock_out",
      "internal.installation_request",
    ] as const) {
      expect(def(key).wired, key).toBe(true);
    }
  });

  it("șabloanele cu declanșator în alte faze sunt înregistrate, nelegate, cu faza responsabilă", () => {
    const unwired = TEMPLATE_CATALOG.filter((d) => !d.wired);
    expect(unwired.map((d) => d.key).sort()).toEqual(
      [
        "account.welcome",
        "marketing.abandoned_cart_1",
        "marketing.abandoned_cart_2",
        "marketing.abandoned_cart_3",
        "marketing.newsletter",
        "marketing.review_request",
        "return.approved",
        "return.received",
        "return.rejected",
      ].sort(),
    );
    for (const d of unwired) expect(d.phaseNote, d.key).toMatch(/Faza 1[47]/);
  });

  it("variabilele din subiect, titlu și text implicit sunt toate declarate de șablon", () => {
    for (const d of TEMPLATE_CATALOG) {
      const declared = d.variables.map((variable) => variable.name);
      for (const text of [d.defaultSubject, d.defaultIntro, d.heading, d.preview]) {
        for (const name of placeholdersOf(text)) {
          expect(declared, `${d.key}: {{${name}}}`).toContain(name);
        }
      }
    }
  });

  it("fiecare șablon se randează în HTML și text, cu date de probă, marcate clar ca date de probă", async () => {
    for (const d of TEMPLATE_CATALOG) {
      const email = await renderTemplateEmail(theme, d.key, sampleContext(d), { sample: true });
      expect(email.subject, d.key).not.toMatch(/\{\{|\}\}/);
      expect(email.subject, d.key).not.toMatch(/[\r\n]/);
      for (const part of [email.html, email.text]) {
        expect(part, d.key).toContain("DATE DE PROBĂ");
        expect(part, d.key).toContain("Piscine Demo");
        expect(part, d.key).not.toMatch(/\{\{|\}\}/);
      }
    }
  });

  it("emailul de test pune [TEST] în subiect; emailul real nu", async () => {
    const d = def("order.processing");
    const real = await renderTemplateEmail(theme, d.key, sampleContext(d));
    const test = await renderTemplateEmail(theme, d.key, sampleContext(d), { testSend: true });
    expect(real.subject).not.toContain("[TEST]");
    expect(test.subject.startsWith("[TEST] ")).toBe(true);
    expect(real.html).not.toContain("DATE DE PROBĂ");
  });
});

describe("emailul de confirmare: informațiile precontractuale", () => {
  const d = def("order.confirmation");
  const context = sampleContext(d);

  it("conține identitatea comerciantului, prețul cu TVA și livrarea, plata, termenul, retragerea, formularul, garanția și reclamațiile", async () => {
    const { html, text } = await renderTemplateEmail(theme, d.key, context);
    // în varianta text, titlurile de secțiune ies cu majuscule: se compară fără diferența de litere
    for (const raw of [html, text]) {
      const part = raw.toLowerCase();
      const has = (value: string) => expect(part).toContain(value.toLowerCase());
      // identitatea comerciantului, din setări
      has(SAMPLE_MERCHANT.legalName);
      has(SAMPLE_MERCHANT.vatId);
      has(SAMPLE_MERCHANT.tradeRegisterNo);
      has(SAMPLE_MERCHANT.address);
      has(SAMPLE_MERCHANT.email);
      // produsele, prețul total cu taxe și costul livrării
      has("Pompă de căldură piscină 12 kW");
      has("Total de plată (TVA inclus)");
      has("1.234,50 RON");
      has("Livrare");
      // plata, livrarea și termenul de executare
      has("Modalitate de plată");
      has("Termen de executare");
      has("aproximativ 3 zile");
      // retragerea, formularul-model, garanția
      has("14 zile");
      has("La comandă");
      has("Formularul-model de retragere");
      has("Vă informez prin prezenta că renunț la contractul");
      has("Garanția legală");
      // reclamații și ANPC / SAL / SOL
      has("Reclamații");
      has("https://anpc.exemplu.invalid");
      has("https://sal.exemplu.invalid");
      has("https://sol.exemplu.invalid");
    }
  });

  it("o suprascriere schimbă DOAR subiectul și începutul: informațiile obligatorii rămân", async () => {
    const override = { subject: "Ai comandat: {{numar}}", intro: "Salut {{client}}, mulțumim!" };
    const { subject, html } = await renderTemplateEmail(theme, d.key, context, { override });
    expect(subject).toBe("Ai comandat: WEB-000123");
    expect(html).toContain("Salut Ana Popescu, mulțumim!");
    expect(html).not.toContain("Am înregistrat comanda");
    for (const mandatory of [
      "Cine ți-a vândut",
      "Dreptul de retragere",
      "Formularul-model de retragere",
      "Garanția legală",
      "Reclamații",
      SAMPLE_MERCHANT.vatId,
    ]) {
      expect(html).toContain(mandatory);
    }
  });

  it("linkurile către ANPC, SAL și SOL apar doar dacă sunt setate; datele goale ale comerciantului se omit", async () => {
    const { text } = await renderTemplateEmail(theme, d.key, {
      ...context,
      legal: { anpcUrl: "", salUrl: "", odrUrl: "" },
      merchant: { ...SAMPLE_MERCHANT, tradeRegisterNo: "", phone: "" },
    });
    const lower = text.toLowerCase();
    expect(lower).not.toContain("anpc:");
    expect(lower).not.toContain("soluționarea alternativă a litigiilor (sal):");
    expect(lower).not.toContain("număr de înregistrare la registrul comerțului");
    expect(lower).toContain("reclamații");
  });

  it("produsele «La comandă» schimbă nota despre retragere", async () => {
    const withOnOrder = await renderTemplateEmail(theme, d.key, {
      ...context,
      order: { ...(context.order as NonNullable<typeof context.order>), hasOnOrderLines: true },
    });
    expect(withOnOrder.text).toContain("Comanda ta conține produse «La comandă»");
    const without = await renderTemplateEmail(theme, d.key, context);
    expect(without.text).toContain("Comanda aceasta nu conține astfel de produse");
  });

  it("ridicare: arată adresa magazinului din model, nu o adresă a clientului", async () => {
    const { text } = await renderTemplateEmail(theme, d.key, {
      ...context,
      order: {
        ...(context.order as NonNullable<typeof context.order>),
        delivery: {
          kind: "pickup",
          heading: "Ridicare personală de la",
          text: "Strada Magazinului 7, 510000 Alba Iulia, Alba",
          termText: null,
        },
        payment: {
          method: "cod",
          methodLabel: "Ramburs",
          note: "Plătești în magazin la ridicare",
        },
      },
    });
    expect(text).toContain("Ridicare personală de la");
    expect(text).toContain("Strada Magazinului 7, 510000 Alba Iulia, Alba");
    expect(text).toContain("Plătești în magazin la ridicare");
    expect(text).not.toMatch(/curierului/i);
    expect(text).not.toContain("Termen de executare");
  });
});

describe("emailurile de plată", () => {
  it("plata eșuată: butonul «Reîncearcă plata» cu linkul din variabilă, în HTML și în text", async () => {
    const d = def("order.payment_failed");
    const { html, text } = await renderTemplateEmail(theme, d.key, sampleContext(d));
    expect(html).toContain('href="https://magazin.exemplu/comanda/plateste/exemplu"');
    expect(text).toContain("https://magazin.exemplu/comanda/plateste/exemplu");
    expect(text).toContain("Reîncearcă plata");
    expect(text).toContain("Nu ți s-a luat nicio sumă");
  });

  it("STOCK_RESERVATION_LOST: formularea din INTREBARI-AVOCAT §8.1, niciodată «rambursat»", async () => {
    const d = def("order.stock_lost");
    const { text, subject, html } = await renderTemplateEmail(theme, d.key, sampleContext(d));
    expect(text).toContain(
      "Plata a ajuns după expirarea rezervării, iar produsele nu mai sunt în stoc.",
    );
    expect(text).toContain("iar suma plătită va fi returnată");
    for (const part of [subject, text, html]) expect(part).not.toMatch(/rambursat[ăa]?\b/i);
  });

  it("rambursarea confirmată spune suma și că e confirmată", async () => {
    const d = def("order.refunded");
    const { text } = await renderTemplateEmail(theme, d.key, sampleContext(d));
    expect(text).toContain("250,00 RON");
    expect(text).toContain("confirmată");
  });

  it("proforma: IBAN, banca, suma, referința și termenul din setări și variabile", async () => {
    const d = def("order.proforma");
    const { text } = await renderTemplateEmail(theme, d.key, sampleContext(d));
    expect(text).toContain(SAMPLE_MERCHANT.iban);
    expect(text).toContain(SAMPLE_MERCHANT.bankName);
    expect(text).toContain("Comanda WEB-000123");
    expect(text).toContain("luni, 24 noiembrie 2026, ora 23:59");
  });

  it("expediată: AWB-ul apare doar dacă există", async () => {
    const d = def("order.shipped");
    const withAwb = await renderTemplateEmail(theme, d.key, sampleContext(d));
    expect(withAwb.text).toContain("1234567890");
    const base = sampleContext(d);
    const without = await renderTemplateEmail(theme, d.key, {
      ...base,
      vars: { ...base.vars, awb: "", curier: "" },
    });
    expect(without.text).not.toContain("AWB");
  });
});

describe("suprascrierea: variabile permise", () => {
  const allowed = def("order.confirmation").variables.map((variable) => variable.name);

  it("o suprascriere cu variabile ale șablonului e validă", () => {
    expect(
      validateOverride({ subject: "Comanda {{numar}}", intro: "Salut {{ client }}" }, allowed),
    ).toEqual([]);
  });

  it("o variabilă necunoscută se refuză, cu numele ei", () => {
    expect(
      validateOverride(
        { subject: "Comanda {{numar}}", intro: "Salut {{parola}} {{cnp}}" },
        allowed,
      ),
    ).toEqual([{ code: "unknown_variable", names: ["parola", "cnp"] }]);
  });

  it("subiect gol, text gol, prea lung, pe mai multe linii, acolade nepereche: toate se refuză", () => {
    const codes = (subject: string, intro: string) =>
      validateOverride({ subject, intro }, allowed).map((p) => p.code);
    expect(codes("", "x")).toContain("subject_empty");
    expect(codes("x", "")).toContain("intro_empty");
    expect(codes("x".repeat(201), "x")).toContain("subject_too_long");
    expect(codes("x", "x".repeat(2001))).toContain("intro_too_long");
    expect(codes("a\nb", "x")).toContain("subject_multiline");
    expect(codes("Comanda {{numar", "x")).toContain("unbalanced_braces");
    expect(codes("Comanda {numar}", "x")).toContain("unbalanced_braces");
    // limitele exacte trec
    expect(codes("x".repeat(200), "y".repeat(2000))).toEqual([]);
  });

  it("interpolarea nu execută nimic: valorile apar ca text, HTML-ul din valori se escapează la randare", async () => {
    expect(interpolate("Salut {{client}}", { client: "<b>Ana</b>" })).toBe("Salut <b>Ana</b>");
    const d = def("order.processing");
    const base = sampleContext(d);
    const { html } = await renderTemplateEmail(theme, d.key, {
      ...base,
      vars: { ...base.vars, client: "<script>alert(1)</script>" },
    });
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("șablon necunoscut: eroare cu cod stabil", async () => {
    await expect(
      renderTemplateEmail(theme, "nu.exista", sampleContext(def("order.processing"))),
    ).rejects.toMatchObject({
      code: "EMAIL_TEMPLATE_UNKNOWN",
    });
  });
});

describe("fără valori de brand în șabloane", () => {
  it("culorile din HTML sunt cele din temă", async () => {
    const d = def("order.processing");
    const custom: EmailTheme = { ...theme, colors: { ...theme.colors, primary: "#123456" } };
    const { html } = await renderTemplateEmail(custom, d.key, sampleContext(d));
    expect(html.toLowerCase()).toContain("#123456");
  });
});
