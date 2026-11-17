"use client";

import { Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { EnergyLabel, StoreButton, StoreImage, StorePill, cn, storeButtonVariants } from "@ecom/ui";
import type { CartDto, CartIssueDto, CartLineDto } from "@/lib/cart-dto";
import { getMessages } from "@/messages";
import {
  acknowledgePrice,
  closeDrawer,
  loadCart,
  removeLine,
  setQuantity,
  useCartState,
} from "./cart-store";
import { QuantityStepper } from "./steps-stepper";

const m = getMessages().storefront.cart;

/** Regiunea `aria-live` a coșului: anunță rezultatul fiecărei acțiuni (adăugat, actualizat, motivul unui refuz). Un singur exemplar pe pagină. */
export function CartLive() {
  const { message } = useCartState();
  return (
    <div
      className="sr-only"
      role={message?.kind === "error" ? "alert" : "status"}
      aria-live="polite"
    >
      {message ? <span key={message.id}>{message.text}</span> : null}
    </div>
  );
}

function IssueRow({
  issue,
  line,
  busy,
}: {
  issue: CartIssueDto;
  line: CartLineDto;
  busy: boolean;
}) {
  const action = issue.action;
  return (
    <div className="flex flex-col gap-2 rounded-card bg-tone-warning-bg px-3 py-2 text-sm text-tone-warning-fg">
      <p>{issue.message}</p>
      {action ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (action.kind === "remove") void removeLine(line.variantId, line.title);
            else if (action.kind === "adjust")
              void setQuantity(line.variantId, action.quantityTicks);
            else void acknowledgePrice(line.variantId);
          }}
          className="inline-flex min-h-11 w-fit items-center rounded-full border border-current px-4 font-semibold transition-colors duration-(--motion) hover:bg-surface-page/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
        >
          {action.kind === "remove" ? m.remove(line.title) : action.label}
        </button>
      ) : null}
    </div>
  );
}

