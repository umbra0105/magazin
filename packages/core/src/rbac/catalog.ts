/**
 * Catalogul permisiunilor (string-uri) și rolurile implicite din `docs/04-backend-admin.md` §6.
 * Seed-ul le scrie în DB; verificarea pe server (`can()` / `withPermission()`) vine în Promptul 3.
 * Un magazin poate adăuga roluri proprii din admin; rolurile de sistem de mai jos nu se șterg.
 */
export const PERMISSIONS = {
  "admin.access": "Intră în zona de administrare (/admin)",
  "orders.read": "Vede comenzile",
  "orders.write": "Modifică comenzile",
  "orders.cancel": "Anulează comenzi",
  "orders.refund": "Rambursează comenzi",
  "orders.fulfill": "Pregătește și expediază comenzi (fulfillment, AWB)",
  "products.read": "Vede produsele",
  "products.write": "Creează și modifică produse (prețuri, stoc, variante, clasă de livrare, TVA)",
  "products.content.write":
    "Editează conținutul produselor (descriere, SEO, media, documente), fără prețuri, stoc sau cost",
  "products.archive":
    "Rezervată, neaplicată: arhivarea, ștergerea, restaurarea și ștergerea definitivă a produselor cer products.write",
  "products.export": "Exportă produsele în CSV sau XLSX (fără prețul de achiziție, pentru nimeni)",
  "products.cost.view": "Vede prețul de achiziție (NIR) al produselor",
  "products.cost.edit": "Modifică prețul de achiziție (NIR) al produselor",
  "catalog.legacy.edit":
    "Editează identificatorii și adresele din magazinul vechi (legacyId, legacyUrl) ale produselor, categoriilor și brandurilor",
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
  "media.read": "Vede biblioteca media și poate alege fișiere în formulare",
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
    description: "Comenzi, produse (inclusiv prețul de achiziție), clienți, reduceri, rapoarte",
    permissions: [
      "admin.access",
      "orders.read",
      "orders.write",
      "orders.cancel",
      "orders.refund",
      "orders.fulfill",
      "products.read",
      "products.write",
      "products.content.write",
      "products.archive",
      "products.export",
      "products.cost.view",
      "media.read",
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
    description: "CMS, blog, SEO, media și conținutul produselor (fără prețuri, stoc sau cost)",
    permissions: [
      "admin.access",
      "content.read",
      "content.write",
      "media.read",
      "media.write",
      "products.read",
      "products.content.write",
    ],
  },
  {
    key: "support",
    name: "Suport clienți",
    description:
      "Vede comenzi și clienți, poate anula comenzi (rambursarea: până există limita de rambursare)",
    permissions: [
      "admin.access",
      "orders.read",
      "orders.cancel",
      "customers.read",
      "customers.read_pii",
    ],
  },
  {
    key: "warehouse",
    name: "Depozit",
    description: "Comenzi (doar fulfillment), stoc, AWB — fără prețuri și date financiare",
    permissions: [
      "admin.access",
      "orders.read",
      "orders.fulfill",
      "inventory.read",
      "inventory.write",
      "media.read",
      "products.read",
    ],
  },
  {
    key: "accountant",
    name: "Contabil",
    description: "Rapoarte, facturi, export — doar citire",
    permissions: [
      "admin.access",
      "reports.read",
      "reports.financial",
      "invoices.read",
      "orders.read",
      "products.cost.view",
    ],
  },
];
