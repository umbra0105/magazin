import { describe, expect, it } from "vitest";
import { checkImageUrl } from "../../../media/image-url";
import {
  DESCRIPTION_TOKEN_LENGTH,
  appendDescriptionImages,
  descriptionTokensIn,
  extractDescriptionImages,
  planDescriptionImages,
  resolveDescriptionTokens,
  stripDescriptionTokens,
} from "./description-images";

/**
 * Imaginile din descrierile WooCommerce (15d): fiecare `<img>` extern devine un marcaj de text `{{img:<hash>}}` (poziția rămâne),
 * adresa trece prin aceleași reguli fără rețea ca imaginile produsului, iar după descărcare marcajul devine
 * `<img data-media-id>`. Funcțiile sunt pure: nicio cerere în rețea, nicio bază de date.
 */

const POLICY = { allowedHosts: ["exemplu.invalid"], maxUrlLength: 2000 };
const check = (raw: string) => checkImageUrl(raw, POLICY);
const LIMITS = { maxPerProduct: 20 };
const u = (name: string) => `https://exemplu.invalid/poze/${name}.jpg`;
const hashOf = (name: string) => {
  const result = check(u(name));
  if (!result.ok) throw new Error("adresă de test invalidă");
  return result.sourceHash;
};
const token = (name: string) => `{{img:${hashOf(name).slice(0, DESCRIPTION_TOKEN_LENGTH)}}}`;

describe("extractDescriptionImages", () => {
  it("înlocuiește imaginea externă cu marcajul ei, în același loc, și o raportează ca acceptată", () => {
    const html = `<p>Înainte</p><p><img src="${u("a")}" alt="x"></p><p>După</p>`;
    const out = extractDescriptionImages(html, check, LIMITS);
    expect(out.html).toBe(`<p>Înainte</p><p>${token("a")}</p><p>După</p>`);
    expect(out.images).toEqual([
      {
        hash: hashOf("a"),
        url: u("a"),
        host: "exemplu.invalid",
        position: 0,
      },
    ]);
    expect(out.issues).toEqual([]);
    expect(out.total).toBe(1);
  });

  it("păstrează ordinea imaginilor; aceeași adresă de două ori = un singur candidat, ambele locuri primesc marcajul", () => {
    const html = `<img src="${u("a")}"><img src="${u("b")}"><img src="${u("a")}">`;
    const out = extractDescriptionImages(html, check, LIMITS);
    expect(out.html).toBe(`${token("a")}${token("b")}${token("a")}`);
    expect(out.images.map((image) => image.hash)).toEqual([hashOf("a"), hashOf("b")]);
    expect(out.images.map((image) => image.position)).toEqual([0, 1]);
    expect(out.total).toBe(3);
  });

  it("citește adresa din src, din data-src și din data-lazy-src (când src e un substituent data:), cu ghilimele simple, duble sau fără", () => {
    const placeholder = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";
    const cases = [
      `<img src='${u("a")}'>`,
      `<img SRC="${u("a")}">`,
      `<img src=${u("a")}>`,
      `<img src="${placeholder}" data-src="${u("a")}">`,
      `<img class="lazy" src="${placeholder}" data-lazy-src='${u("a")}' width="10">`,
    ];
    for (const html of cases) {
      const out = extractDescriptionImages(html, check, LIMITS);
      expect(out.html, html).toBe(token("a"));
      expect(out.images, html).toHaveLength(1);
    }
  });

  it("decodează entitățile din adresă (&amp;) înainte de verificare", () => {
    const encoded = `https://exemplu.invalid/poze/a.jpg?x=1&amp;y=2`;
    const out = extractDescriptionImages(`<img src="${encoded}">`, check, LIMITS);
    expect(out.images[0]?.url).toBe("https://exemplu.invalid/poze/a.jpg?x=1&y=2");
  });

  it("imaginea respinsă (domeniu nepermis, http, relativă, fără adresă) dispare din HTML și apare în probleme, fără adresa completă", () => {
    const html = [
      `<img src="https://alt.invalid/x.jpg">`,
      `<img src="http://exemplu.invalid/x.jpg">`,
      `<img src="/wp-content/uploads/x.jpg">`,
      `<img alt="fără sursă">`,
    ].join("<br>");
    const out = extractDescriptionImages(html, check, LIMITS);
    expect(out.html).toBe("<br><br><br>");
    expect(out.images).toEqual([]);
    expect(out.issues.map((issue) => [issue.position, issue.reason])).toEqual([
      [0, "host_not_allowed"],
      [1, "scheme"],
      [2, "invalid"],
      [3, "invalid"],
    ]);
    expect(out.issues[0]?.host).toBe("alt.invalid");
    expect(JSON.stringify(out.issues)).not.toContain("x.jpg");
    expect(out.total).toBe(4);
  });

  it("peste limita pe produs: restul se resping cu «too_many_for_product», primele rămân", () => {
    const html = ["a", "b", "c"].map((name) => `<img src="${u(name)}">`).join("");
    const out = extractDescriptionImages(html, check, { maxPerProduct: 2 });
    expect(out.images.map((image) => image.hash)).toEqual([hashOf("a"), hashOf("b")]);
    expect(out.issues).toEqual([{ position: 2, host: null, reason: "too_many_for_product" }]);
    expect(out.html).toBe(`${token("a")}${token("b")}`);
  });

  it("o descriere fără imagini rămâne neschimbată; o adresă ostilă nu poate injecta marcaje sau etichete", () => {
    expect(extractDescriptionImages("<p>Fără poze</p>", check, LIMITS).html).toBe(
      "<p>Fără poze</p>",
    );
    const hostile = `<img src="${u("a")}" onerror="alert(1)"><img src='x" onerror="y'>`;
    const out = extractDescriptionImages(hostile, check, LIMITS);
    expect(out.html).not.toContain("onerror");
    expect(out.html).not.toContain("<img");
  });

  it("un marcaj scris de mână în text (nu produs de noi) nu se păstrează: textul brut e curățat de marcaje înainte", () => {
    const out = extractDescriptionImages(
      `<p>{{img:${"a".repeat(DESCRIPTION_TOKEN_LENGTH)}}}</p>`,
      check,
      LIMITS,
    );
    expect(out.html).toBe("<p></p>");
  });
});