function CartLine({ line, busy }: { line: CartLineDto; busy: boolean }) {
  const unavailable = !line.included;
  return (
    <li
      data-cart-line={line.variantId}
      className={cn("flex flex-col gap-3 py-5", unavailable && "opacity-90")}
    >
      <div className="flex gap-4">
        <div className="size-20 shrink-0 overflow-hidden rounded-card bg-media sm:size-24 [&_img]:mix-blend-multiply">
          {line.image ? (
            <StoreImage
              src={line.image.src}
              alt={line.image.alt}
              width={line.image.width}
              height={line.image.height}
              className="size-full object-contain p-1.5"
            />
          ) : null}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-start justify-between gap-3">
            <Link
              href={line.href}
              className="min-w-0 break-words font-semibold underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
              {line.title}
            </Link>
            <p className="shrink-0 text-right font-semibold tabular-nums" data-line-total>
              {line.totalText ?? (
                <span className="text-sm font-normal text-ink-secondary">{m.excluded}</span>
              )}
            </p>
          </div>
          {line.variantLabel ? (
            <p className="text-sm text-ink-secondary">{line.variantLabel}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StorePill tone={line.stateTone}>{line.stateLabel}</StorePill>
            {line.stateDetail ? (
              <span className="text-sm text-ink-secondary">{line.stateDetail}</span>
            ) : null}
            {line.energy ? (
              <EnergyLabel energyClass={line.energy.value} label={line.energy.label} />
            ) : null}
          </div>
          {line.unitPriceText ? (
            <p className="text-sm text-ink-secondary tabular-nums">{line.unitPriceText}</p>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {unavailable ? null : (
          <QuantityStepper
            steps={line.steps}
            minSteps={line.minSteps}
            label={m.quantityOf(line.title)}
            disabled={busy}
            onChange={(steps) =>
              void setQuantity(line.variantId, (BigInt(line.stepTicks) * BigInt(steps)).toString())
            }
          />
        )}
        <p className="text-sm tabular-nums" data-line-quantity>
          {line.quantityText}
        </p>
        <button
          type="button"
          disabled={busy}
          aria-label={m.remove(line.title)}
          onClick={() => void removeLine(line.variantId, line.title)}
          className="ml-auto inline-flex size-11 items-center justify-center rounded-full text-ink-secondary transition-colors duration-(--motion) hover:bg-card hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40"
        >
          <Trash2 aria-hidden="true" className="size-5" />
        </button>
      </div>
      {line.stepNote || line.minNote ? (
        <p className="text-sm text-ink-secondary">
          {[line.stepNote, line.minNote].filter(Boolean).join(". ")}
        </p>
      ) : null}
      {line.issues.map((issue) => (
        <IssueRow key={issue.type} issue={issue} line={line} busy={busy} />
      ))}
    </li>
  );
}

function FreeShipping({ progress }: { progress: NonNullable<CartDto["freeShipping"]> }) {
  return (
    <div className="flex flex-col gap-2" data-free-shipping>
      <p className="text-sm font-medium">{progress.text}</p>
      <div
        role="progressbar"
        aria-label={m.freeShippingLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress.percent}
        className="h-2 overflow-hidden rounded-full bg-card"
      >
        <div className="h-full rounded-full bg-brand" style={{ width: `${progress.percent}%` }} />
      </div>
    </div>
  );
}

/** Sumarul comenzii: aceleași componente în sertar și pe pagină. Transportul se calculează la finalizare; nicio reducere nu apare aici. */
export function OrderSummary({ cart }: { cart: CartDto }) {
  const totals = cart.totals;
  return (
    <section aria-label={m.summaryTitle} className="flex flex-col gap-4" data-order-summary>
      {cart.freeShipping ? <FreeShipping progress={cart.freeShipping} /> : null}
      {totals ? (
        <dl className="flex flex-col gap-1.5 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-ink-secondary">{m.products}</dt>
            <dd className="tabular-nums">{totals.productsText}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-ink-secondary">{m.shipping}</dt>
            <dd>{m.shippingLater}</dd>
          </div>
          <div className="flex justify-between gap-4 border-t border-line-subtle pt-3 text-base font-semibold">
            <dt>{m.total}</dt>
            <dd className="tabular-nums" data-cart-total>
              {totals.totalText}
            </dd>
          </div>
          <div className="text-ink-secondary">
            <dd className="text-right tabular-nums">{m.vatIncluded(totals.vatText)}</dd>
          </div>
        </dl>
      ) : null}
      {cart.leadTimeText ? <p className="text-sm text-ink-secondary">{cart.leadTimeText}</p> : null}
      <p className="text-sm text-ink-secondary" id="cart-shipping-note">
        {cart.shippingNote}
      </p>
      <StoreButton
        aria-disabled="true"
        aria-describedby="cart-shipping-note"
        data-checkout
        className="w-full whitespace-normal text-center"
      >
        {cart.checkoutNote}
      </StoreButton>
    </section>
  );
}

function EmptyCart({ variant }: { variant: "drawer" | "page" }) {
  return (
    <div className="flex flex-col items-start gap-4 px-gutter py-10" data-cart-empty>
      <h2 className="heading-display text-2xl">{m.empty}</h2>
      <p className="text-ink-secondary">{m.emptyLede}</p>
      <Link
        href="/magazin"
        onClick={variant === "drawer" ? closeDrawer : undefined}
        className={storeButtonVariants({ variant: "primary" })}
      >
        {m.continueShopping}
      </Link>
    </div>
  );
}

/**
 * Conținutul coșului, comun sertarului și paginii `/cos`: liniile (selector în pași, scoatere, probleme cu acțiune clară) și
 * sumarul. Se încarcă de la server la montare; cât durează, afișează «Se încarcă».
 */
export function CartPanel({ variant }: { variant: "drawer" | "page" }) {
  const { cart, loading, loadFailed, busy } = useCartState();
  useEffect(() => {
    void loadCart();
  }, []);

  if (!cart) {
    return (
      <div className="px-gutter py-10" aria-busy={loading}>
        {loadFailed ? (
          <div className="flex flex-col items-start gap-3" role="alert">
            <p>{m.loadFailed}</p>
            <StoreButton variant="secondary" onClick={() => void loadCart()}>
              {m.retry}
            </StoreButton>
          </div>
        ) : (
          <p className="text-ink-secondary">{m.loading}</p>
        )}
      </div>
    );
  }
  if (cart.lines.length === 0) return <EmptyCart variant={variant} />;

  return (
    <div
      className={cn(
        "flex flex-col gap-6",
        variant === "page" ? "lg:grid lg:grid-cols-12 lg:gap-12" : "px-gutter py-2",
      )}
      data-cart-panel={variant}
    >
      <ul
        aria-label={m.linesLabel}
        className={cn(
          "flex flex-col divide-y divide-line-subtle",
          variant === "page" && "lg:col-span-8",
        )}
      >
        {cart.lines.map((line) => (
          <CartLine key={line.variantId} line={line} busy={busy} />
        ))}
      </ul>
      <div className={cn(variant === "page" ? "lg:col-span-4" : "pb-6")}>
        <div className={cn(variant === "page" && "rounded-card bg-card p-6 lg:sticky lg:top-28")}>
          <OrderSummary cart={cart} />
          {variant === "drawer" ? (
            <Link
              href="/cos"
              onClick={closeDrawer}
              className={cn(storeButtonVariants({ variant: "secondary" }), "mt-3 w-full")}
            >
              {m.viewCart}
            </Link>
          ) : (
            <Link
              href="/magazin"
              className={cn(storeButtonVariants({ variant: "secondary" }), "mt-3 w-full")}
            >
              {m.continueShopping}
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
