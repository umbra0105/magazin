import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ATTENTION_REASON_LABELS,
  DEFAULT_ROLES,
  NOTIFICATION_KINDS,
  type PermissionKey,
} from "@ecom/core";
import { getMessages } from "@/messages";

/**
 * Notificările din clopoțel (Faza 11, C3): fiecare duce la comanda, plata sau oferta în cauză, iar ecranul de destinație își
 * verifică singur permisiunea pe server (`requireAdmin`). Contractul se ține aici: (1) permisiunea cerută de pagina de destinație e
 * cea declarată în tabel (citită din codul paginii, nu presupusă); (2) fiecare rol care vede notificarea (are permisiunea ei) poate
 * și deschide destinația (nicio legătură spre «acces interzis»); (3) nu apare un loc nou care scrie notificări fără să fie trecut aici.
 */
const ROOT = resolve(__dirname, "../../../..");
const ADMIN_PAGES = join(ROOT, "apps/web/src/app/(admin)/admin/comenzi");
const CORE_SRC = join(ROOT, "packages/core/src");

interface Destination {
  /** Fișierul care scrie notificarea (relativ la `packages/core/src`). */
  writer: string;
  /** Permisiunea cu care se scrie notificarea (cine o vede în clopoțel). */
  permission: PermissionKey;
  /** Pagina de destinație (relativ la `comenzi`) și permisiunea ei, verificată din codul paginii. */
  page: string;
  pagePermission: PermissionKey;
}

const DESTINATIONS: readonly Destination[] = [
  {
    writer: "payments/payment-db.ts",
    permission: "payments.read",
    page: "plati/[id]/page.tsx",
    pagePermission: "payments.read",
  },
  {
    writer: "payments/refund-service.ts",
    permission: "payments.refund",
    page: "plati/[id]/page.tsx",
    pagePermission: "payments.read",
  },
  {
    writer: "payments/payment-processor.ts",
    permission: "payments.read",
    page: "plati/[id]/page.tsx",
    pagePermission: "payments.read",
  },
  {
    writer: "email/dispatch.ts",
    permission: "orders.read",
    page: "[id]/page.tsx",
    pagePermission: "orders.read",
  },
  {
    writer: "email/dispatch.ts",
    permission: "email.read",
    page: "sabloane-email/page.tsx",
    pagePermission: "email.read",
  },
  {
    writer: "offers/offer-email.ts",
    permission: "orders.offers",
    page: "oferte/[id]/page.tsx",
    pagePermission: "orders.offers",
  },
  {
    writer: "offers/offer-service.ts",
    permission: "orders.offers",
    page: "oferte/[id]/page.tsx",
    pagePermission: "orders.offers",
  },
  {
    // factura care nu s-a putut emite: duce la comandă (jurnalul facturii e în detaliul ei)
    writer: "invoicing/invoice-service.ts",
    permission: "invoices.read",
    page: "[id]/page.tsx",
    pagePermission: "orders.read",
  },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

describe("notificările din clopoțel: destinația", () => {
  it("pagina de destinație cere exact permisiunea din tabel (citită din codul paginii)", () => {
    for (const d of DESTINATIONS) {
      const source = readFileSync(join(ADMIN_PAGES, d.page), "utf8");
      const match = /requireAdmin\(\{[^}]*permission:\s*"([a-z_.]+)"/.exec(source);
      expect(match?.[1], d.page).toBe(d.pagePermission);
    }
  });

  it("fiecare rol care vede notificarea poate deschide și destinația ei", () => {
    for (const d of DESTINATIONS) {
      for (const role of DEFAULT_ROLES) {
        if (!role.permissions.includes(d.permission)) continue;
        expect(
          role.permissions.includes(d.pagePermission),
          `${role.key}: ${d.permission} → ${d.page} (${d.pagePermission})`,
        ).toBe(true);
      }
    }
  });

  it("fiecare loc din core care scrie notificări e în tabel (o legătură nouă cere decizie despre permisiune)", () => {
    const writers = sourceFiles(CORE_SRC)
      .filter((file) => !file.endsWith("admin-notifications.ts"))
      .filter((file) => /\bnotifyAdmins\(/.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(CORE_SRC.length + 1).replaceAll("\\", "/"))
      .sort();
    expect(writers).toEqual([...new Set(DESTINATIONS.map((d) => d.writer))].sort());
  });

  it("toate tipurile de notificare sunt cunoscute (plată, rambursare, notificare blocată, email, ofertă, factură)", () => {
    expect([...NOTIFICATION_KINDS].sort()).toEqual(
      [
        "email_failed",
        "invoice_failed",
        "offer_stale",
        "payment_attention",
        "refund_manual",
        "stock_sync_stale",
        "webhook_stuck",
      ].sort(),
    );
  });
});

describe("etichetele motivelor «necesită atenție»", () => {
  it("sunt aceleași în clopoțel și în ecranul plăților (nu se rup unele de altele)", () => {
    const screen = getMessages().admin.orders.detail.payment.attention;
    expect(ATTENTION_REASON_LABELS).toEqual(screen);
  });
});
