"use server";

import { z } from "zod";
import { getBrandService } from "@/lib/catalog";
import { withPermission } from "@/lib/session";

/** Acțiunile brandurilor: aceleași reguli ca la categorii (vezi `categorii/actions.ts`). */

export type BrandActionFailure = { ok: false; code: string; message?: string };

const DOMAIN_CODES = new Set([
  "BRAND_NOT_FOUND",
  "BRAND_SLUG_CONFLICT",
  "BRAND_LOGO_NOT_FOUND",
  "BRAND_HAS_PRODUCTS",
  "AUTH_FORBIDDEN",
  "AUDIT_WRITE_FAILED",
]);

function failure(error: unknown): BrandActionFailure {
  const e = error as { code?: unknown; message?: unknown; name?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : undefined;
  if (code && (DOMAIN_CODES.has(code) || code === "VALIDATION_ERROR")) {
    return {
      ok: false,
      code,
      ...(typeof e?.message === "string" && { message: e.message }),
    };
  }
  if (e?.name === "ZodError") return { ok: false, code: "VALIDATION_ERROR" };
  throw error;
}

const id = z.string().min(1).max(40);

export const createBrand = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const brand = await getBrandService().create(subject, input);
      return { ok: true as const, id: brand.id };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "brand.create", entity: "brand" },
);

export const updateBrand = withPermission(
  "products.content.write",
  async (input: unknown, subject) => {
    try {
      const { id: brandId, ...patch } = z.object({ id }).passthrough().parse(input);
      await getBrandService().update(subject, brandId, patch);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "brand.update", entity: "brand" },
);

export const deleteBrand = withPermission(
  "products.write",
  async (input: unknown, subject) => {
    try {
      const { id: brandId } = z.object({ id }).parse(input);
      await getBrandService().delete(subject, brandId);
      return { ok: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  { action: "brand.delete", entity: "brand" },
);
