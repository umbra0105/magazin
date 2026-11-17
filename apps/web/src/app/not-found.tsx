import Link from "next/link";
import { StorefrontState, storeButtonVariants } from "@ecom/ui";
import { StorefrontShell } from "@/components/storefront/storefront-shell";
import { getStorefrontChrome } from "@/lib/storefront-chrome";
import { getMessages } from "@/messages";

const m = getMessages().storefront.states.notFound;

/**
 * Pagina 404 a vitrinei: răspunsul are statusul 404 (cerință SEO, docs/19 §1) și rămâne în cadrul magazinului (header, footer,
 * meniu), cu o singură acțiune principală și categoriile ca plasă de siguranță. Fără baza de date sau Redis, cadrul își folosește
 * valorile implicite (la fel ca tema), deci pagina se afișează oricum. Adminul are propriul 404 (`(admin)/admin/not-found.tsx`).
 */
export default async function NotFound() {
  const chrome = await getStorefrontChrome();
  return (
    <StorefrontShell chrome={chrome} year={new Date().getFullYear()}>
      <StorefrontState
        title={m.title}
        description={m.description}
        actions={
          <Link href="/" className={storeButtonVariants({ size: "lg" })}>
            {m.home}
          </Link>
        }
      >
        {chrome.menu.length > 0 ? (
          <nav aria-label={m.categories} className="flex flex-col items-center gap-3">
            <p className="text-ink-secondary">{m.categories}</p>
            <ul className="flex flex-wrap justify-center gap-2">
              {chrome.menu.slice(0, 8).map((node) => (
                <li key={node.id}>
                  <Link href={node.href} className={storeButtonVariants({ variant: "secondary" })}>
                    {node.name}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </StorefrontState>
    </StorefrontShell>
  );
}
