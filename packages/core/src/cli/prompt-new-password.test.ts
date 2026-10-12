import { describe, expect, it } from "vitest";
import { promptNewPassword } from "./prompt";

function scripted(answers: string[]) {
  const asked: string[] = [];
  return {
    asked,
    ask: async (question: string) => {
      asked.push(question);
      const next = answers.shift();
      if (next === undefined) throw new Error("prea multe întrebări");
      return next;
    },
  };
}

const minLen = (n: number) => (p: string) => (p.length >= n ? null : `minim ${n}`);

describe("promptNewPassword", () => {
  it("cere parola de două ori și o întoarce când coincid", async () => {
    const s = scripted(["parola-lunga-12", "parola-lunga-12"]);
    expect(await promptNewPassword({ validate: minLen(12), ask: s.ask })).toBe("parola-lunga-12");
    expect(s.asked).toHaveLength(2);
  });

  it("parolă prea scurtă: raportează și reia, fără să ceară repetarea", async () => {
    const s = scripted(["scurta", "parola-lunga-12", "parola-lunga-12"]);
    const reports: string[] = [];
    const out = await promptNewPassword({
      validate: minLen(12),
      ask: s.ask,
      report: (m) => reports.push(m),
    });
    expect(out).toBe("parola-lunga-12");
    expect(reports).toEqual(["minim 12"]);
    expect(s.asked).toHaveLength(3);
  });

  it("repetare diferită: raportează „nu coincid”, reia și după 3 încercări renunță", async () => {
    const s = scripted([
      "parola-lunga-12",
      "alta-parola-12",
      "parola-lunga-12",
      "alta-parola-12",
      "parola-lunga-12",
      "alta-parola-12",
    ]);
    const reports: string[] = [];
    await expect(
      promptNewPassword({ validate: minLen(12), ask: s.ask, report: (m) => reports.push(m) }),
    ).rejects.toThrow("Prea multe încercări");
    expect(reports.filter((r) => r.includes("nu coincid"))).toHaveLength(3);
  });

  it("un mesaj de validare nu conține parola introdusă", async () => {
    const secret = "scurta-secreta";
    const s = scripted([secret, "parola-lunga-12", "parola-lunga-12"]);
    const reports: string[] = [];
    await promptNewPassword({
      validate: (p) => (p.length >= 15 ? null : "Parola trebuie să aibă cel puțin 15 caractere"),
      ask: s.ask,
      report: (m) => reports.push(m),
      maxAttempts: 5,
    }).catch(() => undefined);
    for (const r of reports) expect(r).not.toContain(secret);
  });
});