describe("resolveDescriptionTokens", () => {
  const html = `<p>${token("a")}</p><p>text</p><p>${token("b")}</p><p>${token("c")}</p>`;
  const prefix = (name: string) => hashOf(name).slice(0, DESCRIPTION_TOKEN_LENGTH);

  it("media → <img data-media-id>, drop → dispare, keep → rămâne; numără fiecare caz", () => {
    const out = resolveDescriptionTokens(html, (tokenId) => {
      if (tokenId === prefix("a")) return { kind: "media", mediaId: "media_0001" };
      if (tokenId === prefix("b")) return { kind: "drop" };
      return { kind: "keep" };
    });
    expect(out.html).toBe(
      `<p><img data-media-id="media_0001" alt=""></p><p>text</p><p></p><p>${token("c")}</p>`,
    );
    expect(out).toMatchObject({ replaced: 1, dropped: 1, kept: 1 });
  });

  it("același marcaj de două ori → ambele locuri se înlocuiesc", () => {
    const twice = `${token("a")}-${token("a")}`;
    const out = resolveDescriptionTokens(twice, () => ({ kind: "media", mediaId: "media_0001" }));
    expect(out.html).toBe(
      `<img data-media-id="media_0001" alt="">-<img data-media-id="media_0001" alt="">`,
    );
    expect(out.replaced).toBe(2);
  });

  it("un id de media cu caractere ciudate nu se injectează în HTML (cade pe «drop»)", () => {
    const out = resolveDescriptionTokens(token("a"), () => ({
      kind: "media",
      mediaId: `x" onerror="alert(1)`,
    }));
    expect(out.html).toBe("");
    expect(out.dropped).toBe(1);
  });

  it("HTML fără marcaje rămâne identic", () => {
    const out = resolveDescriptionTokens("<p>x</p>", () => ({ kind: "drop" }));
    expect(out).toMatchObject({ html: "<p>x</p>", replaced: 0, dropped: 0, kept: 0 });
  });
});

describe("descriptionTokensIn și stripDescriptionTokens", () => {
  it("listează marcajele în ordine, fără dubluri, și le scoate la randare", () => {
    const html = `<p>${token("a")} ${token("b")} ${token("a")}</p>`;
    expect(descriptionTokensIn(html)).toEqual([
      hashOf("a").slice(0, DESCRIPTION_TOKEN_LENGTH),
      hashOf("b").slice(0, DESCRIPTION_TOKEN_LENGTH),
    ]);
    expect(stripDescriptionTokens(html)).toBe("<p>  </p>");
    expect(stripDescriptionTokens("<p>fără</p>")).toBe("<p>fără</p>");
  });
});

