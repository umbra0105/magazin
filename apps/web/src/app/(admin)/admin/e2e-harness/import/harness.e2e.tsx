"use client";

import { useState } from "react";
import type { ImageProgressView, WooAnalysis, WooOptions, WooReportSection } from "@ecom/core";
import {
  ImageFailures,
  ImageProgress,
  RetryImagesButton,
} from "@/components/admin/products/product-import-images";
import { WooOptionsPanel, WooReportExtras } from "@/components/admin/products/product-import-woo";

/**
 * Părțile importului WooCommerce și ale imaginilor, cu date FIXE, ca testele de design să le poată verifica fără un fișier real
 * și fără rețea: opțiunile (mod, stare, imagini, unități, clase de livrare, atribute), raportul și progresul imaginilor.
 */

const OPTIONS: WooOptions = {
  keepStatus: false,
  weightUnit: "kg",
  dimensionUnit: "cm",
  shippingClassMap: { "clasa mare": "oversized" },
  attributeTargets: {},
  importImages: true,
  mode: "full",
  overwriteEditedDescriptions: false,
};

function analysis(stare: string): WooAnalysis {
  return {
    rowTypes: { simple: 9, variable: 1, variation: 3 },
    units: { weight: "kg", dimensions: "cm" },
    defaults: OPTIONS,
    shippingClasses: [
      { name: "Clasa mare", key: "clasa mare", count: 4, suggested: "oversized" },
      {
        name: "Pompă de căldură inverter cu agent frigorific ecologic pentru piscine rezidențiale",
        key: "clasa lunga",
        count: 1,
        suggested: null,
      },
    ],
    attributes: [
      { name: "Material", key: "material", count: 6, existingId: null },
      { name: "Putere (kW)", key: "putere", count: 3, existingId: "a1" },
    ],
    existingAttributes: [{ id: "a1", name: "Putere" }],
    images: {
      hasColumn: true,
      total: 20,
      invalid: 1,
      onAllowedHosts: 15,
      onOtherHosts: 4,
      hosts: [
        { host: "cdn.exemplu.ro", count: 15, allowed: true },
        { host: "imagini.alt-domeniu-foarte-lung-pentru-test.example", count: 4, allowed: false },
      ],
      allowedHosts: stare === "fara-domenii" ? [] : ["cdn.exemplu.ro"],
      canImport: stare !== "fara-drept",
    },
    ignoredColumns: [
      { header: "Meta: _yoast_wpseo_title", reason: "Câmp de plugin, nu se importă." },
      { header: "Mărime pachet", reason: "Nu are corespondent în aplicație." },
    ],
    blockedColumns: ["Preț de achiziție", "Furnizor"],
  };
}

const REPORT: WooReportSection = {
  images: {
    enabled: true,
    stats: {
      total: 20,
      accepted: 14,
      rejected: 6,
      alreadyInLibrary: 2,
      alreadyAttached: 1,
      ignoredOnVariations: 3,
      byHost: { "cdn.exemplu.ro": 14, "imagini.alt-domeniu-foarte-lung-pentru-test.example": 5 },
      rejectedByReason: { host_not_allowed: 5, scheme: 1 },
    },
    issues: [
      { row: 4, sku: "SKU-0004", host: "imagini.alt-domeniu.example", message: "Domeniu nepermis" },
      { row: 9, sku: "SKU-0009", host: null, message: "Nu e https" },
    ],
    issuesTruncated: true,
  },
  categoriesToCreate: ["Pompe", "Filtre"],
  brandsToCreate: ["Hayward"],
  attributesToCreate: ["Material"],
  stats: {
    categoriesToCreate: 2,
    brandsToCreate: 1,
    attributesToCreate: 1,
    unknownShippingClasses: 1,
    descriptionsSanitized: 4,
    descriptionTables: 0,
    descriptionLinks: 2,
    descriptionImages: 0,
    descriptionShortcodes: 1,
    variations: 3,
    unresolvedRelations: 0,
    skuFallbacks: 1,
    legacyNotSaved: 0,
    productsNotFound: 0,
    descriptionsKeptEdited: 0,
    descriptionsKeptNoHistory: 0,
    descriptionsOverLimit: 0,
  },
  rowTypes: { simple: 9, variable: 1, variation: 3 },
  ignoredColumns: [],
  blockedColumns: [],
};

const PROGRESS = {
  running: { total: 20, pending: 8, downloaded: 9, existing: 2, failed: 1, state: "running" },
  interrupted: {
    total: 20,
    pending: 8,
    downloaded: 9,
    existing: 2,
    failed: 1,
    state: "interrupted",
  },
  done: { total: 20, pending: 0, downloaded: 15, existing: 2, failed: 3, state: "done" },
} satisfies Record<string, ImageProgressView>;

const FAILURES = [
  { row: 4, sku: "SKU-0004", host: "cdn.exemplu.ro", message: "Fișierul nu a putut fi descărcat." },
  {
    row: 17,
    sku: "SKU-LUNG-COD-DE-PRODUS-FOARTE-LUNG-0017",
    host: "imagini.alt-domeniu-foarte-lung-pentru-test.example",
    message: "Răspunsul nu e o imagine acceptată.",
  },
];

export function ImportHarness({ ecran, stare }: { ecran: string; stare: string }) {
  const [options, setOptions] = useState<WooOptions | null>(
    stare === "descrieri" ? { ...OPTIONS, mode: "descriptionsOnly" } : OPTIONS,
  );
  if (ecran === "raport") return <WooReportExtras woo={REPORT} />;
  if (ecran === "imagini") {
    const progress =
      PROGRESS[stare === "oprit" ? "interrupted" : stare === "gata" ? "done" : "running"];
    return (
      <div className="flex max-w-5xl flex-col gap-6">
        <ImageProgress progress={progress} />
        {progress.state !== "running" && <RetryImagesButton importId="harness" />}
        <ImageFailures failures={FAILURES} />
      </div>
    );
  }
  if (!options) return null;
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <WooOptionsPanel analysis={analysis(stare)} options={options} onChange={setOptions} />
    </div>
  );
}
