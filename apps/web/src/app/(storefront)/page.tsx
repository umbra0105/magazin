import { Container } from "@ecom/ui";
import { getStorefrontChrome } from "@/lib/storefront-chrome";

// Pagina principală provizorie până la Faza 7 (șabloanele de acasă, categorie, produs): un singur h1 cu numele magazinului și
// fraza lui din setări. Header-ul și footer-ul vin din layout. Dinamică, pentru că depinde de setări.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { storeName, tagline } = await getStorefrontChrome();
  return (
    <Container className="py-section">
      <h1 className="heading-display text-hero text-balance">{storeName}</h1>
      {tagline ? <p className="mt-6 max-w-2xl text-lede text-ink-secondary">{tagline}</p> : null}
    </Container>
  );
}
