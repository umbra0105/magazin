import { StorefrontLoading } from "@ecom/ui";
import { getMessages } from "@/messages";

/** Scheletul vitrinei cât se încarcă o pagină (Faza 7 pune schelete proprii pe listă și pe produs). */
export default function StorefrontLoadingPage() {
  return <StorefrontLoading label={getMessages().storefront.states.loading} />;
}
