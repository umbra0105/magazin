import { notFound } from "next/navigation";
import type { LibraryFolder, LibraryItem } from "@ecom/core";
import { PageHeader } from "@/components/admin/page-header";
import { MediaLibrary } from "@/components/admin/media/media-library";
import {
  WarehouseManager,
  type WarehouseRow,
} from "@/components/admin/warehouses/warehouse-manager";
import { requireAdmin } from "@/lib/admin-page";
import { getMessages } from "@/messages";
import { UploadHarness } from "./upload-harness.e2e";

/**
 * HARNESS DOAR PENTRU TESTE (E2E). Nu e o pagină livrată: extensia `.e2e.tsx` e inclusă în `pageExtensions` doar când
 * `E2E_HARNESS=1` (setat de Playwright), deci într-un build normal acest fișier nici nu devine rută. A doua barieră: în
 * producție fără variabilă, 404 (în dezvoltare se vede, ca galeria). Randează cu date FIXE ecranele din Lotul 3b-1, ca testele să
 * poată verifica stările pe care baza comună nu le poate garanta: biblioteca media (cu imagini, goală, filtrată, doar citire, texte
 * lungi), lista de încărcări cu toate stările și erorile, și depozitele (listă, goală, doar citire, texte lungi; steagul de multi-depozit rămâne neatins). `?ecran=biblioteca|incarcari|depozite` și `&stare=lista|goala|filtrata|citire|lung`.
 */
type SearchParams = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value) ?? "";

const LONG_NAME =
  "pompa-de-caldura-inverter-cu-agent-frigorific-ecologic-pentru-piscine-rezidentiale-2026-versiunea-finala.png";
const LONG_WORDS =
  "Pompă de căldură inverter cu agent frigorific ecologic pentru piscine rezidențiale";

/** Miniatură de probă: SVG în `data:`, fără fișiere și fără culori scrise ca hex. */
function thumb(fill: string): LibraryItem["thumb"] {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="${fill}"/></svg>`;
  return { url: `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`, width: 320, height: 240 };
}

function item(index: number, over: Partial<LibraryItem> & { originalName: string }): LibraryItem {
  return {
    id: `h${index}`,
    status: "ready",
    mime: "image/png",
    sizeBytes: 120_000 + index * 1000,
    width: 640,
    height: 480,
    alt: "Pompă de căldură montată lângă piscină",
    tags: [],
    folderId: null,
    processingError: null,
    createdAt: "2026-11-10T09:30:00.000Z",
    thumb: thumb(`rgb(${40 + index * 20} ${90 + index * 12} ${200 - index * 15})`),
    placeholder: null,
    ...over,
  };
}

function libraryItems(stare: string): LibraryItem[] {
  if (stare === "goala" || stare === "filtrata") return [];
  const base: LibraryItem[] = [
    item(1, { originalName: "pompa.png" }),
    item(2, { originalName: "liner.png", alt: "" }),
    item(3, { originalName: "filtru.png" }),
    item(4, { originalName: "scara.png" }),
    item(5, { originalName: "in-procesare.png", status: "pending", thumb: null }),
    item(6, {
      originalName: "esuat.png",
      status: "failed",
      thumb: null,
      processingError: "IMAGE_CORRUPT",
    }),
  ];
  if (stare === "lung") {
    base.push(
      item(7, { originalName: LONG_NAME, alt: "" }),
      item(8, { originalName: `${LONG_WORDS}.png` }),
    );
  }
  return base;
}

function folders(stare: string): LibraryFolder[] {
  if (stare === "goala") return [];
  const out: LibraryFolder[] = [
    { id: "f1", name: "Produse", parentId: null, mediaCount: 4 },
    { id: "f2", name: "Pompe de căldură", parentId: "f1", mediaCount: 2 },
    { id: "f3", name: "Branding", parentId: null, mediaCount: 1 },
  ];
  if (stare === "lung") {
    out.push({ id: "f4", name: LONG_WORDS, parentId: "f1", mediaCount: 1234 });
  }
  return out;
}

function warehouseRows(stare: string): WarehouseRow[] {
  if (stare === "goala") return [];
  const base: WarehouseRow[] = [
    {
      id: "w1",
      code: "principal",
      name: "Depozit principal",
      isDefault: true,
      isActive: true,
      stockedItems: 12,
    },
    {
      id: "w2",
      code: "magazin_bucuresti",
      name: "Magazin București",
      isDefault: false,
      isActive: true,
      stockedItems: 0,
    },
    {
      id: "w3",
      code: "vechi",
      name: "Depozit vechi",
      isDefault: false,
      isActive: false,
      stockedItems: 0,
    },
    {
      id: "w4",
      code: "cu_stoc",
      name: "Depozit cu stoc",
      isDefault: false,
      isActive: true,
      stockedItems: 3,
    },
  ];
  if (stare === "lung") {
    base.push({
      id: "w5",
      code: "depozit_cu_un_cod_foarte_lung_de_proba",
      name: LONG_WORDS,
      isDefault: false,
      isActive: true,
      stockedItems: 1234,
    });
  }
  return base;
}

export default async function MediaDepoziteHarnessPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  if (process.env.NODE_ENV === "production" && process.env["E2E_HARNESS"] !== "1") notFound();
  await requireAdmin({ permission: "media.read" });
  const params = await searchParams;
  const ecran = one(params["ecran"]) || "biblioteca";
  const stare = one(params["stare"]) || "lista";
  const canWrite = stare !== "citire";

  if (ecran === "incarcari") return <UploadHarness stare={stare} />;

  if (ecran === "depozite") {
    const m = getMessages().admin.warehouses;
    const rows = warehouseRows(stare);
    return (
      <div className="flex flex-col gap-6">
        <PageHeader
          title={m.title}
          count={rows.length}
          description={m.description}
          notes={canWrite ? [] : [m.readOnly]}
        />
        <WarehouseManager rows={rows} canWrite={canWrite} />
      </div>
    );
  }

  const m = getMessages().admin.media;
  const items = libraryItems(stare);
  const list = folders(stare);
  const folderHrefs: Record<string, string> = {
    all: "/admin/media",
    root: "/admin/media?folder=root",
    ...Object.fromEntries(list.map((f) => [f.id, `/admin/media?folder=${f.id}`])),
  };
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={m.title}
        count={items.length}
        description={m.description}
        notes={canWrite ? [] : [m.readOnly]}
      />
      <MediaLibrary
        items={items}
        folders={list}
        canWrite={canWrite}
        currentFolder={null}
        totalCount={stare === "filtrata" ? 12 : items.length}
        maxUploadMb={10}
        folderHrefs={folderHrefs}
      />
    </div>
  );
}
