import type { Metadata } from "next";
import Link from "next/link";
import { IMPORT_FIELDS } from "@ecom/core";
import { ProductImportWizard } from "@/components/admin/products/product-import-wizard";
import { requireAdmin } from "@/lib/admin-page";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const m = getMessages().admin.productImport;

export const metadata: Metadata = { title: m.title };

/**
 * Importul de produse (CSV/XLSX). Cere `products.write`: importul atinge prețuri, stare și structură,
 * deci nu e deschis rolurilor care pot edita doar conținut. Încărcarea fișierului are ruta ei API;
 * restul pașilor sunt server actions cu aceeași permisiune.
 */
export default async function ProductImportPage() {
  await requireAdmin({ permission: "products.write" });
  const settings = await getSettings().getGroup("import");
  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <Link
          href="/admin/produse"
          className="text-sm text-primary underline-offset-2 hover:underline"
        >
          {m.back}
        </Link>
        <h1 className="text-2xl font-semibold">{m.title}</h1>
        <p className="text-sm text-muted-foreground">{m.description}</p>
      </header>
      <ProductImportWizard
        fields={IMPORT_FIELDS.map((f) => ({ key: f.key, label: f.label }))}
        maxUploadMb={Math.max(1, Math.floor(settings.maxUploadBytes / (1024 * 1024)))}
      />
    </div>
  );
}
