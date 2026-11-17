import { jsonLdText, type JsonLd } from "@/lib/structured-data";

/**
 * Date structurate în HTML-ul de pe server (docs/19 §1: JSON-LD complet pe server, nu doar în client). Textul trece prin
 * `jsonLdText`, care scoate `<`, deci nicio valoare nu poate închide eticheta; ca text copil, React nu modifică conținutul scriptului.
 */
export function JsonLdScript({ data }: { data: JsonLd | JsonLd[] }) {
  return <script type="application/ld+json">{jsonLdText(data)}</script>;
}
