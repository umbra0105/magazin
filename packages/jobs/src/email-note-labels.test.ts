import { describe, expect, it } from "vitest";
import { EMAIL_NOTE_LABELS, emailNoteLabel } from "@ecom/core";
import { templateDefinition } from "@ecom/emails";

/**
 * Linia de context a notificării «Un email a rămas netrimis» folosește etichete scurte ținute în `core` (care nu depinde de
 * pachetul de emailuri). Aici, unde se văd ambele, ele rămân identice cu etichetele din catalogul de șabloane.
 */
describe("etichetele șabloanelor din notificări", () => {
  it("fiecare etichetă din core e cea din catalogul de șabloane", () => {
    for (const [key, label] of Object.entries(EMAIL_NOTE_LABELS)) {
      expect(templateDefinition(key)?.label, key).toBe(label);
    }
  });

  it("un șablon necunoscut primește eticheta generică, nu cheia tehnică", () => {
    expect(emailNoteLabel("nu.exista")).toBe("Email netrimis");
    expect(emailNoteLabel("order.confirmation")).toBe("Confirmare comandă");
  });
});
