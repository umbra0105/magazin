import Link from "next/link";
import { buttonVariants, EmptyState } from "@ecom/ui";
import { AdminSurface } from "@/components/admin/admin-surface";
import { getMessages } from "@/messages";

const m = getMessages().states.notFound;

/**
 * Pagina 404 a aplicației (adrese care nu există, în afara adminului). Stă pe suprafața adminului (tokeni, temă deschisă și
 * închisă) până când vitrina (Faza 7) își face propria pagină; nu cere baza de date, deci se poate prerandare.
 */
export default function NotFound() {
  return (
    <AdminSurface>
      <main className="flex min-h-dvh items-center justify-center px-4 py-8">
        <EmptyState
          as="h2"
          title={m.title}
          description={m.description}
          action={
            <Link href="/" className={buttonVariants()}>
              {m.home}
            </Link>
          }
        />
      </main>
    </AdminSurface>
  );
}
