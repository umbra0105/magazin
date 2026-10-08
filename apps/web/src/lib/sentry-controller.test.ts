import type { ErrorEvent } from "@sentry/nextjs";
import { describe, expect, it, vi } from "vitest";
import { createSentryController, tagRequestId } from "./sentry-controller";

type Loaded = Awaited<
  Parameters<typeof createSentryController>[0]["loadSentry"] extends () => infer R ? R : never
>;

function setup(dsn: string | (() => Promise<string>)) {
  const scope = { setTag: vi.fn() };
  const fake = {
    init: vi.fn(),
    close: vi.fn(async () => true),
    captureRequestError: vi.fn(),
    withScope: vi.fn((cb: (s: typeof scope) => void) => cb(scope)),
  };
  const loadSentry = vi.fn(async () => fake as unknown as Loaded);
  const getDsn = typeof dsn === "function" ? dsn : async () => dsn;
  const controller = createSentryController({ getDsn, loadSentry });
  return { controller, fake, loadSentry, scope };
}

const request = {
  path: "/x",
  method: "GET",
  headers: { "x-request-id": "req-123" } as Record<string, string>,
};
const context = {
  routerKind: "App Router",
  routePath: "/x",
  routeType: "render",
  renderSource: "react-server-components",
  revalidateReason: undefined,
} as const;

describe("Sentry controller", () => {
  it("fără DSN este complet inactiv: SDK-ul nici nu se încarcă", async () => {
    const { controller, fake, loadSentry } = setup("");
    await controller.sync();
    await controller.captureRequestError(new Error("x"), request, context);
    expect(controller.isActive()).toBe(false);
    expect(loadSentry).not.toHaveBeenCalled();
    expect(fake.init).not.toHaveBeenCalled();
    expect(fake.captureRequestError).not.toHaveBeenCalled();
  });

  it("cu DSN se inițializează o singură dată, fără tracing și fără date personale", async () => {
    const { controller, fake } = setup("https://key@example.test/1");
    await controller.sync();
    await controller.sync();
    expect(controller.isActive()).toBe(true);
    expect(fake.init).toHaveBeenCalledTimes(1);
    expect(fake.init.mock.calls[0]?.[0]).toMatchObject({
      dsn: "https://key@example.test/1",
      tracesSampleRate: 0,
      dataCollection: { userInfo: false },
    });
  });

  it("trimite erorile cu tag-ul requestId când e activ", async () => {
    const { controller, fake, scope } = setup("https://key@example.test/1");
    await controller.sync();
    const error = new Error("boom");
    await controller.captureRequestError(error, request, context);
    expect(scope.setTag).toHaveBeenCalledWith("requestId", "req-123");
    expect(fake.captureRequestError).toHaveBeenCalledWith(error, request, context);
  });

  it("se oprește când DSN-ul e șters din setări", async () => {
    let dsn = "https://key@example.test/1";
    const { controller, fake } = setup(async () => dsn);
    await controller.sync();
    dsn = "";
    await controller.sync();
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(controller.isActive()).toBe(false);
  });

  it("rămâne inactiv (nu aruncă) dacă DSN-ul nu poate fi citit", async () => {
    const { controller, loadSentry } = setup(() => Promise.reject(new Error("db picat")));
    await expect(controller.sync()).resolves.toBeUndefined();
    expect(controller.isActive()).toBe(false);
    expect(loadSentry).not.toHaveBeenCalled();
  });
});

describe("tagRequestId", () => {
  it("ia requestId din header-ul cererii atașat evenimentului", () => {
    const event: ErrorEvent = {
      type: undefined,
      request: { headers: { "x-request-id": "req-9" } },
    };
    expect(tagRequestId(event).tags).toEqual({ requestId: "req-9" });
  });

  it("nu pune tag când nu există requestId", () => {
    const event: ErrorEvent = { type: undefined };
    expect(tagRequestId(event).tags).toBeUndefined();
  });
});
