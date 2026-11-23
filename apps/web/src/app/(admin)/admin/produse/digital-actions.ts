"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import {
  CATALOG_TAG,
  DELIVERY_TYPES,
  addLinkAsset,
  deleteAsset,
  refreshAssetStatus,
  reorderAssets,
  saveDigitalSettings,
  updateAsset,
} from "@ecom/core";
import { getAudit } from "@/lib/admin-writes";
import { getDigitalContentDeps } from "@/lib/digital";
import { errorCodeOf } from "@/lib/error-code";
import { withPermission } from "@/lib/session";

/**
 * Acțiunile conținutului digital al unui produs (Faza 14b), în afara încărcării (care are ruta ei: fișierul nu trece prin server
 * actions). Toate cer `digital.manage` (verificată din nou pe server), validează intrarea cu Zod, apelează serviciile din
 * `packages/core` și scriu auditul: actorul, acțiunea, produsul, numele câmpurilor; NICIODATĂ cheia de stocare, adresa unei legături
 * sau textele libere.
 */
type Fail = { ok: false; code: string };
export type DigitalActionResult<T = object> = ({ ok: true } & T) | Fail;

const id = z.string().min(1).max(64);
const PREFIXES = ["DIGITAL_", "AUTH_"] as const;

const failure = (error: unknown): Fail => ({
  ok: false,
  code: errorCodeOf(error, PREFIXES) ?? "failed",
});

const record = (
  subject: { userId: string; email: string },
  action: string,
  productId: string,
  after: Record<string, unknown> = {},
) =>
  getAudit().record({
    actorId: subject.userId,
    actorLabel: subject.email,
    action,
    entity: "product",
    entityId: productId,
    after,
  });

/** Pagina produsului digital se regenerează (ISR) și editorul se reîncarcă. */
function done(productId: string): void {
  revalidateTag(CATALOG_TAG);
  revalidatePath(`/admin/produse/${productId}`);
}

export const saveDigitalSettingsAction = withPermission(
  "digital.manage",
  async (raw: unknown, subject): Promise<DigitalActionResult<{ changed: string[] }>> => {
    const parsed = z
      .strictObject({
        productId: id,
        deliveryType: z.enum(DELIVERY_TYPES),
        /** Gol = nelimitat. */
        maxDownloads: z.number().int().min(1).max(100_000).nullable(),
        whatYouGet: z.string().max(2000).nullable().optional(),
        requirements: z.string().max(2000).nullable().optional(),
        format: z.string().max(200).nullable().optional(),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "DIGITAL_INPUT_INVALID" };
    try {
      const { productId, ...settings } = parsed.data;
      const result = await saveDigitalSettings(getDigitalContentDeps().db, productId, settings);
      await record(subject, "digital.settings.update", productId, { fields: result.changed });
      done(productId);
      return { ok: true, changed: result.changed };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "digital.settings.update", entity: "product" },
);

export const addDigitalLinkAction = withPermission(
  "digital.manage",
  async (raw: unknown, subject): Promise<DigitalActionResult> => {
    const parsed = z
      .strictObject({
        productId: id,
        title: z.string().max(200),
        url: z.string().max(2000),
        isPreview: z.boolean(),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "DIGITAL_INPUT_INVALID" };
    try {
      const asset = await addLinkAsset(getDigitalContentDeps().db, parsed.data.productId, {
        title: parsed.data.title,
        url: parsed.data.url,
        isPreview: parsed.data.isPreview,
      });
      await record(subject, "digital.asset.add_link", parsed.data.productId, {
        assetId: asset.id,
        isPreview: asset.isPreview,
      });
      done(parsed.data.productId);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "digital.asset.add_link", entity: "product" },
);

export const updateDigitalAssetAction = withPermission(
  "digital.manage",
  async (raw: unknown, subject): Promise<DigitalActionResult> => {
    const parsed = z
      .strictObject({
        productId: id,
        assetId: id,
        title: z.string().max(200).optional(),
        isPreview: z.boolean().optional(),
      })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "DIGITAL_INPUT_INVALID" };
    try {
      const { productId, assetId, ...patch } = parsed.data;
      const fields = await updateAsset(getDigitalContentDeps().db, productId, assetId, patch);
      await record(subject, "digital.asset.update", productId, { assetId, fields });
      done(productId);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "digital.asset.update", entity: "product" },
);

export const reorderDigitalAssetsAction = withPermission(
  "digital.manage",
  async (raw: unknown, subject): Promise<DigitalActionResult> => {
    const parsed = z
      .strictObject({ productId: id, orderedIds: z.array(id).min(1).max(500) })
      .safeParse(raw);
    if (!parsed.success) return { ok: false, code: "DIGITAL_INPUT_INVALID" };
    try {
      await reorderAssets(
        getDigitalContentDeps().db,
        parsed.data.productId,
        parsed.data.orderedIds,
      );
      await record(subject, "digital.asset.reorder", parsed.data.productId, {
        count: parsed.data.orderedIds.length,
      });
      done(parsed.data.productId);
      return { ok: true };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "digital.asset.reorder", entity: "product" },
);

export const deleteDigitalAssetAction = withPermission(
  "digital.manage",
  async (raw: unknown, subject): Promise<DigitalActionResult<{ removedContent: boolean }>> => {
    const parsed = z.strictObject({ productId: id, assetId: id }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "DIGITAL_INPUT_INVALID" };
    try {
      const result = await deleteAsset(
        getDigitalContentDeps(),
        parsed.data.productId,
        parsed.data.assetId,
      );
      await record(subject, "digital.asset.delete", parsed.data.productId, {
        assetId: parsed.data.assetId,
        removedContent: result.removedContent,
      });
      done(parsed.data.productId);
      return { ok: true, removedContent: result.removedContent };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "digital.asset.delete", entity: "product" },
);

export const refreshDigitalAssetAction = withPermission(
  "digital.manage",
  async (raw: unknown): Promise<DigitalActionResult<{ status: string }>> => {
    const parsed = z.strictObject({ productId: id, assetId: id }).safeParse(raw);
    if (!parsed.success) return { ok: false, code: "DIGITAL_INPUT_INVALID" };
    try {
      const status = await refreshAssetStatus(
        getDigitalContentDeps(),
        parsed.data.productId,
        parsed.data.assetId,
      );
      done(parsed.data.productId);
      return { ok: true, status };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "digital.asset.refresh", entity: "product" },
);
