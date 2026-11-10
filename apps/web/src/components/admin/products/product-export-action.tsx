"use client";

import { ProductExportDialog, type ProductExportProps } from "./product-export-dialog";
import { useProductSelection } from "./product-selection";

/**
 * «Exportă…» din bara de unelte a listei: dialogul de export, cu selecția din tabel (dacă există) ca domeniu implicit.
 * Se desenează doar cu `products.export` (pagina decide).
 */
export function ProductExportAction(props: Omit<ProductExportProps, "selectedIds">) {
  const { selected } = useProductSelection();
  return <ProductExportDialog {...props} selectedIds={[...selected]} />;
}
