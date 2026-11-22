"use client";

import { WishlistButton } from "../account/wishlist-button";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { StoreButton, StorePill, type StorePillTone } from "@ecom/ui";
import { QUANTITY_FACTOR, formatQuantity, quantityFromTicks } from "@ecom/shared/quantity";
import { addToCart, openDrawer, useCartState } from "@/components/storefront/cart/cart-store";
import { QuantityStepper } from "@/components/storefront/cart/steps-stepper";
import { getMessages } from "@/messages";

const m = getMessages().storefront.catalog.product;

export interface PanelVariant {
  id: string;
  sku: string;
  label: string;
  optionValues: Record<string, string>;
  /** Prețul gata formatat pe server (moneda și limba din setări); clientul nu formatează bani. */
  priceText: string;
  /** Ce urmează după preț: «/ mp», «/ sac de 25 kg» (gol la bucăți). */
  priceSuffix: string | null;
  compareAtText: string | null;
  /** Cum se vinde: pasul în zecimi de miime (șir), minimul în pași, unitatea și denumirea pasului. */
  stepTicks: string;
  minSteps: number;
  unitSymbol: string;
  stepLabel: string | null;
  availabilityLabel: string;
  availabilityDetail: string | null;
  tone: StorePillTone;
  purchasable: boolean;
  warrantyText: string | null;
  partNumber: string | null;
}

export interface PanelOption {
  id: string;
  name: string;
  values: { id: string; value: string }[];
}

type NotifyState =
  "idle" | "sending" | "registered" | "available" | "invalid" | "consent" | "failed";

const FIELD =
  "h-(--sf-control-h) w-full rounded-full border border-line-input bg-surface-page px-5 text-(length:--control-text) text-ink " +
  "placeholder:text-ink-placeholder focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page";

/**
 * Zona de cumpărare a paginii de produs: prețul variantei alese, starea ei de stoc (D6), selectorul de variante, selectorul de
 * cantitate ÎN PAȘI cu «Adaugă în coș» (serverul validează pasul, stocul și plafoanele) și, cât varianta e indisponibilă,
 * formularul «Anunță-mă când revine». Datele de contact ale firmei rămân ca ajutor informativ. Pe telefon, bara lipicioasă
 * ține prețul și «Adaugă în coș» când prețul iese din ecran. Varianta implicită e desenată pe server.
 */
