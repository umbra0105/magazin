import type { Metadata } from "next";
import { can } from "@ecom/core";
import { getDb } from "@ecom/db";
import { OfferWizard, type WizardInitial } from "@/components/admin/offers/offer-wizard";
import { PageHeader } from "@/components/admin/page-header";
import { requireAdmin } from "@/lib/admin-page";
import { getGeoService } from "@/lib/checkout";
import { getOfferService } from "@/lib/offers";
import { getSettings } from "@/lib/services";
import { getMessages } from "@/messages";

const o = getMessages().admin.orders.offers;

export const metadata: Metadata = { title: o.wizard.title };
export const dynamic = "force-dynamic";

const EMPTY: WizardInitial = {
  lines: [],
  email: "",
  phone: "",
  fullName: "",
  countyCode: null,
  localityCode: null,
  street: "",
  postalCode: "",
  companyName: "",
  vatId: "",
  shippingOfferCode: "",
  fromOrder: false,
};

/**
 * Ofertă nouă (decizia A). Cere `orders.offers`. Cu `?dinComanda=<id>` (butonul «Duplică» din detaliul comenzii) schița se
 * preia din liniile și adresa comenzii, dar prețurile se calculează abia în ultimul pas, la valorile de acum.
 */
export default async function NewOfferPage({
  searchParams,
}: {
  searchParams: Promise<{ dinComanda?: string }>;
}) {
  const subject = await requireAdmin({ permission: "orders.offers" });
  const { dinComanda } = await searchParams;
  const regional = await getSettings().getGroup("regional");
  const geo = getGeoService();
  let initial = EMPTY;
  let initialLocalities: Awaited<ReturnType<typeof geo.localities>> = [];
  let problem: string | null = null;

  if (dinComanda && can(subject, "orders.read")) {
    try {
      const draft = await getOfferService().draftFromOrder(dinComanda);
      const variants = await getDb().productVariant.findMany({
        where: { id: { in: draft.lines.map((line) => line.variantId) } },
        select: { id: true, sku: true, product: { select: { title: true } } },
      });
      const byId = new Map(variants.map((variant) => [variant.id, variant]));
      initial = {
        lines: draft.lines.map((line) => ({
          variantId: line.variantId,
          sku: byId.get(line.variantId)?.sku ?? "",
          title: byId.get(line.variantId)?.product.title ?? "",
          quantity: line.quantity,
        })),
        email: draft.email,
        phone: draft.phone,
        fullName: draft.shipping.fullName,
        countyCode: draft.shipping.countyCode,
        localityCode: draft.shipping.localityCode,
        street: draft.shipping.street,
        postalCode: draft.shipping.postalCode,
        companyName: draft.company?.name ?? "",
        vatId: draft.company?.vatId ?? "",
        shippingOfferCode: draft.shippingOfferCode,
        fromOrder: true,
      };
      initialLocalities = await geo.localities(draft.shipping.countyCode);
    } catch {
      problem = o.wizard.errors["notFound"] ?? null;
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={o.wizard.title} description={o.description} />
      {problem && (
        <p
          role="alert"
          className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
        >
          {problem}
        </p>
      )}
      <OfferWizard
        counties={await geo.counties()}
        initialLocalities={initialLocalities}
        initial={initial}
        currency={regional.currency}
        locale={regional.locale}
      />
    </div>
  );
}
