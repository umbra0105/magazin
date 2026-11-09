/**
 * Starea notificărilor scurte (docs/17 §3): pură, fără React, ca să se poată testa. Notificarea reușită / informativă dispare
 * după 4 secunde; eroarea (`danger`) rămâne până o închide utilizatorul. Cel mult `TOAST_LIMIT` deodată: la depășire pleacă
 * cea mai veche dintre cele care oricum dispar singure, iar erorile se păstrează.
 */
export type ToastTone = "success" | "info" | "warning" | "danger";

export interface ToastInput {
  tone: ToastTone;
  title: string;
  description?: string;
}

export interface ToastItem extends ToastInput {
  id: string;
}

export const TOAST_DURATION_MS = 4000;
export const TOAST_LIMIT = 4;

/** Doar erorile rămân până sunt închise. */
export const autoDismisses = (tone: ToastTone): boolean => tone !== "danger";

export function addToast(list: readonly ToastItem[], item: ToastItem): ToastItem[] {
  const next = [...list, item];
  while (next.length > TOAST_LIMIT) {
    const evictable = next.findIndex((toast) => autoDismisses(toast.tone));
    if (evictable === -1) break;
    next.splice(evictable, 1);
  }
  return next;
}

export function removeToast(list: readonly ToastItem[], id: string): ToastItem[] {
  return list.filter((toast) => toast.id !== id);
}
