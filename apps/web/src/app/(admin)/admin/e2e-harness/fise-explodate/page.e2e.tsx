import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin-page";
import { DiagramEditor, type DiagramEditorData } from "@/components/admin/diagrams/diagram-editor";
import { DiagramList, type DiagramListRow } from "@/components/admin/diagrams/diagram-list";
import { PageHeader } from "@/components/admin/page-header";
import { getMessages } from "@/messages";

/**
 * HARNESS DOAR PENTRU TESTE (E2E). Nu e o pagină livrată: extensia `.e2e.tsx` e inclusă în `pageExtensions` doar când
 * `E2E_HARNESS=1` (setat de Playwright), deci într-un build normal acest fișier nici nu devine rută. A doua barieră: în producție
 * fără variabilă, 404. Randează lista sau editorul fișelor explodate cu date FIXE (fără bază de date și fără flag), ca testele de
 * design să poată verifica stările pe care baza comună nu le poate garanta: lista goală, doar citire, texte lungi, hotspot-uri
 * cu și fără produs. `?ecran=lista|editor` și `&stare=normal|goala|citire|lung`.
 */
type SearchParams = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value) ?? "";

const m = getMessages().admin.diagrams;

const LONG = "Pompă de căldură inverter cu agent frigorific ecologic pentru piscine rezidențiale";

/** O imagine de probă (SVG în `data:`), ca editorul să aibă un canvas fără fișiere din bibliotecă. */
const IMAGE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='800' height='600'><rect width='800' height='600' fill='steelblue'/></svg>",
  );

function listRows(stare: string): DiagramListRow[] {
  if (stare === "goala") return [];
  const rows: DiagramListRow[] = [
    {
      id: "d1",
      title: "Pompă de filtrare",
      hotspotCount: 12,
      productCount: 5,
      imageUrl: IMAGE,
      imageName: "pompa.png",
    },
    {
      id: "d2",
      title: "Filtru cu nisip",
      hotspotCount: 7,
      productCount: 3,
      imageUrl: null,
      imageName: "filtru.png",
    },
    {
      id: "d3",
      title: stare === "lung" ? LONG : "Skimmer",
      hotspotCount: 0,
      productCount: 0,
      imageUrl: IMAGE,
      imageName: "skimmer.png",
    },
  ];
  return rows;
}

function editorData(stare: string): DiagramEditorData {
  return {
    id: "d1",
    title: stare === "lung" ? LONG : "Pompă de filtrare",
    image: {
      mediaId: "m1",
      name: "pompa.png",
      alt: "Schița pompei",
      url: IMAGE,
      width: 800,
      height: 600,
    },
    hotspots: [
      {
        id: "h1",
        number: 1,
        xBp: 3000,
        yBp: 5500,
        label: "Garnitură",
        product: {
          id: "p1",
          title: stare === "lung" ? LONG : "Garnitură capac",
          sku: "GAR-001",
          status: "published",
          deleted: false,
        },
      },
      { id: "h2", number: 2, xBp: 6200, yBp: 2400, label: "Rotor", product: null },
      {
        id: "h3",
        number: 3,
        xBp: null,
        yBp: null,
        label: null,
        product: {
          id: "p2",
          title: "Șurub inox",
          sku: "SUR-014",
          status: "published",
          deleted: true,
        },
      },
    ],
    products: [
      { id: "p1", title: "Garnitură capac", sku: "GAR-001", status: "published", deleted: false },
      { id: "p2", title: "Șurub inox", sku: "SUR-014", status: "published", deleted: true },
    ],
  };
}

export default async function DiagramsHarnessPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  if (process.env.NODE_ENV === "production" && process.env["E2E_HARNESS"] !== "1") notFound();
  await requireAdmin({ permission: "products.read" });
  const params = await searchParams;
  const ecran = one(params["ecran"]) || "lista";
  const stare = one(params["stare"]) || "normal";
  const canWrite = stare !== "citire";

  if (ecran === "editor") {
    return <DiagramEditor diagram={editorData(stare)} canWrite={canWrite} />;
  }
  const rows = listRows(stare);
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={m.title}
        count={rows.length}
        description={m.description}
        notes={canWrite ? [] : [m.readOnly]}
      />
      <DiagramList diagrams={rows} canWrite={canWrite} />
    </div>
  );
}
