import { notFound } from "next/navigation";
import { Container, ProductCard } from "@ecom/ui";

/**
 * HARNESS DOAR PENTRU TESTE (E2E): patru carduri de produs cu stări de stoc scurte și lungi, în aceeași grilă ca lista reală, ca
 * testul să verifice că prețul rămâne pe aceeași linie într-un rând, oricât de lungă e starea. Aceleași bariere ca la celelalte
 * harness-uri (extensia `.e2e.tsx`; producție fără `E2E_HARNESS=1` → 404).
 */
export const dynamic = "force-dynamic";

const CARDS = [
  {
    name: "Produs cu stare scurtă",
    price: "99,00 RON",
    label: "În stoc",
    tone: "success" as const,
  },
  {
    name: "Produs la comandă cu un nume destul de lung ca să ocupe mai multe rânduri în card",
    price: "1.890,00 RON",
    label: "La comandă · livrare în aproximativ 21 de zile",
    tone: "info" as const,
  },
  {
    name: "Alt produs scurt",
    price: "249,00 RON",
    label: "Indisponibil",
    tone: "problem" as const,
  },
  {
    name: "Produs cu stoc limitat",
    price: "1.290,00 RON",
    label: "Stoc limitat · Mai sunt 2",
    tone: "warning" as const,
  },
];

export default function ProductCardsHarness() {
  if (process.env.NODE_ENV === "production" && process.env["E2E_HARNESS"] !== "1") notFound();
  return (
    <Container className="py-8">
      <h1 className="sr-only">Carduri de probă</h1>
      <ul className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-3 xl:grid-cols-4">
        {CARDS.map((card) => (
          <li key={card.name} className="contents">
            <ProductCard
              href="/produs/proba"
              name={card.name}
              price={card.price}
              media={null}
              status={{ label: card.label, tone: card.tone }}
            />
          </li>
        ))}
      </ul>
    </Container>
  );
}
