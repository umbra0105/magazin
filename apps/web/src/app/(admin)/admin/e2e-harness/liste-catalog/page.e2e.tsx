import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/admin-page";
import {
  AttributeManager,
  type AttributeRow,
} from "@/components/admin/attributes/attribute-manager";
import { BrandManager, type BrandRow } from "@/components/admin/brands/brand-manager";
import { CategoryManager } from "@/components/admin/categories/category-manager";
import type { CategoryRow } from "@/components/admin/categories/category-types";
import {
  MeasureUnitManager,
  type MeasureUnitRow,
} from "@/components/admin/measure-units/measure-unit-manager";

/**
 * HARNESS DOAR PENTRU TESTE (E2E). Nu e o pagină livrată: extensia `.e2e.tsx` e inclusă în `pageExtensions` doar când
 * `E2E_HARNESS=1` (setat de Playwright), deci într-un build normal acest fișier nici nu devine rută. A doua barieră: fără
 * variabila, 404. Randează unul dintre ecranele de catalog (categorii, branduri, atribute, unități de măsură) cu date FIXE, ca
 * testele să poată verifica stările pe care baza de date comună nu le poate garanta: lista goală, modul doar pentru citire și
 * textele lungi. `?ecran=unitati|branduri|atribute|categorii` și `&stare=lista|goala|citire|lung`.
 */
type SearchParams = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value) ?? "";

const LONG = "Pompă de căldură inverter cu agent frigorific ecologic pentru piscine rezidențiale";

function unitRows(stare: string): MeasureUnitRow[] {
  if (stare === "goala") return [];
  const base: MeasureUnitRow[] = [
    {
      id: "u1",
      code: "buc",
      name: "Bucată",
      symbol: "buc",
      smartbillName: "buc",
      decimals: 0,
      isActive: true,
      isSystem: true,
      productCount: 128,
      variantCount: 240,
    },
    {
      id: "u2",
      code: "mp",
      name: "Metru pătrat",
      symbol: "mp",
      smartbillName: null,
      decimals: 2,
      isActive: true,
      isSystem: true,
      productCount: 12,
      variantCount: 12,
    },
    {
      id: "u3",
      code: "litru",
      name: "Litru",
      symbol: "l",
      smartbillName: "litru",
      decimals: 1,
      isActive: false,
      isSystem: false,
      productCount: 0,
      variantCount: 0,
    },
  ];
  if (stare === "lung") {
    base.push({
      id: "u4",
      code: "unitate_lunga_de_proba",
      name: LONG,
      symbol: "ucm",
      smartbillName: LONG,
      decimals: 4,
      isActive: true,
      isSystem: false,
      productCount: 1234,
      variantCount: 5678,
    });
  }
  return base;
}

function brandRows(stare: string): BrandRow[] {
  if (stare === "goala") return [];
  const make = (id: string, name: string, slug: string, productCount: number): BrandRow => ({
    id,
    name,
    slug,
    productCount,
    description: null,
    seoTitle: null,
    seoDescription: null,
    logoMediaId: null,
    defaultLeadTimeDays: id === "b2" ? 7 : null,
    legacyId: null,
    legacyUrl: null,
  });
  const rows = [make("b1", "Hayward", "hayward", 42), make("b2", "Zodiac", "zodiac", 17)];
  if (stare === "lung")
    rows.push(make("b3", LONG, "pompa-de-caldura-inverter-cu-agent-frigorific", 1234));
  return rows;
}

function attributeRows(stare: string): AttributeRow[] {
  if (stare === "goala") return [];
  const rows: AttributeRow[] = [
    {
      id: "a1",
      code: "material",
      name: "Material",
      type: "text",
      unit: null,
      isFilterable: false,
      sortOrder: 1,
      productCount: 30,
      options: [],
    },
    {
      id: "a2",
      code: "putere_termica",
      name: "Putere termică",
      type: "number",
      unit: "kW",
      isFilterable: true,
      sortOrder: 2,
      productCount: 12,
      options: [],
    },
    {
      id: "a3",
      code: "culoare",
      name: "Culoare",
      type: "select",
      unit: null,
      isFilterable: true,
      sortOrder: 3,
      productCount: 9,
      options: [
        { id: "o1", value: "Alb", productCount: 4 },
        { id: "o2", value: "Gri antracit", productCount: 5 },
      ],
    },
  ];
  if (stare === "lung") {
    rows.push({
      id: "a4",
      code: "atribut_cu_cod_foarte_lung_pentru_proba",
      name: LONG,
      type: "number",
      unit: "kWh/an",
      isFilterable: true,
      sortOrder: 4,
      productCount: 1234,
      options: [],
    });
  }
  return rows;
}

function categoryRows(stare: string): CategoryRow[] {
  if (stare === "goala") return [];
  const make = (
    id: string,
    parentId: string | null,
    name: string,
    path: string,
    depth: number,
    index: number,
    siblingCount: number,
    productCount: number,
  ): CategoryRow => ({
    id,
    parentId,
    name,
    slug: path.split("/").pop() ?? path,
    path,
    depth,
    index,
    siblingCount,
    productCount,
    description: null,
    seoTitle: null,
    seoDescription: null,
    imageMediaId: null,
    excludeFromGroupDiscount: false,
    legacyId: null,
    legacyUrl: null,
    validParentIds: [null],
  });
  const rows = [
    make("c1", null, "Pompe de căldură", "pompe-de-caldura", 0, 0, 2, 24),
    make("c2", "c1", "Pompe inverter", "pompe-de-caldura/pompe-inverter", 1, 0, 2, 14),
    make("c3", "c1", "Pompe on/off", "pompe-de-caldura/pompe-on-off", 1, 1, 2, 10),
    make("c4", null, "Tratarea apei", "tratarea-apei", 0, 1, 2, 31),
  ];
  if (stare === "lung") {
    rows.push(
      make(
        "c5",
        "c4",
        LONG,
        "tratarea-apei/pompa-de-caldura-inverter-cu-agent-frigorific",
        1,
        0,
        1,
        1234,
      ),
    );
  }
  return rows;
}

export default async function CatalogListsHarnessPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  if (process.env.NODE_ENV === "production" && process.env["E2E_HARNESS"] !== "1") notFound();
  await requireAdmin({ permission: "products.read" });
  const params = await searchParams;
  const ecran = one(params["ecran"]);
  const stare = one(params["stare"]) || "lista";
  const readOnly = stare === "citire";
  const all = { structure: !readOnly, content: !readOnly, legacy: !readOnly, pickMedia: false };

  if (ecran === "unitati") {
    return <MeasureUnitManager rows={unitRows(stare)} canWrite={!readOnly} />;
  }
  if (ecran === "branduri") {
    return <BrandManager rows={brandRows(stare)} capabilities={all} thumbs={{}} editId={null} />;
  }
  if (ecran === "atribute") {
    return <AttributeManager attributes={attributeRows(stare)} canWrite={!readOnly} />;
  }
  if (ecran === "categorii") {
    return (
      <CategoryManager
        rows={categoryRows(stare)}
        capabilities={all}
        maxDepth={3}
        thumbs={{}}
        editId={null}
      />
    );
  }
  notFound();
}
