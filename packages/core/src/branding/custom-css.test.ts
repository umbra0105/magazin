import { describe, expect, it } from "vitest";
import {
  CUSTOM_CSS_MAX_LENGTH,
  renderCustomCss,
  validateCustomCss,
  CUSTOM_CSS_SCOPE,
} from "./custom-css";

/**
 * CSS-ul personalizat al vitrinei vine de la un administrator, dar nu e de încredere: nu are voie să facă cereri către alte
 * adrese (`url()`, `@import`), să încarce fonturi, să execute cod (vechile `expression()`, `behavior`) sau să iasă din zona lui
 * (acolade nebalansate). Se validează la salvare ȘI la randare, iar la randare se împachetează într-un selector al vitrinei,
 * deci nu poate atinge adminul.
 */
const ok = (css: string) => validateCustomCss(css);

describe("validateCustomCss: ce se acceptă", () => {
  it("gol, reguli simple, @media și @supports", () => {
    expect(ok("").ok).toBe(true);
    expect(ok(".card { border-radius: 4px; }").ok).toBe(true);
    expect(ok("a:hover{color:var(--color-primary)} /* un comentariu */").ok).toBe(true);
    expect(ok("@media (min-width: 48rem){.x{padding:0}}").ok).toBe(true);
    expect(ok("@supports (display:grid){.x{display:grid}}").ok).toBe(true);
    expect(ok("h1 > span{font-weight:700}").ok).toBe(true);
    expect(ok('.x::after{content:"→"}').ok).toBe(true);
  });
});

describe("validateCustomCss: ce se respinge", () => {
  const bad: Array<[string, string]> = [
    ["url()", ".x{background:url(https://evil.test/a.png)}"],
    ["url() cu majuscule și spații", ".x{background:URL( 'a.png' )}"],
    ["url() ascuns printr-un comentariu", ".x{background:u/**/rl(a.png)}"],
    ["url() prin escape", ".x{background:\\75rl(a.png)}"],
    ["orice backslash", ".x{content:'\\41'}"],
    ["@import", '@import "https://evil.test/a.css";'],
    ["@import cu majuscule", '@IMPORT url("a.css");'],
    ["@font-face", "@font-face{font-family:x;src:local(x)}"],
    ["@charset", '@charset "utf-8";'],
    ["@namespace", "@namespace svg url(http://www.w3.org/2000/svg);"],
    ["@keyframes (în afara listei)", "@keyframes a{from{opacity:0}to{opacity:1}}"],
    ["image-set()", ".x{background:image-set('a.png' 1x)}"],
    ["expression()", ".x{width:expression(alert(1))}"],
    ["behavior", ".x{behavior:url(x.htc)}"],
    ["-moz-binding", ".x{-moz-binding:url(x.xml#a)}"],
    ["javascript:", ".x{background:javascript:alert(1)}"],
    ["data:", ".x{background:data:image/png;base64,AAAA}"],
    ["</style>", ".x{color:red}</style><script>alert(1)</script>"],
    ["<!--", "<!-- .x{color:red}"],
    ["acoladă de închidere în plus", ".x{color:red}} .y{color:blue}"],
    ["acoladă nenchisă", ".x{color:red"],
    ["comentariu nenchis", ".x{color:red} /* nenchis"],
    ["imbricare prea adâncă", "@media a{@media b{@media c{@media d{.x{a:b}}}}}"],
    ["caractere de control", ".x{color:red}\u0000"],
  ];
  for (const [name, css] of bad) {
    it(name, () => {
      const result = ok(css);
      expect(result.ok, css).toBe(false);
    });
  }

  it("depășirea lungimii maxime", () => {
    expect(ok(`.x{a:b}${" ".repeat(CUSTOM_CSS_MAX_LENGTH)}`).ok).toBe(false);
    expect(ok("a".repeat(10)).ok).toBe(true);
  });

  it("întoarce un cod stabil pentru fiecare motiv", () => {
    const code = (css: string) => {
      const r = ok(css);
      return r.ok ? null : r.code;
    };
    expect(code(".x{background:url(a)}")).toBe("CUSTOM_CSS_FORBIDDEN");
    expect(code(".x{color:red")).toBe("CUSTOM_CSS_UNBALANCED");
    expect(code("a".repeat(CUSTOM_CSS_MAX_LENGTH + 1))).toBe("CUSTOM_CSS_TOO_LONG");
    expect(code("@keyframes a{}")).toBe("CUSTOM_CSS_AT_RULE");
  });
});

describe("renderCustomCss", () => {
  it("împachetează regulile în selectorul vitrinei (imbricare nativă), fără comentarii", () => {
    const css = renderCustomCss(".x{color:red} /* nota */");
    expect(css).toBe(`${CUSTOM_CSS_SCOPE}{.x{color:red} }`);
    expect(css).not.toContain("nota");
  });

  it("gol sau invalid: nimic (un CSS strâmb din bază nu ajunge niciodată în pagină)", () => {
    expect(renderCustomCss("")).toBe("");
    expect(renderCustomCss("   ")).toBe("");
    expect(renderCustomCss(".x{background:url(a)}")).toBe("");
    expect(renderCustomCss(".x{color:red")).toBe("");
  });

  it("selectorul de scop poate fi înlocuit (previzualizarea din admin)", () => {
    expect(renderCustomCss(".x{a:b}", "[data-theme-preview]")).toBe(
      "[data-theme-preview]{.x{a:b}}",
    );
  });
});
