/**
 * Regula de publicare pe un canal extern: EAN-ul variantei și brandul produsului sunt OBLIGATORII doar
 * aici, nu în catalog (un draft, un import sau un produs vândut doar pe web poate să nu le aibă).
 * Ce cere un canal e în `SalesChannel.requiresEan` / `requiresBrand`, nu în cod.
 */
export type PublicationIssueCode = "EAN_MISSING" | "BRAND_MISSING";

export interface PublicationIssue {
  code: PublicationIssueCode;
  field: "ean" | "brandId";
  message: string;
}

export interface PublicationChannel {
  requiresEan: boolean;
  requiresBrand: boolean;
}

export interface PublicationCandidate {
  ean: string | null;
  brandId: string | null;
}

const blank = (value: string | null): boolean => value === null || value.trim() === "";

/** Problemele care împiedică publicarea; lista goală înseamnă că se poate publica. */
export function validateForPublication(
  channel: PublicationChannel,
  candidate: PublicationCandidate,
): PublicationIssue[] {
  const issues: PublicationIssue[] = [];
  if (channel.requiresEan && blank(candidate.ean)) {
    issues.push({
      code: "EAN_MISSING",
      field: "ean",
      message: "Canalul cere codul EAN pe variantă.",
    });
  }
  if (channel.requiresBrand && blank(candidate.brandId)) {
    issues.push({
      code: "BRAND_MISSING",
      field: "brandId",
      message: "Canalul cere brandul produsului.",
    });
  }
  return issues;
}
