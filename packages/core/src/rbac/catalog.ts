/**
 * Catalogul permisiunilor (string-uri) și rolurile implicite din `docs/04-backend-admin.md` §6.
 * Seed-ul le scrie în DB; verificarea pe server (`can()` / `withPermission()`) vine în Promptul 3.
 * Un magazin poate adăuga roluri proprii din admin; rolurile de sistem de mai jos nu se șterg.
 */
export const PERMISSIONS = {
  "orders.read": "Vede comenzile",
  "orders.write": "Modifică comenzile",
  "orders.cancel": "Anulează comenzi",
  "orders.refund": "Rambursează comenzi",
  "orders.fulfill": "Pregătește și expediază comenzi (fulfillment, AWB)",
  "products.read": "Vede produsele",
  "products.write": "Creează și modifică produse",
  "products.archive": "Arhivează și șterge produse",
  "products.cost.view": "Vede prețul de achiziție (NIR) al produselor",
  "products.cost.edit": "Modifică prețul de achiziție (NIR) al produselor",
  "inventory.read": "Vede stocul",
  "inventory.write": "Modifică stocul",
  "customers.read": "Vede clienții",
  "customers.read_pii": "Vede datele personale ale clienților",
  "customers.write": "Modifică clienții",
  "customers.groups.manage": "Gestionează grupurile de clienți",
  "discounts.read": "Vede reducerile și cupoanele",
  "discounts.write": "Creează și modifică reduceri și cupoane",
  "content.read": "Vede conținutul (CMS, blog, SEO)",
  "content.write": "Editează conținutul (CMS, blog, SEO)",
  "media.write": "Încarcă și șterge fișiere media",
  "invoices.read": "Vede facturile",
  "invoices.write": "Emite și stornează facturi",
  "reports.read": "Vede rapoartele operaționale",
  "reports.financial": "Vede rapoartele financiare",
  "settings.read": "Vede setările",
  "settings.write": "Modifică setările",
  "integrations.write": "Modifică integrările și cheile lor",
  "users.manage": "Gestionează utilizatorii și rolurile",
  "audit.read": "Vede jurnalul de audit",
  "system.update": "Actualizează sistemul și rulează mentenanță",
} as const;

export type PermissionKey = keyof typeof PERMISSIONS;
export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as PermissionKey[];

export interface RoleDefinition {
  key: string;
  name: string;
  description: string;
  permissions: readonly PermissionKey[];
}

const ALL = PERMISSION_KEYS;

export const DEFAULT_ROLES: readonly RoleDefinition[] = [
  {
    key: "owner",
    name: "Owner",
    description: "Tot, inclusiv setări de sistem, actualizări și integrări",
    permissions: ALL,
  },
  {
    key: "admin",
    name: "Admin",
    description: "Tot, mai puțin actualizări de sistem și chei de integrare",
    permissions: ALL.filter((p) => p !== "system.update" && p !== "integrations.write"),
  },
  {
    key: "manager",
    name: "Manager",
    description: "Comenzi, produse, clienți, reduceri, rapoarte (fără prețul de achiziție)",
    permissions: [
      "orders.read",
      "orders.write",
      "orders.cancel",
      "orders.refund",
      "orders.fulfill",
      "products.read",
      "products.write",
      "products.archive",
      "inventory.read",
      "inventory.write",
      "customers.read",
      "customers.read_pii",
      "customers.write",
      "discounts.read",
      "discounts.write",
      "reports.read",
    ],
  },
  {
    key: "editor",
    name: "Editor conținut",
    description: "CMS, blog, SEO, media",
    permissions: ["content.read", "content.write", "media.write", "products.read"],
  },
  {
    key: "support",
    name: "Suport clienți",
    description: "Vede comenzi și clienți, poate anula și rambursa",
    permissions: [
      "orders.read",
      "orders.cancel",
      "orders.refund",
      "customers.read",
      "customers.read_pii",
    ],
  },
  {
    key: "warehouse",
    name: "Depozit",
    description: "Comenzi (doar fulfillment), stoc, AWB — fără prețuri și date financiare",
    permissions: [
      "orders.read",
      "orders.fulfill",
      "inventory.read",
      "inventory.write",
      "products.read",
    ],
  },
  {
    key: "accountant",
    name: "Contabil",
    description: "Rapoarte, facturi, export — doar citire",
    permissions: [
      "reports.read",
      "reports.financial",
      "invoices.read",
      "orders.read",
      "products.cost.view",
    ],
  },
];
