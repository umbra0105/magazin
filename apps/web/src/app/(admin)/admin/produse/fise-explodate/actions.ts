"use server";

import { z } from "zod";
import { getPartsDiagramService, getProductListService } from "@/lib/catalog";
import { productFailure as failure } from "@/lib/product-action-support";
import { withPermission } from "@/lib/session";

/**
 * Acțiunile fișelor explodate. Toate trec prin `withPermission` cu `products.*` și apoi prin
 * `PartsDiagramService`, care verifică singur flag-ul `partsDiagrams` (oprit = `FEATURE_DISABLED`),
 * validează cu Zod strict și înregistrează audit. Structura (fișă, hotspot-uri, asociere) cere
 * `products.write`; căutarea de produse cere doar `products.read`.
 */

const id = z.string().min(1).max(40);

export const createDiagram = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const created = await getPartsDiagramService().create(subject, input);
      return { ok: true as const, id: created.id };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "parts_diagram.create", entity: "parts_diagram" },
);

export const updateDiagram = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ id, patch: z.unknown() }).parse(input);
      await getPartsDiagramService().update(subject, parsed.id, parsed.patch);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "parts_diagram.update", entity: "parts_diagram" },
);

export const deleteDiagram = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ id, expectedHotspots: z.number().int().min(0) }).parse(input);
      const result = await getPartsDiagramService().delete(subject, parsed.id, {
        confirm: true,
        expectedHotspots: parsed.expectedHotspots,
      });
      return { ok: true as const, deletedHotspots: result.deletedHotspots };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "parts_diagram.delete", entity: "parts_diagram" },
);

export const attachDiagramProduct = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ diagramId: id, productId: id }).parse(input);
      await getPartsDiagramService().attachProduct(subject, parsed.diagramId, parsed.productId);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "parts_diagram.attach", entity: "parts_diagram" },
);

export const detachDiagramProduct = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ diagramId: id, productId: id }).parse(input);
      await getPartsDiagramService().detachProduct(subject, parsed.diagramId, parsed.productId);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "parts_diagram.detach", entity: "parts_diagram" },
);

export const saveDiagramHotspot = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ diagramId: id, hotspot: z.unknown() }).parse(input);
      const saved = await getPartsDiagramService().saveHotspot(
        subject,
        parsed.diagramId,
        parsed.hotspot,
      );
      return { ok: true as const, id: saved.id, number: saved.number };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "parts_diagram.hotspot.save", entity: "parts_diagram" },
);

export const deleteDiagramHotspot = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ diagramId: id, hotspotId: id }).parse(input);
      await getPartsDiagramService().deleteHotspot(subject, parsed.diagramId, parsed.hotspotId);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "parts_diagram.hotspot.delete", entity: "parts_diagram" },
);

/** Căutarea unui produs (piesă) după titlu, SKU, EAN sau cod producător. Cere `products.read`. */
export const searchDiagramProducts = withPermission(
  "products.read",
  async (input: unknown, subject) => {
    try {
      const parsed = z.object({ q: z.string().max(100) }).parse(input);
      if (parsed.q.trim().length < 2) return { ok: true as const, results: [] };
      const { page } = await getProductListService().list(subject, { q: parsed.q, size: "25" });
      return {
        ok: true as const,
        results: page.rows.map((row) => ({
          id: row.id,
          title: row.title,
          sku: row.sku,
          status: row.status,
        })),
      };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "parts_diagram.search", entity: "product" },
);