describe("appendDescriptionImages", () => {
  it("adaugă la sfârșit imaginile care nu sunt deja în descriere; nu dublează", () => {
    const base = `<p>x</p><p><img data-media-id="media_0001" alt=""></p>`;
    const out = appendDescriptionImages(base, ["media_0001", "media_0002"]);
    expect(out).toBe(`${base}<p><img data-media-id="media_0002" alt=""></p>`);
    expect(appendDescriptionImages(base, ["media_0001"])).toBe(base);
  });

  it("pe o descriere goală (null) pornește de la imagini; ignoră id-uri invalide", () => {
    expect(appendDescriptionImages(null, ["media_0001"])).toBe(
      `<p><img data-media-id="media_0001" alt=""></p>`,
    );
    expect(appendDescriptionImages("<p>x</p>", [`a"b`])).toBe("<p>x</p>");
  });
});

describe("planDescriptionImages (planul unei descrieri, fără rețea)", () => {
  const policy = {
    allowedHosts: ["exemplu.invalid"],
    maxUrlLength: 2000,
    maxImagesPerProduct: 20,
    maxImagesPerImport: 2000,
  };
  const fresh = () => ({ accepted: 0 });

  it("imaginile noi rămân ca marcaje cu sarcini; cele deja în bibliotecă se înlocuiesc pe loc, fără sarcină", () => {
    const known = new Map([[hashOf("a"), "media_aaaa"]]);
    const html = `<p><img src="${u("a")}"></p><p><img src="${u("b")}"></p>`;
    const out = planDescriptionImages(html, policy, known, fresh());
    expect(out.html).toBe(`<p><img data-media-id="media_aaaa" alt=""></p><p>${token("b")}</p>`);
    expect(out.tasks.map((task) => task.hash)).toEqual([hashOf("b")]);
    expect(out.stats).toMatchObject({ total: 2, accepted: 2, rejected: 0, alreadyInLibrary: 1 });
    expect(out.stats.byHost).toEqual({ "exemplu.invalid": 2 });
  });

  it("respingerile se numără pe motiv, cu domeniul, fără adresa completă; HTML-ul nu mai are <img> respins", () => {
    const html = `<img src="https://alt.invalid/x.jpg"><img src="${u("a")}">`;
    const out = planDescriptionImages(html, policy, new Map(), fresh());
    expect(out.stats).toMatchObject({ total: 2, accepted: 1, rejected: 1 });
    expect(out.stats.rejectedByReason).toEqual({ host_not_allowed: 1 });
    expect(out.issues).toEqual([{ position: 0, host: "alt.invalid", reason: "host_not_allowed" }]);
    expect(out.html).toBe(token("a"));
  });

  it("limita pe import e comună tuturor descrierilor: peste ea, imaginile se resping cu «too_many_for_import»", () => {
    const budget = { accepted: 1999 };
    const html = `<img src="${u("a")}"><img src="${u("b")}">`;
    const out = planDescriptionImages(html, policy, new Map(), budget);
    expect(out.tasks.map((task) => task.hash)).toEqual([hashOf("a")]);
    expect(out.issues).toEqual([{ position: 1, host: null, reason: "too_many_for_import" }]);
    expect(budget.accepted).toBe(2000);
  });

  it("limita pe produs se aplică pe descriere", () => {
    const small = { ...policy, maxImagesPerProduct: 1 };
    const out = planDescriptionImages(
      `<img src="${u("a")}"><img src="${u("b")}">`,
      small,
      new Map(),
      fresh(),
    );
    expect(out.tasks).toHaveLength(1);
    expect(out.issues[0]?.reason).toBe("too_many_for_product");
  });

  it("fără politică (opțiunea oprită): HTML-ul rămâne neatins, iar sanitizatorul elimină imaginile ca în 15c (fără sarcini, fără marcaje)", () => {
    const html = `<p><img src="${u("a")}"></p>`;
    const out = planDescriptionImages(html, null, new Map(), fresh());
    expect(out.html).toBe(html);
    expect(out.tasks).toEqual([]);
    expect(out.stats.total).toBe(0);
  });
});