export function PurchasePanel({
  options,
  variants,
  defaultVariantId,
  contact,
  productTitle,
  wishlist = false,
}: {
  productTitle: string;
  /** Arată butonul «Favorite» (flag-ul `wishlist` pornit). */
  wishlist?: boolean;
  options: readonly PanelOption[];
  variants: readonly PanelVariant[];
  defaultVariantId: string;
  contact: { phone: string; telHref: string | null; email: string } | null;
}) {
  const initial = variants.find((v) => v.id === defaultVariantId) ?? variants[0];
  const [variantId, setVariantId] = useState(initial?.id ?? "");
  const selected = variants.find((v) => v.id === variantId) ?? initial;
  const [steps, setSteps] = useState(initial?.minSteps ?? 1);
  const { busy } = useCartState();
  const emailId = useId();
  const [email, setEmail] = useState("");
  const [notify, setNotify] = useState<NotifyState>("idle");
  const priceRef = useRef<HTMLParagraphElement>(null);
  const [priceVisible, setPriceVisible] = useState(true);
  useEffect(() => {
    const node = priceRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) =>
      setPriceVisible(entry?.isIntersecting ?? true),
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  if (!selected) return null;
  const hasContact = Boolean(contact && (contact.phone || contact.email));
  const stepQuantity = quantityFromTicks(BigInt(selected.stepTicks));
  const oneUnit = BigInt(stepQuantity) === QUANTITY_FACTOR;
  const totalTicks = BigInt(selected.stepTicks) * BigInt(steps);
  const add = async () => {
    const result = await addToCart(selected.id, totalTicks.toString(), productTitle);
    if (result.ok) openDrawer();
  };

  const choose = (optionId: string, valueId: string) => {
    const wanted = { ...selected.optionValues, [optionId]: valueId };
    const exact = variants.find((v) =>
      Object.entries(wanted).every(([key, value]) => v.optionValues[key] === value),
    );
    const fallback = variants.find((v) => v.optionValues[optionId] === valueId);
    const next = exact ?? fallback;
    if (next) {
      setVariantId(next.id);
      setSteps(next.minSteps);
      setNotify("idle");
    }
  };

  const exists = (optionId: string, valueId: string): boolean =>
    variants.some((v) => v.optionValues[optionId] === valueId);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const address = String(form.get("email") ?? "").trim();
    const consent = form.get("consent") === "on";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      setNotify("invalid");
      return;
    }
    if (!consent) {
      setNotify("consent");
      return;
    }
    setNotify("sending");
    try {
      const response = await fetch("/api/back-in-stock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          variantId: selected.id,
          email: address,
          consent: true,
          website: String(form.get("website") ?? ""),
        }),
      });
      if (!response.ok) {
        setNotify(response.status === 400 ? "invalid" : "failed");
        return;
      }
      const body = (await response.json()) as { status?: string };
      setNotify(body.status === "available" ? "available" : "registered");
    } catch {
      setNotify("failed");
    }
  };

  const message: Record<Exclude<NotifyState, "idle" | "sending">, string> = {
    registered: m.notifyRegistered,
    available: m.notifyAvailable,
    invalid: m.notifyInvalid,
    consent: m.notifyConsentRequired,
    failed: m.notifyFailed,
  };

  return (
    <div className="flex flex-col gap-6" data-purchase-panel>
      <div className="flex flex-col gap-2">
        <p ref={priceRef} className="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-price>
          <span className="heading-display text-5xl">{selected.priceText}</span>
          {selected.priceSuffix ? (
            <span className="text-lg text-ink-secondary">{selected.priceSuffix}</span>
          ) : null}
          {selected.compareAtText ? (
            <s className="text-lg text-ink-secondary">{selected.compareAtText}</s>
          ) : null}
        </p>
        <p className="text-sm text-ink-secondary">{m.priceVat}</p>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-availability>
        <StorePill tone={selected.tone}>{selected.availabilityLabel}</StorePill>
        {selected.availabilityDetail ? (
          <span className="text-sm text-ink-secondary">{selected.availabilityDetail}</span>
        ) : null}
        {wishlist ? (
          <WishlistButton variantId={selected.id} name={productTitle} className="ml-auto" />
        ) : null}
      </div>

      {options.length > 0 && variants.length > 1 ? (
        <div className="flex flex-col gap-5">
          {options.map((option) => (
            <fieldset key={option.id} className="flex flex-col gap-2.5">
              <legend className="text-sm font-semibold">{option.name}</legend>
              <div className="flex flex-wrap gap-2">
                {option.values.map((value) => {
                  const active = selected.optionValues[option.id] === value.id;
                  return (
                    <button
                      key={value.id}
                      type="button"
                      aria-pressed={active}
                      disabled={!exists(option.id, value.id)}
                      onClick={() => choose(option.id, value.id)}
                      className={
                        "inline-flex h-11 items-center rounded-full border px-5 text-sm font-medium transition-colors duration-(--motion) " +
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40 " +
                        (active
                          ? "border-action bg-action text-action-fg"
                          : "border-line-control bg-surface-page text-ink hover:bg-card")
                      }
                    >
                      {value.value}
                    </button>
                  );
                })}
              </div>
            </fieldset>
          ))}
        </div>
      ) : null}

      {selected.purchasable ? (
        <div className="flex flex-col gap-4" data-add-to-cart>
          <div className="flex flex-col gap-2">
            <p className="text-sm font-semibold">{m.quantity}</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <QuantityStepper
                steps={steps}
                minSteps={selected.minSteps}
                label={m.quantity}
                disabled={busy}
                onChange={setSteps}
              />
              <p className="text-sm tabular-nums text-ink-secondary" data-quantity-total>
                {m.quantityTotal(
                  formatQuantity(quantityFromTicks(totalTicks)),
                  selected.unitSymbol,
                )}
              </p>
            </div>
            {oneUnit ? null : (
              <p className="text-sm text-ink-secondary" data-step-hint>
                {steps === 1 ? "1" : steps} ×{" "}
                {m.quantityHint(
                  formatQuantity(stepQuantity),
                  selected.unitSymbol,
                  selected.stepLabel,
                )}
              </p>
            )}
          </div>
          <StoreButton size="lg" disabled={busy} onClick={() => void add()} data-add-button>
            {busy ? m.adding : m.addToCart}
          </StoreButton>
        </div>
      ) : null}
      {selected.purchasable && hasContact && contact ? (
        <section
          className="flex flex-col gap-1.5 rounded-card bg-card p-5 text-sm"
          aria-label={m.contactTitle}
          id="cum-comanzi"
        >
          <p className="font-semibold">{m.contactTitle}</p>
          <p className="text-ink-secondary">{m.contactLine}</p>
          {contact.phone ? (
            <p>
              {contact.telHref ? (
                <a href={contact.telHref} className="underline underline-offset-2">
                  {m.orderPhone(contact.phone)}
                </a>
              ) : (
                m.orderPhone(contact.phone)
              )}
            </p>
          ) : null}
          {contact.email ? (
            <p>
              <a href={`mailto:${contact.email}`} className="underline underline-offset-2">
                {m.orderEmail(contact.email)}
              </a>
            </p>
          ) : null}
        </section>
      ) : null}
      {!selected.purchasable ? (
        <form
          noValidate
          onSubmit={submit}
          className="flex flex-col gap-3 rounded-card bg-card p-5"
          aria-labelledby={`${emailId}-title`}
          id="anunta-ma"
        >
          <p id={`${emailId}-title`} className="font-semibold">
            {m.notifyTitle}
          </p>
          <p className="text-sm text-ink-secondary">{m.notifyLede}</p>
          {notify === "registered" || notify === "available" ? (
            <p role="status" className="text-sm font-medium">
              {message[notify]}
            </p>
          ) : (
            <>
              <label htmlFor={emailId} className="sr-only">
                {m.notifyEmail}
              </label>
              <input
                id={emailId}
                name="email"
                type="text"
                inputMode="email"
                autoComplete="email"
                placeholder={m.notifyEmail}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-invalid={notify === "invalid"}
                className={FIELD}
              />
              {/* capcană pentru roboți: un om nu vede și nu completează câmpul */}
              <input
                name="website"
                type="text"
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                className="hidden"
              />
              <label className="flex items-start gap-3 text-sm">
                <input
                  name="consent"
                  type="checkbox"
                  aria-invalid={notify === "consent"}
                  className="mt-0.5 size-5 shrink-0 accent-brand"
                />
                <span>{m.notifyConsent}</span>
              </label>
              {notify === "invalid" || notify === "consent" || notify === "failed" ? (
                <p role="alert" className="text-sm text-tone-problem-fg">
                  {message[notify]}
                </p>
              ) : null}
              <StoreButton type="submit" disabled={notify === "sending"}>
                {notify === "sending" ? m.notifySending : m.notifySubmit}
              </StoreButton>
              <p className="text-sm text-ink-secondary">{m.notifyPrivacy}</p>
            </>
          )}
        </form>
      ) : null}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-ink-secondary">{m.sku}</dt>
        <dd data-sku>{selected.sku}</dd>
        {selected.partNumber ? (
          <>
            <dt className="text-ink-secondary">{m.partNumber}</dt>
            <dd>{selected.partNumber}</dd>
          </>
        ) : null}
        {selected.warrantyText ? (
          <>
            <dt className="text-ink-secondary">{m.warrantyLabel}</dt>
            <dd>{selected.warrantyText}</dd>
          </>
        ) : null}
      </dl>
      {priceVisible ? null : (
        <div
          data-sticky-bar
          className="fixed inset-x-0 bottom-0 z-40 flex items-center justify-between gap-4 border-t border-line-subtle bg-surface-page px-gutter py-3 lg:hidden"
        >
          <p className="flex flex-col leading-tight">
            <span className="text-xl font-semibold">{selected.priceText}</span>
            <span className="text-sm text-ink-secondary">{selected.availabilityLabel}</span>
          </p>
          {selected.purchasable ? (
            <StoreButton disabled={busy} onClick={() => void add()} data-sticky-add>
              {m.stickyAdd}
            </StoreButton>
          ) : (
            <a
              href="#anunta-ma"
              className="inline-flex h-12 items-center rounded-full bg-action px-6 font-semibold text-action-fg"
            >
              {m.stickyNotify}
            </a>
          )}
        </div>
      )}
    </div>
  );
}
