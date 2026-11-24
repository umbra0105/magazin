import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getEntitlementDetail } from "@ecom/core";
import { StoreButton, StoreCard, StorePill } from "@ecom/ui";
import { getDb } from "@ecom/db";
import { DigitalPlayer } from "@/components/storefront/digital/digital-player";
import { getAccountFormat } from "@/lib/account-format";
import { requireCustomer } from "@/lib/account";
import { getMessages } from "@/messages";

const m = getMessages().digital.detail;
const errors = getMessages().digital.errors;

export const metadata: Metadata = {
  title: getMessages().digital.library.metaTitle,
  // adresa conține un jeton de acces: nu se indexează și nu se trimite mai departe
  robots: { index: false, follow: false },
  referrer: "same-origin",
};
export const dynamic = "force-dynamic";

/**
 * Un produs digital al clientului (Faza 14b): modulele lui, playerul și descărcarea cu contorul rămas. Jetonul din adresă e un
 * identificator opac; proprietatea se verifică în aceeași interogare care îl caută (un jeton străin și unul inexistent dau același 404).
 * Descărcarea e un formular POST (nu un link: un browser nu o poate «pre-încărca» și consuma din limită).
 */
export default async function DigitalProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ eroare?: string }>;
}) {
  const { token } = await params;
  const { eroare } = await searchParams;
  const { user } = await requireCustomer(`/cont/produsele-mele/${token}`);
  const [format, detail] = await Promise.all([
    getAccountFormat(),
    getEntitlementDetail(getDb(), user.id, token),
  ]);
  if (!detail) notFound();
  const revoked = detail.status === "revoked";
  const errorText = eroare ? (errors[eroare] ?? errors["failed"]) : null;
  return (
    <div className="flex flex-col gap-8" data-digital-product>
      <header className="flex flex-col gap-2">
        <Link
          href="/cont/produsele-mele"
          className="text-sm font-medium underline underline-offset-4"
        >
          {m.back}
        </Link>
        <h1 className="heading-display text-3xl sm:text-4xl">{detail.productTitle}</h1>
        <p className="flex flex-wrap items-center gap-2 text-ink-secondary">
          {m.order} {detail.orderNumber} · {m.granted} {format.date(detail.grantedAt)}
          <StorePill tone={revoked ? "problem" : "success"}>
            {revoked
              ? getMessages().digital.library.statusRevoked
              : getMessages().digital.library.statusActive}
          </StorePill>
        </p>
        <p className="text-sm text-ink-secondary">
          {detail.maxDownloads === null || detail.remainingDownloads === null
            ? m.downloadsUnlimited
            : m.downloadsLeft(detail.remainingDownloads, detail.maxDownloads)}
        </p>
      </header>

      {errorText ? (
        <p role="alert" className="rounded-card bg-tone-problem-bg p-4 text-tone-problem-fg">
          {errorText}
        </p>
      ) : null}

      {revoked ? (
        <p role="note" className="rounded-card bg-tone-problem-bg p-4 text-tone-problem-fg">
          {m.revokedBanner}
          {detail.revokedReason
            ? ` ${getMessages().digital.library.revokedReason(detail.revokedReason)}`
            : ""}
        </p>
      ) : (
        <section aria-labelledby="digital-modules" className="flex flex-col gap-4">
          <h2 id="digital-modules" className="text-xl font-semibold">
            {m.modulesTitle}
          </h2>
          {detail.assets.length === 0 ? (
            <p className="text-ink-secondary">{m.noModules}</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {detail.assets.map((asset) => (
                <li key={asset.id}>
                  <StoreCard className="flex flex-col gap-3 p-4" data-digital-module>
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="flex min-w-0 flex-col gap-1">
                        <span className="text-lg font-semibold">{asset.title}</span>
                        <span className="text-sm text-ink-secondary">
                          {asset.type === "video"
                            ? m.video
                            : asset.type === "file"
                              ? m.file
                              : m.link}
                          {asset.durationSeconds !== null
                            ? ` · ${m.duration(asset.durationSeconds)}`
                            : ""}
                          {asset.fileSize !== null ? ` · ${m.size(asset.fileSize)}` : ""}
                        </span>
                      </div>
                      {asset.status !== "ready" ? (
                        <StorePill tone="info">
                          {asset.status === "processing" ? m.preparing : m.failedModule}
                        </StorePill>
                      ) : null}
                    </div>
                    {asset.status === "ready" ? (
                      asset.type === "video" ? (
                        <DigitalPlayer
                          mode="client"
                          assetId={asset.id}
                          token={detail.token}
                          texts={{
                            play: m.play,
                            close: m.close,
                            preparing: m.preparing,
                            failed: errors["failed"] ?? "",
                            title: m.playerTitle(asset.title),
                          }}
                        />
                      ) : (
                        <form method="post" action="/api/cont/digital/acces">
                          <input type="hidden" name="token" value={detail.token} />
                          <input type="hidden" name="asset" value={asset.id} />
                          <StoreButton type="submit" variant="primary">
                            {asset.type === "file" ? m.download : m.open}
                          </StoreButton>
                        </form>
                      )
                    ) : null}
                  </StoreCard>
                </li>
              ))}
            </ol>
          )}
          <p className="text-sm text-ink-secondary">{m.linkNote}</p>
        </section>
      )}
    </div>
  );
}
