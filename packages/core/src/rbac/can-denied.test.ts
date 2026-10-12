import { describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthenticatedError, getRequestContext } from "@ecom/shared";
import { createWithPermission, type DeniedAttempt, type PermissionSubject } from "./can";

const owner: PermissionSubject = {
  userId: "o",
  email: "o@test.invalid",
  roles: ["owner"],
  permissions: new Set(),
};
const support: PermissionSubject = {
  userId: "s",
  email: "s@test.invalid",
  roles: ["support"],
  permissions: new Set(["admin.access", "orders.read"]),
};

describe("withPermission: încercări refuzate și context de cerere", () => {
  it("refuz: onDenied primește subiectul, permisiunea, motivul și metadatele; handlerul nu rulează", async () => {
    const onDenied = vi.fn<(a: DeniedAttempt) => void>();
    const handler = vi.fn(async () => "ok");
    const withPermission = createWithPermission({ getSubject: async () => support, onDenied });
    const action = withPermission("products.archive", handler, {
      action: "product.archive",
      entity: "product",
    });

    await expect(action(undefined)).rejects.toBeInstanceOf(ForbiddenError);
    expect(handler).not.toHaveBeenCalled();
    expect(onDenied).toHaveBeenCalledTimes(1);
    expect(onDenied).toHaveBeenCalledWith({
      subject: support,
      permission: "products.archive",
      reason: "forbidden",
      action: "product.archive",
      entity: "product",
    });
  });

  it("fără sesiune: motivul e „unauthenticated”, subiectul null", async () => {
    const onDenied = vi.fn<(a: DeniedAttempt) => void>();
    const action = createWithPermission({ getSubject: async () => null, onDenied })(
      "orders.read",
      async () => "ok",
    );
    await expect(action(undefined)).rejects.toBeInstanceOf(UnauthenticatedError);
    expect(onDenied.mock.calls[0]?.[0]).toMatchObject({ subject: null, reason: "unauthenticated" });
  });

  it("acordat: onDenied nu se apelează, iar handlerul rulează în contextul requestId", async () => {
    const onDenied = vi.fn();
    let seen: string | undefined;
    const action = createWithPermission({
      getSubject: async () => owner,
      onDenied,
      getRequestId: async () => "req-contexte-123",
    })("settings.write", async () => {
      seen = getRequestContext()?.requestId;
      return "ok";
    });
    await expect(action(undefined)).resolves.toBe("ok");
    expect(seen).toBe("req-contexte-123");
    expect(onDenied).not.toHaveBeenCalled();
  });

  it("fără requestId disponibil, handlerul rulează normal", async () => {
    const action = createWithPermission({
      getSubject: async () => owner,
      getRequestId: async () => null,
    })("settings.write", async () => getRequestContext()?.requestId ?? "fără");
    await expect(action(undefined)).resolves.toBe("fără");
  });

  it("onDenied care aruncă (sincron sau asincron) nu schimbă refuzul", async () => {
    for (const onDenied of [
      () => {
        throw new Error("sync");
      },
      async () => {
        throw new Error("async");
      },
    ]) {
      const action = createWithPermission({ getSubject: async () => support, onDenied })(
        "settings.write",
        async () => "ok",
      );
      await expect(action(undefined)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});
