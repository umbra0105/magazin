import { describe, expect, it } from "vitest";
import {
  MEDIA_FOR_CHOICE,
  THEME_DARK_LINK_ID,
  THEME_INIT_SCRIPT,
  THEME_LIGHT_LINK_ID,
  THEME_STORAGE_KEY,
  applyThemeChoice,
  isThemeChoice,
  readThemeChoice,
  writeThemeChoice,
} from "./theme-choice";

const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (k: string) => data[k] ?? null,
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
};
const throwingStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
};

describe("citirea și scrierea alegerii (în try/catch)", () => {
  it("citește o alegere salvată validă", () => {
    expect(readThemeChoice(memoryStorage({ [THEME_STORAGE_KEY]: "dark" }))).toBe("dark");
    expect(readThemeChoice(memoryStorage({ [THEME_STORAGE_KEY]: "light" }))).toBe("light");
  });

  it("valoare necunoscută sau lipsă → sistem", () => {
    expect(readThemeChoice(memoryStorage({ [THEME_STORAGE_KEY]: "violet" }))).toBe("system");
    expect(readThemeChoice(memoryStorage())).toBe("system");
    expect(isThemeChoice(null)).toBe(false);
  });

  it("stocare indisponibilă (aruncă sau lipsește): nu aruncă, citește „sistem”, scrierea întoarce false", () => {
    expect(readThemeChoice(throwingStorage)).toBe("system");
    expect(readThemeChoice(null)).toBe("system");
    expect(writeThemeChoice("dark", throwingStorage)).toBe(false);
    expect(writeThemeChoice("dark", null)).toBe(false);
  });

  it("scrie și reciteste alegerea", () => {
    const storage = memoryStorage();
    expect(writeThemeChoice("light", storage)).toBe(true);
    expect(readThemeChoice(storage)).toBe("light");
  });
});

function fakeDocument() {
  const attrs: Record<string, Record<string, string>> = {
    [THEME_LIGHT_LINK_ID]: { media: "not all" },
    [THEME_DARK_LINK_ID]: { media: "(prefers-color-scheme: dark)" },
  };
  const doc = {
    getElementById: (id: string) =>
      attrs[id]
        ? {
            setAttribute: (name: string, value: string) => {
              (attrs[id] as Record<string, string>)[name] = value;
            },
          }
        : null,
    documentElement: { style: { colorScheme: "" } },
  };
  return { doc, attrs };
}

describe("applyThemeChoice", () => {
  it("fiecare alegere comută media pe cele două foi de stil", () => {
    for (const choice of ["system", "light", "dark"] as const) {
      const { doc, attrs } = fakeDocument();
      applyThemeChoice(choice, doc as unknown as Document);
      expect(attrs[THEME_LIGHT_LINK_ID]?.["media"]).toBe(MEDIA_FOR_CHOICE[choice].light);
      expect(attrs[THEME_DARK_LINK_ID]?.["media"]).toBe(MEDIA_FOR_CHOICE[choice].dark);
    }
  });

  it("luminos forțează paleta luminoasă; întunecat o forțează pe cea întunecată; sistem urmează sistemul", () => {
    expect(MEDIA_FOR_CHOICE.light).toEqual({ light: "all", dark: "not all" });
    expect(MEDIA_FOR_CHOICE.dark).toEqual({ light: "not all", dark: "all" });
    expect(MEDIA_FOR_CHOICE.system.dark).toBe("(prefers-color-scheme: dark)");
  });

  it("setează color-scheme pe <html> pentru luminos/întunecat și îl curăță la sistem", () => {
    const { doc } = fakeDocument();
    applyThemeChoice("dark", doc as unknown as Document);
    expect(doc.documentElement.style.colorScheme).toBe("dark");
    applyThemeChoice("system", doc as unknown as Document);
    expect(doc.documentElement.style.colorScheme).toBe("");
  });
});

describe("THEME_INIT_SCRIPT (rulează înainte de primul paint)", () => {
  const run = (windowStub: unknown, documentStub: unknown) =>
    new Function("window", "document", THEME_INIT_SCRIPT)(windowStub, documentStub);

  it("aplică alegerea salvată pe cele două foi de stil", () => {
    const { doc, attrs } = fakeDocument();
    run({ localStorage: memoryStorage({ [THEME_STORAGE_KEY]: "dark" }) }, doc);
    expect(attrs[THEME_DARK_LINK_ID]?.["media"]).toBe("all");
    expect(attrs[THEME_LIGHT_LINK_ID]?.["media"]).toBe("not all");
    expect(doc.documentElement.style.colorScheme).toBe("dark");
  });

  it("fără alegere salvată nu schimbă nimic (sistem)", () => {
    const { doc, attrs } = fakeDocument();
    run({ localStorage: memoryStorage() }, doc);
    expect(attrs[THEME_DARK_LINK_ID]?.["media"]).toBe("(prefers-color-scheme: dark)");
  });

  it("dacă accesul la localStorage aruncă (mod privat), scriptul nu aruncă și nu schimbă nimic", () => {
    const { doc, attrs } = fakeDocument();
    const blocked = {
      get localStorage(): never {
        throw new Error("SecurityError");
      },
    };
    expect(() => run(blocked, doc)).not.toThrow();
    expect(attrs[THEME_LIGHT_LINK_ID]?.["media"]).toBe("not all");
  });
});
