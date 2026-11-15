import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";
import { Container } from "./container";

/** Bloc de schelet al vitrinei: culoarea cardurilor, rază din preset, puls oprit la `prefers-reduced-motion`; ascuns cititoarelor de ecran. */
export function StoreSkeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden="true"
      className={cn("rounded-card bg-card motion-safe:animate-pulse", className)}
      {...props}
    />
  );
}

/**
 * Scheletul unei pagini a vitrinei (hero + grilă de carduri), cât se încarcă pagina. O regiune `status` cu `aria-busy` și textul
 * de încărcare doar pentru cititoarele de ecran; blocurile nu sunt citite. Nu conține niciun heading.
 */
export function StorefrontLoading({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      <StoreSkeleton className="min-h-80 rounded-none" />
      <Container className="py-section">
        <StoreSkeleton className="mb-8 h-10 w-2/3 max-w-md" />
        <div className="grid grid-cols-2 gap-3 sm:gap-6 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="flex flex-col gap-3">
              <StoreSkeleton className="aspect-square w-full" />
              <StoreSkeleton className="h-5 w-3/4" />
              <StoreSkeleton className="h-5 w-1/3" />
            </div>
          ))}
        </div>
      </Container>
    </div>
  );
}
