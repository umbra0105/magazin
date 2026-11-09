import { describe, expect, it } from "vitest";
import {
  SIDEBAR_ATTRIBUTE,
  SIDEBAR_STORAGE_KEY,
  applySidebarChoice,
  readSidebarChoice,
  writeSidebarChoice,
} from "./sidebar-choice";
import {
  THEME_INIT_SCRIPT,
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

describe("citirea și scrierea alegerii de temă (în try/catch)", () => {
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

/** Un <html> de mână: stilul `color-scheme` și atributele. */
function fakeDocument() {
  const attributes: Record<string, string> = {};
  const doc = {
    documentElement: {
      style: { colorScheme: "" },
      setAttribute: (name: string, value: string) => {
        attributes[name] = value;
      },
      removeAttribute: (name: string) => {
        delete attributes[name];
      },
    },
  };
  return { doc, attributes };
}

describe("applyThemeChoice (tema se comută prin color-scheme: tokenii folosesc light-dark())", () => {
  it("luminos și întunecat forțează schema pe <html>; sistem o curăță, ca browserul să urmeze sistemul", () => {
    const { doc } = fakeDocument();
    applyThemeChoice("dark", doc as unknown as Document);
    expect(doc.documentElement.style.colorScheme).toBe("dark");
    applyThemeChoice("light", doc as unknown as Document);
    expect(doc.documentElement.style.colorScheme).toBe("light");
    applyThemeChoice("system", doc as unknown as Document);
    expect(doc.documentElement.style.colorScheme).toBe("");
  });
});

describe("bara laterală pliată (alegere reținută)", () => {
  it("citește «collapsed», orice altceva (sau lipsa) înseamnă desfăcută", () => {
    expect(readSidebarChoice(memoryStorage({ [SIDEBAR_STORAGE_KEY]: "collapsed" }))).toBe(
      "collapsed",
    );
    expect(readSidebarChoice(memoryStorage({ [SIDEBAR_STORAGE_KEY]: "altceva" }))).toBe("expanded");
    expect(readSidebarChoice(memoryStorage())).toBe("expanded");
  });

  it("fără stocare (aruncă sau lipsește): desfăcută, scrierea întoarce false, nu aruncă", () => {
    expect(readSidebarChoice(throwingStorage)).toBe("expanded");
    expect(readSidebarChoice(null)).toBe("expanded");
    expect(writeSidebarChoice("collapsed", throwingStorage)).toBe(false);
    expect(writeSidebarChoice("collapsed", null)).toBe(false);
  });

  it("scrie și reciteste alegerea", () => {
    const storage = memoryStorage();
    expect(writeSidebarChoice("collapsed", storage)).toBe(true);
    expect(readSidebarChoice(storage)).toBe("collapsed");
  });

  it("applySidebarChoice pune sau scoate atributul de pe <html>", () => {
    const { doc, attributes } = fakeDocument();
    applySidebarChoice("collapsed", doc as unknown as Document);
    expect(attributes[SIDEBAR_ATTRIBUTE]).toBe("collapsed");
    applySidebarChoice("expanded", doc as unknown as Document);
    expect(attributes[SIDEBAR_ATTRIBUTE]).toBeUndefined();
  });
});

describe("THEME_INIT_SCRIPT (rulează înainte de primul paint)", () => {
  const run = (windowStub: unknown, documentStub: unknown) =>
    new Function("window", "document", THEME_INIT_SCRIPT)(windowStub, documentStub);

  it("aplică tema salvată pe color-scheme", () => {
    const { doc } = fakeDocument();
    run({ localStorage: memoryStorage({ [THEME_STORAGE_KEY]: "dark" }) }, doc);
    expect(doc.documentElement.style.colorScheme).toBe("dark");
  });

  it("aplică bara laterală pliată înainte de primul paint (fără un cadru cu bara desfăcută)", () => {
    const { doc, attributes } = fakeDocument();
    run({ localStorage: memoryStorage({ [SIDEBAR_STORAGE_KEY]: "collapsed" }) }, doc);
    expect(attributes[SIDEBAR_ATTRIBUTE]).toBe("collapsed");
  });

  it("fără alegeri salvate nu schimbă nimic (sistem, bara desfăcută)", () => {
    const { doc, attributes } = fakeDocument();
    run({ localStorage: memoryStorage() }, doc);
    expect(doc.documentElement.style.colorScheme).toBe("");
    expect(attributes).toEqual({});
  });

  it("o valoare necunoscută nu se aplică", () => {
    const { doc, attributes } = fakeDocument();
    run(
      {
        localStorage: memoryStorage({ [THEME_STORAGE_KEY]: "violet", [SIDEBAR_STORAGE_KEY]: "x" }),
      },
      doc,
    );
    expect(doc.documentElement.style.colorScheme).toBe("");
    expect(attributes).toEqual({});
  });

  it("dacă accesul la localStorage aruncă (mod privat), scriptul nu aruncă și nu schimbă nimic", () => {
    const { doc, attributes } = fakeDocument();
    const blocked = {
      get localStorage(): never {
        throw new Error("SecurityError");
      },
    };
    expect(() => run(blocked, doc)).not.toThrow();
    expect(doc.documentElement.style.colorScheme).toBe("");
    expect(attributes).toEqual({});
  });

  it("o singură alegere ilizibilă nu o împiedică pe cealaltă", () => {
    const { doc, attributes } = fakeDocument();
    const half = {
      localStorage: {
        getItem: (key: string) => {
          if (key === THEME_STORAGE_KEY) throw new Error("SecurityError");
          return key === SIDEBAR_STORAGE_KEY ? "collapsed" : null;
        },
      },
    };
    run(half, doc);
    expect(attributes[SIDEBAR_ATTRIBUTE]).toBe("collapsed");
  });
});
