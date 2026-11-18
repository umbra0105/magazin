import type { Metadata } from "next";
import { Container } from "@ecom/ui";
import { TrackForm } from "@/components/storefront/order/track-form";
import { getSettings } from "@/lib/services";
import { getStorefrontFormat } from "@/lib/storefront-catalog";
import { getMessages } from "@/messages";

const m = getMessages().storefront.order;

export const metadata: Metadata = {
  title: m.trackTitle,
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** `/comanda/urmarire`: număr + email, fără cont. Nu se indexează (și `robots.txt` interzice `/comanda`). */
export default async function TrackOrderPage() {
  const [format, regional] = await Promise.all([
    getStorefrontFormat(),
    getSettings().getGroup("regional"),
  ]);
  return (
    <Container className="flex flex-col gap-6 py-8 sm:py-12">
      <h1 className="heading-display text-3xl sm:text-4xl">{m.trackTitle}</h1>
      <p className="max-w-prose text-ink-secondary">{m.trackLede}</p>
      <TrackForm format={format} timeZone={regional.timezone} />
    </Container>
  );
}
