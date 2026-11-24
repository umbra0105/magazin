import type { StorefrontDigitalDto } from "@ecom/core";
import { StorePill } from "@ecom/ui";
import { getMessages } from "@/messages";
import { DigitalPlayer } from "./digital-player";

const m = getMessages().digital.product;
const d = getMessages().digital.detail;
const errors = getMessages().digital.errors;

/**
 * Secțiunea «Conținut digital» de pe pagina unui produs digital (Faza 14b): ce primești, cerințe, format, modulele cu durată și
 * lecția de preview gratuită (playerul cere un link scurt serverului, fără cont). Fără mențiuni de livrare sau transport: produsul
 * se primește în cont. Textele vin din datele produsului (introduse de admin), nu din cod.
 */
export function DigitalProductSection({ digital }: { digital: StorefrontDigitalDto }) {
  return (
    <div className="flex max-w-3xl flex-col gap-6" data-digital-section>
      <div className="flex flex-wrap items-center gap-2">
        <StorePill tone="success">{m.badgeInstant}</StorePill>
        <StorePill tone="info">{m.badgeLifetime}</StorePill>
      </div>
      {digital.whatYouGet ? (
        <section className="flex flex-col gap-1">
          <h3 className="font-semibold">{m.whatYouGet}</h3>
          <p className="whitespace-pre-line">{digital.whatYouGet}</p>
        </section>
      ) : null}
      {digital.requirements ? (
        <section className="flex flex-col gap-1">
          <h3 className="font-semibold">{m.requirements}</h3>
          <p className="whitespace-pre-line">{digital.requirements}</p>
        </section>
      ) : null}
      {digital.format ? (
        <section className="flex flex-col gap-1">
          <h3 className="font-semibold">{m.format}</h3>
          <p>{digital.format}</p>
        </section>
      ) : null}
      {digital.assets.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h3 className="font-semibold">{m.modules}</h3>
          <ol className="flex flex-col gap-3">
            {digital.assets.map((asset) => (
              <li key={asset.id} className="flex flex-col gap-2" data-digital-module>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{asset.title}</span>
                  <span className="text-sm text-ink-secondary">
                    {asset.type === "video" ? d.video : asset.type === "file" ? d.file : d.link}
                    {asset.durationSeconds !== null
                      ? ` · ${d.duration(asset.durationSeconds)}`
                      : ""}
                    {asset.fileSize !== null ? ` · ${d.size(asset.fileSize)}` : ""}
                  </span>
                  {asset.isPreview ? <StorePill tone="info">{m.previewBadge}</StorePill> : null}
                </div>
                {asset.isPreview ? (
                  <DigitalPlayer
                    mode="preview"
                    assetId={asset.id}
                    assetType={asset.type === "file" ? "file" : "video"}
                    texts={{
                      play: m.previewButton,
                      close: m.previewClose,
                      preparing: d.preparing,
                      failed: errors["failed"] ?? m.previewFailed,
                      title: d.playerTitle(asset.title),
                    }}
                  />
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {digital.maxDownloads !== null ? (
        <p className="text-sm text-ink-secondary">{m.downloads(digital.maxDownloads)}</p>
      ) : null}
      <p className="text-sm text-ink-secondary">{m.accountNote}</p>
      <p className="text-sm text-ink-secondary">{m.codNote}</p>
    </div>
  );
}
