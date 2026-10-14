import type { PermissionSubject } from "@ecom/core";
import { can } from "@ecom/core";
import { Button, Input, Label } from "@ecom/ui";
import { savePurchasePrice } from "@/app/(admin)/admin/produse/purchase-actions";
import { formatMoneyInput } from "@/lib/money-input";
import { getPurchasePriceService } from "@/lib/purchase-price";
import { getMessages } from "@/messages";

const p = getMessages().admin.products.editor.purchase;

/**
 * Panoul prețului de achiziție (NIR, fără TVA), din tabul Prețuri. COMPONENTĂ DE SERVER: citește
 * valoarea și o pune în `defaultValue` al câmpului, într-un formular cu server action. Nu e client și
 * nu primește costul ca props; la utilizatorii fără `products.cost.view` NU se randează deloc (nici
 * gol, nici ascuns): valoarea nu există în HTML-ul paginii. Editabil doar cu `products.cost.edit`;
 * cu doar `view`, câmpul e doar pentru citire.
 */
export async function PurchasePanel({
  subject,
  productId,
  variants,
  status,
}: {
  subject: PermissionSubject;
  productId: string;
  variants: readonly { id: string; sku: string }[];
  /** Codul de stare al ultimei salvări (din URL), fără valori. */
  status: string | null;
}) {
  if (!can(subject, "products.cost.view")) return null;
  const editable = can(subject, "products.cost.edit");
  const service = getPurchasePriceService();
  const today = new Date().toISOString().slice(0, 10);

  const rows = await Promise.all(
    variants.map(async (variant) => {
      const [current, history] = await Promise.all([
        service.getCost(subject, variant.id),
        service.getHistory(subject, variant.id),
      ]);
      return { variant, current, history: history.slice(0, 10) };
    }),
  );

  const message =
    status === "saved"
      ? p.saved
      : status === "history"
        ? p.savedHistoryOnly
        : status === "invalid"
          ? p.invalid
          : status === "failed"
            ? p.failed
            : null;

  return (
    <section
      aria-labelledby="purchase-heading"
      className="flex flex-col gap-4 border-t border-border pt-6"
    >
      <h2 id="purchase-heading" className="text-lg font-semibold">
        {p.heading}
      </h2>
      <p className="text-sm text-muted-foreground">{p.description}</p>
      {!editable && <p className="text-sm text-muted-foreground">{p.readOnly}</p>}
      {message && (
        <p
          role={status === "saved" || status === "history" ? "status" : "alert"}
          data-purchase-status={status}
          className="rounded-md border border-border bg-border/30 p-3 text-sm"
        >
          {message}
        </p>
      )}

      {rows.map(({ variant, current, history }) => (
        <div key={variant.id} className="flex flex-col gap-3 rounded-md border border-border p-4">
          <h3 className="text-sm font-medium">{p.variant(variant.sku)}</h3>
          <form
            action={savePurchasePrice}
            className="grid items-end gap-4 sm:grid-cols-[1fr_1fr_auto]"
          >
            <input type="hidden" name="productId" value={productId} />
            <input type="hidden" name="variantId" value={variant.id} />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`purchase-amount-${variant.id}`}>{p.amount}</Label>
              <Input
                id={`purchase-amount-${variant.id}`}
                name="amount"
                inputMode="decimal"
                autoComplete="off"
                defaultValue={current.costPrice === null ? "" : formatMoneyInput(current.costPrice)}
                readOnly={!editable}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`purchase-date-${variant.id}`}>{p.date}</Label>
              <Input
                id={`purchase-date-${variant.id}`}
                name="date"
                type="date"
                defaultValue={
                  current.costPriceDate ? current.costPriceDate.toISOString().slice(0, 10) : today
                }
                readOnly={!editable}
              />
            </div>
            {editable && <Button type="submit">{p.save}</Button>}
          </form>

          <details className="text-sm">
            <summary className="cursor-pointer font-medium">{p.history}</summary>
            {history.length === 0 ? (
              <p className="mt-2 text-muted-foreground">{p.historyEmpty}</p>
            ) : (
              <table className="mt-2 w-full">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th scope="col" className="py-1 pr-4 font-medium">
                      {p.historyDate}
                    </th>
                    <th scope="col" className="py-1 pr-4 font-medium">
                      {p.historyAmount}
                    </th>
                    <th scope="col" className="py-1 font-medium">
                      {p.historySource}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((entry) => (
                    <tr key={entry.id} className="border-b border-border">
                      <td className="py-1 pr-4">
                        {entry.effectiveDate.toISOString().slice(0, 10)}
                      </td>
                      <td className="py-1 pr-4">{formatMoneyInput(entry.costPrice)}</td>
                      <td className="py-1">
                        {(p.sources as Record<string, string>)[entry.source] ?? entry.source}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </details>
        </div>
      ))}
    </section>
  );
}
