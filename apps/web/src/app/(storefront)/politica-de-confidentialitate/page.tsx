import type { Metadata } from "next";
import Link from "next/link";
import { Container, StorePill, storeButtonVariants } from "@ecom/ui";
import { getMessages } from "@/messages";

const m = getMessages().storefront.legalDraft;

/** Pagină PROVIZORIE: fără text juridic (cel real vine în Faza 16), marcată «în curs de redactare» și neindexată. */
export const metadata: Metadata = {
  title: m.privacy,
  robots: { index: false, follow: false },
};

export default function LegalDraftPage() {
  return (
    <Container className="flex flex-col items-start gap-4 py-12">
      <StorePill tone="warning">{m.badge}</StorePill>
      <h1 className="heading-display text-3xl sm:text-4xl">{m.privacy}</h1>
      <p className="max-w-prose text-ink-secondary">{m.lede}</p>
      <Link href="/checkout" className={storeButtonVariants({ variant: "secondary" })}>
        {m.back}
      </Link>
    </Container>
  );
}
