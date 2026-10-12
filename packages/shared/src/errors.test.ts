import { describe, expect, it } from "vitest";
import { DomainError, IntegrationError, ValidationError } from "./errors";

describe("erori tipate", () => {
  it("DomainError păstrează codul stabil, mesajul și detaliile", () => {
    const error = new DomainError("ORDER_NOT_FOUND", "Comanda nu există", { id: 7 });
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("ORDER_NOT_FOUND");
    expect(error.message).toBe("Comanda nu există");
    expect(error.details).toEqual({ id: 7 });
    expect(error.name).toBe("DomainError");
  });

  it("ValidationError are codul fix VALIDATION_ERROR și e DomainError", () => {
    const error = new ValidationError("Date invalide", { field: "email" });
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.name).toBe("ValidationError");
    expect(error.details).toEqual({ field: "email" });
  });

  it("IntegrationError e DomainError cu cod stabil dat de apelant", () => {
    const error = new IntegrationError("STORAGE_FAILED", "Scrierea a eșuat", { status: 500 });
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe("STORAGE_FAILED");
    expect(error.name).toBe("IntegrationError");
    expect(error.details).toEqual({ status: 500 });
  });
});
