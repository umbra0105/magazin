import { describe, expect, it } from "vitest";
import { createLogger } from "./logger";
import { resolveRequestId } from "./request-id";
import { runWithRequestContext } from "./request-context";

function capture() {
  const lines: Record<string, unknown>[] = [];
  const destination = {
    write(chunk: string) {
      lines.push(JSON.parse(chunk) as Record<string, unknown>);
    },
  };
  return { lines, logger: createLogger({ level: "debug", destination }) };
}

describe("logger", () => {
  it("adaugă requestId pe logurile din cadrul unei cereri", () => {
    const { lines, logger } = capture();
    runWithRequestContext({ requestId: "req-12345678" }, () => logger.info("comandă plasată"));
    expect(lines[0]).toMatchObject({ msg: "comandă plasată", requestId: "req-12345678" });
  });

  it("nu adaugă requestId în afara unei cereri", () => {
    const { lines, logger } = capture();
    logger.info("pornire");
    expect(lines[0]).not.toHaveProperty("requestId");
  });

  it("ascunde câmpurile sensibile", () => {
    const { lines, logger } = capture();
    logger.info({ user: { password: "parola-secreta" }, headers: { cookie: "sid=abc" } }, "login");
    const serialized = JSON.stringify(lines[0]);
    expect(serialized).not.toContain("parola-secreta");
    expect(serialized).not.toContain("sid=abc");
    expect(serialized).toContain("[ascuns]");
  });
});

describe("logger: câmpuri de cost și credențiale", () => {
  it("ascunde costPrice, costPriceDate și credentials, inclusiv imbricate în linii de comandă", () => {
    const { lines, logger } = capture();
    logger.info(
      {
        variant: { sku: "A1", costPrice: 11111, costPriceDate: "2026-10-01" },
        order: { lines: [{ sku: "A1", costNet: 22222 }] },
        integration: { provider: "netopia", credentials: "v1:aaaa:bbbb:cccc" },
        costPrice: 33333,
      },
      "test",
    );
    const serialized = JSON.stringify(lines[0]);
    for (const secret of ["11111", "2026-10-01", "22222", "v1:aaaa", "33333"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('"sku":"A1"');
  });
});

describe("resolveRequestId", () => {
  it("păstrează un id valid primit de la client", () => {
    expect(resolveRequestId("abc-12345678")).toBe("abc-12345678");
  });

  it("generează un id nou pentru valori lipsă sau nesigure", () => {
    expect(resolveRequestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveRequestId("scurt")).toMatch(/^[0-9a-f-]{36}$/);
    expect(resolveRequestId("x\ny-injectat-in-log")).toMatch(/^[0-9a-f-]{36}$/);
  });
});
