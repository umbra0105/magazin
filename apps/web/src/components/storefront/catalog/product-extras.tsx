import Link from "next/link";
import type { PageDiagram, PageDocument, ListedProduct } from "@ecom/core";
import { StoreImage } from "@ecom/ui";
import { formatPrice, type StorefrontFormat } from "@/lib/storefront-catalog";
import { productHref } from "@/lib/storefront-urls";
import { getMessages } from "@/messages";

const m = getMessages().storefront.catalog.product;

function typeLabelOf(type: string): string {
  return m.downloads.types[type] ?? m.downloads.types["other"] ?? "";
}

/** Tipul documentului și limba, ca text; tipul se omite când repetă titlul (ex. «Eticheta energetică»). */
function subtitleOf(doc: PageDocument): string {
  const type = typeLabelOf(doc.type);
  const parts = [
    type.toLowerCase() === doc.title.trim().toLowerCase() ? "" : type,
    doc.language !== "ro" ? m.downloads.language(doc.language) : "",
  ].filter((part) => part !== "");
  return parts.join(", ");
}

function sizeText(bytes: number, locale: string): string {
  const fmt = (n: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n);
  return bytes >= 1024 * 1024
    ? m.downloads.sizeMb(fmt(bytes / (1024 * 1024)))
    : m.downloads.sizeKb(fmt(Math.max(bytes / 1024, 0.1)));
}

/**
 * Tabul «Descărcări»: documentele produsului (etichetă energetică, fișă tehnică, manual…). Fiecare legătură duce la `/descarca/<id>`,
 * care redirecționează la un link semnat cu expirare scurtă; adresa fișierului nu stă în pagină.
 */
export function DownloadsList({
  documents,
  locale,
}: {
  documents: readonly PageDocument[];
  locale: string;
}) {
  if (documents.length === 0) return <p className="text-ink-secondary">{m.downloads.empty}</p>;
  return (
    <ul className="flex max-w-3xl flex-col divide-y divide-line-subtle">
      {documents.map((doc) => (
        <li
          key={doc.id}
          className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3"
        >
          <div className="min-w-0">
            <p className="font-medium">{doc.title}</p>
            {subtitleOf(doc) ? (
              <p className="text-sm text-ink-secondary">{subtitleOf(doc)}</p>
            ) : null}
          </div>
          <span className="ml-auto text-sm text-ink-secondary">
            {sizeText(doc.sizeBytes, locale)}
          </span>
          <a
            href={`/descarca/${doc.id}`}
            rel="nofollow"
            className="inline-flex h-11 items-center rounded-full border border-line-control px-5 text-sm font-semibold transition-colors duration-(--motion) hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            {m.downloads.download}
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * Tabul «Piese de schimb»: fișa explodată (imaginea cu punctele numerotate, ca legături către rândurile tabelului) și tabelul numerotat
 * cu piesele. Până la coș (Faza 8) rândul are legătură către piesă, nu «Adaugă în coș». Fără fișă, piesele (relația `spare_part`)
 * apar numerotate 1…n în același tabel.
 */
export function PartsTab({
  diagram,
  spareParts,
  format,
}: {
  diagram: PageDiagram | null;
  spareParts: readonly ListedProduct[];
  format: Pick<StorefrontFormat, "currency" | "locale">;
}) {
  const rows = diagram
    ? diagram.parts.map((part) => ({
        number: part.number,
        title: part.product?.title ?? part.label ?? m.spareParts.noProduct,
        slug: part.product?.slug ?? null,
        price: part.product?.price ?? null,
      }))
    : spareParts.map((product, index) => ({
        number: index + 1,
        title: product.title,
        slug: product.slug,
        price: product.price,
      }));
  return (
    <div className="flex flex-col gap-8">
      {diagram?.image ? (
        <figure className="relative w-full max-w-4xl">
          <div className="relative isolate overflow-hidden rounded-card bg-media p-3 [&_img]:mix-blend-multiply">
            <StoreImage
              src={diagram.image.src}
              alt={m.spareParts.diagramAlt(diagram.title)}
              width={diagram.image.width}
              height={diagram.image.height}
              className="h-auto w-full"
            />
            {diagram.parts
              .filter((part) => part.xBp !== null && part.yBp !== null)
              .map((part) => (
                <a
                  key={part.number}
                  href={`#piesa-${part.number}`}
                  aria-label={m.spareParts.pointLabel(part.number)}
                  className="absolute flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-action text-sm font-semibold text-action-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  style={{
                    left: `${(part.xBp as number) / 100}%`,
                    top: `${(part.yBp as number) / 100}%`,
                  }}
                >
                  {part.number}
                </a>
              ))}
          </div>
          <figcaption className="mt-2 text-sm text-ink-secondary">{diagram.title}</figcaption>
        </figure>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full max-w-4xl border-collapse text-left">
          <caption className="sr-only">{m.spareParts.caption}</caption>
          <thead>
            <tr className="border-b border-line-subtle text-sm text-ink-secondary">
              <th scope="col" className="w-16 py-2 pr-4 font-medium">
                {m.spareParts.number}
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                {m.spareParts.part}
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                {m.spareParts.price}
              </th>
              <th scope="col" className="py-2 font-medium">
                <span className="sr-only">{m.spareParts.view}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.number}
                id={`piesa-${row.number}`}
                className="border-b border-line-subtle"
              >
                <th scope="row" className="py-3 pr-4 align-top">
                  <span className="flex size-8 items-center justify-center rounded-full bg-action text-sm font-semibold text-action-fg">
                    {row.number}
                  </span>
                </th>
                <td className="py-3 pr-4 align-top">{row.title}</td>
                <td className="whitespace-nowrap py-3 pr-4 align-top">
                  {row.price ? formatPrice(row.price.amount, format) : ""}
                </td>
                <td className="py-3 align-top">
                  {row.slug ? (
                    <Link
                      href={productHref(row.slug)}
                      className="text-sm underline underline-offset-2 hover:no-underline"
                    >
                      {m.spareParts.view}
                    </Link>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
