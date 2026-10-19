import { describe, expect, it } from "vitest";
import {
  SAFE_FETCH_HEADERS,
  SafeFetchError,
  safeFetchImage,
  type ConnectRequest,
  type ConnectResponse,
  type Connector,
  type Resolver,
  type SafeFetchPolicy,
} from "./safe-fetch";

const POLICY: SafeFetchPolicy = {
  allowedHosts: ["piscineshop.ro", "cdn.piscineshop.ro"],
  maxUrlLength: 2000,
  maxBytes: 1024,
  connectTimeoutMs: 200,
  totalTimeoutMs: 1000,
  maxRedirects: 3,
};

const PUBLIC_IP = { address: "93.184.216.34", family: 4 as const };
const PNG = Buffer.from("octeti-de-imagine");

const publicResolver: Resolver = async () => [PUBLIC_IP];

async function* chunks(parts: readonly Buffer[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield part;
}

const ok = (
  body: Buffer | readonly Buffer[],
  headers: Record<string, string> = {},
): ConnectResponse => ({
  status: 200,
  headers,
  body: chunks(Array.isArray(body) ? body : [body as Buffer]),
  close: () => undefined,
});

const redirect = (location: string | undefined, status = 302): ConnectResponse => ({
  status,
  headers: location === undefined ? {} : { location },
  body: chunks([]),
  close: () => undefined,
});

/** Conector care întoarce pe rând răspunsurile date și memorează cererile primite. */
function connector(...responses: (ConnectResponse | Error)[]): {
  connect: Connector;
  requests: ConnectRequest[];
} {
  const requests: ConnectRequest[] = [];
  let index = 0;
  return {
    requests,
    connect: async (request) => {
      requests.push(request);
      const next = responses[Math.min(index++, responses.length - 1)] as ConnectResponse | Error;
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

async function code(
  url: string,
  deps: Parameters<typeof safeFetchImage>[2],
  policy: SafeFetchPolicy = POLICY,
): Promise<string> {
  try {
    await safeFetchImage(url, policy, deps);
  } catch (error) {
    if (error instanceof SafeFetchError) return error.code;
    throw error;
  }
  return "OK";
}

const GOOD = "https://piscineshop.ro/wp-content/uploads/poza.jpg?v=2";

describe("descărcarea sigură: calea fericită", () => {
  it("descarcă prin IP-ul validat, cu gazda pentru SNI/Host și antetele fixe; o singură rezolvare", async () => {
    let resolves = 0;
    const { connect, requests } = connector(ok(PNG));
    const result = await safeFetchImage(GOOD, POLICY, {
      resolve: async () => {
        resolves++;
        return [PUBLIC_IP];
      },
      connect,
    });
    expect(result.bytes.equals(PNG)).toBe(true);
    expect(result.host).toBe("piscineshop.ro");
    expect(resolves).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      host: "piscineshop.ro",
      address: PUBLIC_IP,
      path: "/wp-content/uploads/poza.jpg?v=2",
    });
    // antete fixe: fără cookie-uri, autorizare sau antete interne
    expect(requests[0]?.headers).toEqual(SAFE_FETCH_HEADERS);
    expect(Object.keys(requests[0]?.headers ?? {}).map((k) => k.toLowerCase())).not.toEqual(
      expect.arrayContaining(["cookie", "authorization"]),
    );
    expect(requests[0]?.headers["Accept-Encoding"]).toBe("identity");
  });

  it("gazda se normalizează (majuscule, punct final) și se potrivește exact cu lista", async () => {
    const { connect } = connector(ok(PNG));
    const result = await safeFetchImage("https://PiscineShop.RO./a.jpg", POLICY, {
      resolve: publicResolver,
      connect,
    });
    expect(result.host).toBe("piscineshop.ro");
  });
});

describe("adresa: refuzată înainte de orice rețea", () => {
  const denied = {
    resolve: async () => {
      throw new Error("rețea apelată");
    },
    connect: async () => {
      throw new Error("rețea apelată");
    },
  } as const;

  it.each([
    ["http://piscineshop.ro/a.jpg", "scheme"],
    ["ftp://piscineshop.ro/a.jpg", "scheme"],
    ["//piscineshop.ro/a.jpg", "invalid"],
    ["piscineshop.ro/a.jpg", "invalid"],
    ["https://utilizator@piscineshop.ro/a.jpg", "credentials"],
    ["https://utilizator:parola@piscineshop.ro/a.jpg", "credentials"],
    ["https://piscineshop.ro:8080/a.jpg", "port"],
    ["https://piscineshop.ro:80/a.jpg", "port"],
    ["https://piscineshop.ro/a.jpg#x", "fragment"],
    ["https://127.0.0.1/a.jpg", "ip_literal"],
    ["https://8.8.8.8/a.jpg", "ip_literal"],
    ["https://2130706433/a.jpg", "ip_literal"],
    ["https://0177.0.0.1/a.jpg", "ip_literal"],
    ["https://0x7f.0.0.1/a.jpg", "ip_literal"],
    ["https://0x7f000001/a.jpg", "ip_literal"],
    ["https://127.1/a.jpg", "ip_literal"],
    ["https://169.254.169.254/latest/meta-data/", "ip_literal"],
    ["https://[::1]/a.jpg", "ip_literal"],
    ["https://[::ffff:127.0.0.1]/a.jpg", "ip_literal"],
    ["https://[::ffff:7f00:1]/a.jpg", "ip_literal"],
    ["https://[fe80::1]/a.jpg", "ip_literal"],
    ["https://localhost/a.jpg", "invalid"],
    ["https://localhost./a.jpg", "invalid"],
    ["https://alt-domeniu.ro/a.jpg", "host_not_allowed"],
    ["https://piscineshop.ro.alt-domeniu.ro/a.jpg", "host_not_allowed"],
    ["https://alt.piscineshop.ro/a.jpg", "host_not_allowed"],
    ["https://piscineshop.ro@alt-domeniu.ro/a.jpg", "credentials"],
    ["https://piscineshop.ro\\@alt-domeniu.ro/a.jpg", "invalid"],
    ["https://piscineshop.ro/a b.jpg", "invalid"],
    ["https://piscineshop.ro/a\n.jpg", "invalid"],
    ["https://piscineshop.ro/\u0000.jpg", "invalid"],
    ["", "invalid"],
  ])("%s → %s, fără nicio cerere de rețea", async (url, expected) => {
    expect(await code(url, denied)).toBe(expected);
  });

  it("adresă prea lungă", async () => {
    const long = `https://piscineshop.ro/${"a".repeat(2100)}.jpg`;
    expect(await code(long, denied)).toBe("too_long");
  });

  it("lista de domenii goală: nimic nu se descarcă", async () => {
    expect(await code(GOOD, denied, { ...POLICY, allowedHosts: [] })).toBe("no_hosts_configured");
  });
});

describe("DNS: toate adresele publice, rezolvare unică, conexiune fixată", () => {
  it.each([
    ["127.0.0.1"],
    ["10.1.2.3"],
    ["192.168.0.10"],
    ["172.16.5.5"],
    ["169.254.169.254"],
    ["100.64.0.1"],
    ["0.0.0.0"],
    ["224.0.0.1"],
    ["::1"],
    ["fe80::1"],
    ["fd00::1"],
    ["::ffff:127.0.0.1"],
    ["::ffff:8.8.8.8"],
    ["64:ff9b::808:808"],
    ["2002:7f00:1::1"],
  ])("numele care rezolvă la %s e respins fără conectare", async (address) => {
    const { connect, requests } = connector(ok(PNG));
    const family = address.includes(":") ? (6 as const) : (4 as const);
    expect(await code(GOOD, { resolve: async () => [{ address, family }], connect })).toBe(
      "address_not_public",
    );
    expect(requests).toHaveLength(0);
  });

  it("dacă UN SINGUR record e privat, tot numele e respins", async () => {
    const { connect, requests } = connector(ok(PNG));
    const mixed: Resolver = async () => [PUBLIC_IP, { address: "10.0.0.5", family: 4 }];
    expect(await code(GOOD, { resolve: mixed, connect })).toBe("address_not_public");
    const mixedV6: Resolver = async () => [PUBLIC_IP, { address: "::1", family: 6 }];
    expect(await code(GOOD, { resolve: mixedV6, connect })).toBe("address_not_public");
    expect(requests).toHaveLength(0);
  });

  it("DNS eșuat sau gol", async () => {
    const { connect } = connector(ok(PNG));
    expect(
      await code(GOOD, {
        resolve: async () => {
          throw new Error("NXDOMAIN 10.0.0.1");
        },
        connect,
      }),
    ).toBe("dns_failed");
    expect(await code(GOOD, { resolve: async () => [], connect })).toBe("dns_failed");
  });

  it("rebinding: o singură rezolvare, conectarea se face la IP-ul validat (a doua rezolvare ar da IP privat)", async () => {
    let calls = 0;
    const rebinding: Resolver = async () => {
      calls++;
      return calls === 1 ? [PUBLIC_IP] : [{ address: "127.0.0.1", family: 4 }];
    };
    const { connect, requests } = connector(ok(PNG));
    const result = await safeFetchImage(GOOD, POLICY, { resolve: rebinding, connect });
    expect(result.bytes.equals(PNG)).toBe(true);
    expect(calls).toBe(1);
    expect(requests).toHaveLength(1);
    // conectorul primește IP-ul validat, nu un nume de rezolvat din nou
    expect(requests[0]?.address).toEqual(PUBLIC_IP);
  });

  it("rebinding pe redirect: al doilea salt se rezolvă din nou și un IP privat e respins", async () => {
    let calls = 0;
    const rebinding: Resolver = async () => {
      calls++;
      return calls === 1 ? [PUBLIC_IP] : [{ address: "169.254.169.254", family: 4 }];
    };
    const { connect, requests } = connector(redirect("/alta/poza.jpg"), ok(PNG));
    expect(await code(GOOD, { resolve: rebinding, connect })).toBe("address_not_public");
    expect(requests).toHaveLength(1); // nu s-a conectat la al doilea salt
  });

  it("încearcă următoarea adresă publică dacă prima nu se conectează; nu depășește 4 încercări", async () => {
    const second = { address: "93.184.216.35", family: 4 as const };
    const { connect, requests } = connector(new Error("ECONNREFUSED"), ok(PNG));
    const result = await safeFetchImage(GOOD, POLICY, {
      resolve: async () => [PUBLIC_IP, second],
      connect,
    });
    expect(result.bytes.equals(PNG)).toBe(true);
    expect(requests.map((r) => r.address.address)).toEqual([PUBLIC_IP.address, second.address]);

    const many = Array.from({ length: 8 }, (_, i) => ({
      address: `93.184.216.${40 + i}`,
      family: 4 as const,
    }));
    const failing = connector(new Error("ECONNREFUSED"));
    expect(await code(GOOD, { resolve: async () => many, connect: failing.connect })).toBe(
      "connect_failed",
    );
    expect(failing.requests).toHaveLength(4);
  });
});

describe("redirecturi: manuale, revalidate, doar în aceeași gazdă", () => {
  it("urmează un redirect relativ în aceeași gazdă și revalidează (rezolvare la fiecare salt)", async () => {
    let resolves = 0;
    const { connect, requests } = connector(redirect("/noua/poza.jpg", 301), ok(PNG));
    const result = await safeFetchImage(GOOD, POLICY, {
      resolve: async () => {
        resolves++;
        return [PUBLIC_IP];
      },
      connect,
    });
    expect(result.bytes.equals(PNG)).toBe(true);
    expect(resolves).toBe(2);
    expect(requests.map((r) => r.path)).toEqual([
      "/wp-content/uploads/poza.jpg?v=2",
      "/noua/poza.jpg",
    ]);
  });

  it.each([
    ["https://127.0.0.1/a.jpg", "ip_literal"],
    ["https://169.254.169.254/latest/meta-data/", "ip_literal"],
    ["https://[::1]/a.jpg", "ip_literal"],
    ["http://piscineshop.ro/a.jpg", "scheme"],
    ["https://piscineshop.ro:8443/a.jpg", "port"],
    ["https://utilizator@piscineshop.ro/a.jpg", "credentials"],
    ["https://alt-domeniu.ro/a.jpg", "host_not_allowed"],
    ["https://cdn.piscineshop.ro/a.jpg", "redirect_refused"], // în listă, dar altă gazdă
    ["//cdn.piscineshop.ro/a.jpg", "redirect_refused"],
    ["file:///etc/passwd", "scheme"],
  ])("redirect către %s → %s", async (location, expected) => {
    const { connect } = connector(redirect(location), ok(PNG));
    expect(await code(GOOD, { resolve: publicResolver, connect })).toBe(expected);
  });

  it("redirect către un nume care rezolvă la IP privat e respins la al doilea salt", async () => {
    const resolver: Resolver = async (host) =>
      host === "piscineshop.ro" ? [PUBLIC_IP] : [{ address: "10.0.0.9", family: 4 }];
    const { connect } = connector(redirect("https://cdn.piscineshop.ro/a.jpg"), ok(PNG));
    // altă gazdă: refuzat înainte să conte DNS-ul
    expect(await code(GOOD, { resolve: resolver, connect })).toBe("redirect_refused");
  });

  it("mai mult de 3 salturi e respins; exact 3 trece", async () => {
    const three = connector(redirect("/1"), redirect("/2"), redirect("/3"), ok(PNG));
    expect(
      (
        await safeFetchImage(GOOD, POLICY, { resolve: publicResolver, connect: three.connect })
      ).bytes.equals(PNG),
    ).toBe(true);
    const four = connector(redirect("/1"), redirect("/2"), redirect("/3"), redirect("/4"), ok(PNG));
    expect(await code(GOOD, { resolve: publicResolver, connect: four.connect })).toBe(
      "too_many_redirects",
    );
  });

  it("plafonul din politică se aplică (0 = fără redirecturi); redirect fără Location e refuzat", async () => {
    const none = connector(redirect("/x"), ok(PNG));
    expect(
      await code(
        GOOD,
        { resolve: publicResolver, connect: none.connect },
        { ...POLICY, maxRedirects: 0 },
      ),
    ).toBe("too_many_redirects");
    const noLocation = connector(redirect(undefined), ok(PNG));
    expect(await code(GOOD, { resolve: publicResolver, connect: noLocation.connect })).toBe(
      "redirect_refused",
    );
  });
});

describe("limite: mărime, timp, răspuns", () => {
  it("corp prea mare fără Content-Length: oprit la depășire, fără să citească restul", async () => {
    let read = 0;
    async function* endless(): AsyncGenerator<Uint8Array> {
      for (;;) {
        read++;
        yield Buffer.alloc(512);
      }
    }
    const response: ConnectResponse = {
      status: 200,
      headers: {},
      body: endless(),
      close: () => undefined,
    };
    expect(await code(GOOD, { resolve: publicResolver, connect: async () => response })).toBe(
      "too_large",
    );
    expect(read).toBeLessThanOrEqual(4);
  });

  it("Content-Length mincinos (mic) nu ajută: plafonul de pe flux se aplică", async () => {
    const big = Buffer.alloc(POLICY.maxBytes + 1);
    const response = ok([big], { "content-length": "10" });
    expect(await code(GOOD, { resolve: publicResolver, connect: async () => response })).toBe(
      "too_large",
    );
  });

  it("Content-Length mare declarat: refuz imediat", async () => {
    let touched = false;
    async function* body(): AsyncGenerator<Uint8Array> {
      touched = true;
      yield PNG;
    }
    const response: ConnectResponse = {
      status: 200,
      headers: { "content-length": "999999999" },
      body: body(),
      close: () => undefined,
    };
    expect(await code(GOOD, { resolve: publicResolver, connect: async () => response })).toBe(
      "too_large",
    );
    expect(touched).toBe(false);
  });

  it("un corp exact la limită trece", async () => {
    const exact = Buffer.alloc(POLICY.maxBytes, 1);
    const result = await safeFetchImage(GOOD, POLICY, {
      resolve: publicResolver,
      connect: async () => ok(exact),
    });
    expect(result.bytes.length).toBe(POLICY.maxBytes);
  });

  it("răspuns lent (conectorul nu răspunde): timp depășit", async () => {
    const slow: Connector = (request) =>
      new Promise((_, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("abortat")));
      });
    const started = Date.now();
    expect(
      await code(
        GOOD,
        { resolve: publicResolver, connect: slow },
        { ...POLICY, totalTimeoutMs: 150, connectTimeoutMs: 100 },
      ),
    ).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("corp care curge prea încet: timp depășit", async () => {
    async function* trickle(): AsyncGenerator<Uint8Array> {
      for (let i = 0; i < 50; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield Buffer.from("x");
      }
    }
    const response: ConnectResponse = {
      status: 200,
      headers: {},
      body: trickle(),
      close: () => undefined,
    };
    expect(
      await code(
        GOOD,
        { resolve: publicResolver, connect: async () => response },
        { ...POLICY, totalTimeoutMs: 120 },
      ),
    ).toBe("timeout");
  });

  it("DNS lent: timp depășit", async () => {
    const slowDns: Resolver = () => new Promise(() => undefined);
    const { connect } = connector(ok(PNG));
    expect(
      await code(GOOD, { resolve: slowDns, connect }, { ...POLICY, connectTimeoutMs: 80 }),
    ).toBe("timeout");
  });

  it("răspuns comprimat, status diferit de 200, corp gol", async () => {
    expect(
      await code(GOOD, {
        resolve: publicResolver,
        connect: async () => ok(PNG, { "content-encoding": "gzip" }),
      }),
    ).toBe("compressed");
    expect(
      await code(GOOD, {
        resolve: publicResolver,
        connect: async () => ok(PNG, { "content-encoding": "identity" }),
      }),
    ).toBe("OK");
    for (const status of [204, 401, 403, 404, 500]) {
      const response: ConnectResponse = {
        status,
        headers: {},
        body: chunks([PNG]),
        close: () => undefined,
      };
      expect(await code(GOOD, { resolve: publicResolver, connect: async () => response })).toBe(
        "bad_status",
      );
    }
    expect(await code(GOOD, { resolve: publicResolver, connect: async () => ok([]) })).toBe(
      "empty",
    );
  });

  it("erorile de conectare nu scurg detalii (cod stabil, fără mesajul original)", async () => {
    const { connect } = connector(new Error("connect ECONNREFUSED 10.1.2.3:443 secret-token"));
    try {
      await safeFetchImage(GOOD, POLICY, { resolve: publicResolver, connect });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SafeFetchError);
      expect((error as SafeFetchError).code).toBe("connect_failed");
      expect(String((error as Error).message) + JSON.stringify(error)).not.toMatch(
        /10\.1\.2\.3|secret|ECONN/,
      );
    }
  });
});
