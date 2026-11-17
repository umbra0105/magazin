import { StorefrontLoading } from "@ecom/ui";
import { getMessages } from "@/messages";

/**
 * Scheletul harness-ului de încărcare. Vitrina NU are `loading.tsx` la nivel de grup: un schelet la rădăcină face ca `notFound()` și
 * redirecționările paginilor de catalog să răspundă cu 200 (antetul pleacă înainte de decizie), iar 404 real și 301/308 sunt cerințe SEO
 * (docs/19 §1). Un schelet propriu se pune doar pe un segment care nu face `notFound()`/redirect; harness-ul îl dovedește.
 */
export default function StorefrontLoadingHarnessSkeleton() {
  return <StorefrontLoading label={getMessages().storefront.states.loading} />;
}
