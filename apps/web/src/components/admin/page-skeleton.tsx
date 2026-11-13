import { Skeleton } from "@ecom/ui";
import { getMessages } from "@/messages";

/**
 * Scheletul unei pagini de admin în curs de încărcare (titlu, o fâșie de filtre și rânduri de listă), fără rotiță pe tot ecranul.
 * Regiunea anunță «Se încarcă…» cititoarelor de ecran; blocurile din schelet sunt ascunse lor. Se folosește ca `fallback` al unui
 * `<Suspense>` în jurul părții lente a unei pagini, NU ca `loading.tsx` la rădăcina adminului: un `loading.tsx` face ca serverul
 * să trimită antetul 200 înainte ca pagina să poată cere `notFound()`, iar rutele oprite de un flag sau de un id inexistent trebuie
 * să răspundă 404 (verificat în `admin.spec.ts`, `product-editor.spec.ts`, `warehouses.spec.ts`).
 */
export function PageSkeleton() {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-6">
      <span className="sr-only">{getMessages().states.loading}</span>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <Skeleton className="h-9 w-full max-w-sm" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
