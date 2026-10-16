"use client";

import type { Dispatch, SetStateAction } from "react";
import type { WooAnalysis, WooOptions, WooReportSection } from "@ecom/core";
import { Label, Select } from "@ecom/ui";
import { getMessages } from "@/messages";

const m = getMessages().admin.productImport.woo;

const SHIPPING_CLASSES = ["standard", "oversized", "pallet"] as const;

/** Tipurile de rânduri din fișier, într-o propoziție: «9 simple, 1 variabile, 3 variații». */
export function describeRowTypes(rowTypes: Record<string, number>): string {
  return Object.entries(rowTypes)
    .map(([type, count]) => `${count} ${m.typeLabels[type] ?? type}`)
    .join(", ");
}

/**
 * Opțiunile profilului WooCommerce, alese la pasul de mapare: starea, unitățile, corespondența claselor
 * de livrare și a atributelor. Coloanele nu se mapează manual: se recunosc după antet pe server.
 */
export function WooOptionsPanel({
  analysis,
  options,
  onChange,
}: {
  analysis: WooAnalysis;
  options: WooOptions;
  onChange: Dispatch<SetStateAction<WooOptions | null>>;
}) {
  const update = (patch: Partial<WooOptions>) =>
    onChange((current) => (current ? { ...current, ...patch } : current));

  return (
    <div className="flex flex-col gap-5" data-woo-options>
      <p className="text-sm text-muted-foreground">{m.intro}</p>
      <p className="text-sm" data-woo-row-types>
        {m.rowTypes(describeRowTypes(analysis.rowTypes))}
      </p>

      <fieldset className="flex flex-col gap-1">
        <label className="flex items-start gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="mt-1 size-4 shrink-0 accent-primary"
            checked={options.keepStatus}
            onChange={(event) => update({ keepStatus: event.target.checked })}
            aria-describedby="woo-status-help"
            data-woo-keep-status
          />
          <span>{m.status.label}</span>
        </label>
        <p id="woo-status-help" className="pl-6 text-xs text-muted-foreground">
          {m.status.help}
        </p>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-sm font-semibold">{m.units.heading}</legend>
        <div className="flex flex-col gap-1">
          <Label htmlFor="woo-weight-unit">{m.units.weight}</Label>
          <Select
            id="woo-weight-unit"
            value={options.weightUnit}
            onChange={(event) =>
              update({ weightUnit: event.target.value as WooOptions["weightUnit"] })
            }
          >
            {Object.entries(m.units.weightOptions).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
          {analysis.units.weight && (
            <p className="text-xs text-muted-foreground">
              {m.units.fromHeader(analysis.units.weight)}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="woo-dimension-unit">{m.units.dimensions}</Label>
          <Select
            id="woo-dimension-unit"
            value={options.dimensionUnit}
            onChange={(event) =>
              update({ dimensionUnit: event.target.value as WooOptions["dimensionUnit"] })
            }
          >
            {Object.entries(m.units.dimensionOptions).map(([value, text]) => (
              <option key={value} value={value}>
                {text}
              </option>
            ))}
          </Select>
          {analysis.units.dimensions && (
            <p className="text-xs text-muted-foreground">
              {m.units.fromHeader(analysis.units.dimensions)}
            </p>
          )}
        </div>
      </fieldset>

      {analysis.shippingClasses.length > 0 && (
        <section aria-labelledby="woo-shipping" className="flex flex-col gap-2">
          <h3 id="woo-shipping" className="text-sm font-semibold">
            {m.shipping.heading}
          </h3>
          <p className="text-xs text-muted-foreground">{m.shipping.help}</p>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[32rem] text-left text-sm" data-woo-shipping>
              <thead className="border-b border-border bg-border/30">
                <tr>
                  <th scope="col" className="p-3 font-medium">
                    {m.shipping.column}
                  </th>
                  <th scope="col" className="p-3 font-medium">
                    {m.shipping.target}
                  </th>
                </tr>
              </thead>
              <tbody>
                {analysis.shippingClasses.map((item) => (
                  <tr key={item.key} className="border-b border-border last:border-0">
                    <th scope="row" className="p-3 font-medium">
                      {item.name}{" "}
                      <span className="font-normal text-muted-foreground">
                        ({m.shipping.products(item.count)})
                      </span>
                    </th>
                    <td className="p-3">
                      <Label htmlFor={`woo-ship-${item.key}`} className="sr-only">
                        {`${m.shipping.target}: ${item.name}`}
                      </Label>
                      <Select
                        id={`woo-ship-${item.key}`}
                        value={options.shippingClassMap[item.key] ?? ""}
                        onChange={(event) =>
                          update({
                            shippingClassMap: withoutKey(
                              options.shippingClassMap,
                              item.key,
                              event.target.value as WooOptions["shippingClassMap"][string] | "",
                            ),
                          })
                        }
                      >
                        <option value="">{m.shipping.none}</option>
                        {SHIPPING_CLASSES.map((value) => (
                          <option key={value} value={value}>
                            {m.shipping.classes[value]}
                          </option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {analysis.attributes.length > 0 && (
        <section aria-labelledby="woo-attributes" className="flex flex-col gap-2">
          <h3 id="woo-attributes" className="text-sm font-semibold">
            {m.attributes.heading}
          </h3>
          <p className="text-xs text-muted-foreground">{m.attributes.help}</p>
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[32rem] text-left text-sm" data-woo-attributes>
              <thead className="border-b border-border bg-border/30">
                <tr>
                  <th scope="col" className="p-3 font-medium">
                    {m.attributes.column}
                  </th>
                  <th scope="col" className="p-3 font-medium">
                    {m.attributes.target}
                  </th>
                </tr>
              </thead>
              <tbody>
                {analysis.attributes.map((item) => (
                  <tr key={item.key} className="border-b border-border last:border-0">
                    <th scope="row" className="p-3 font-medium">
                      {item.name}{" "}
                      <span className="font-normal text-muted-foreground">
                        ({m.attributes.products(item.count)})
                      </span>
                    </th>
                    <td className="p-3">
                      <Label htmlFor={`woo-attr-${item.key}`} className="sr-only">
                        {`${m.attributes.target}: ${item.name}`}
                      </Label>
                      <Select
                        id={`woo-attr-${item.key}`}
                        value={options.attributeTargets[item.key] ?? item.existingId ?? "create"}
                        onChange={(event) =>
                          update({
                            attributeTargets: {
                              ...options.attributeTargets,
                              [item.key]: event.target.value,
                            },
                          })
                        }
                      >
                        <option value="create">{m.attributes.create}</option>
                        {analysis.existingAttributes.map((attribute) => (
                          <option key={attribute.id} value={attribute.id}>
                            {m.attributes.existing(attribute.name)}
                          </option>
                        ))}
                        <option value="ignore">{m.attributes.ignore}</option>
                      </Select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(analysis.ignoredColumns.length > 0 || analysis.blockedColumns.length > 0) && (
        <details className="rounded-md border border-border p-3 text-sm" data-woo-columns>
          <summary className="cursor-pointer font-medium">{m.columns.heading}</summary>
          <p className="mt-2 text-xs text-muted-foreground">{m.columns.help}</p>
          {analysis.blockedColumns.length > 0 && (
            <p className="mt-2 text-xs" data-woo-blocked>
              <strong>{m.columns.blocked}</strong>
              {analysis.blockedColumns.join(", ")}
            </p>
          )}
          <ul className="mt-2 list-disc pl-5 text-xs">
            {analysis.ignoredColumns.map((column) => (
              <li key={column.header}>
                <span className="font-medium">{column.header}</span> — {column.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Setează sau scoate o cheie dintr-un obiect (valoarea goală = fără corespondent). */
function withoutKey<V extends string>(
  map: Record<string, V>,
  key: string,
  value: V | "",
): Record<string, V> {
  const next = { ...map };
  if (value === "") delete next[key];
  else next[key] = value;
  return next;
}

/** Ce creează importul WooCommerce și constatările lui, în raport (la verificare și după aplicare). */
export function WooReportExtras({ woo }: { woo: WooReportSection }) {
  const nothing =
    woo.categoriesToCreate.length + woo.brandsToCreate.length + woo.attributesToCreate.length === 0;
  const stats = Object.entries(woo.stats).filter(
    ([key, value]) =>
      value > 0 && !["categoriesToCreate", "brandsToCreate", "attributesToCreate"].includes(key),
  );
  return (
    <div className="flex flex-col gap-4 rounded-md border border-border p-3" data-woo-report>
      <h3 className="text-sm font-semibold">{m.report.heading}</h3>
      {nothing ? (
        <p className="text-sm text-muted-foreground">{m.report.none}</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">{m.report.confirmNote}</p>
          {(
            [
              [
                "categories",
                m.report.categories(woo.categoriesToCreate.length),
                woo.categoriesToCreate,
              ],
              ["brands", m.report.brands(woo.brandsToCreate.length), woo.brandsToCreate],
              [
                "attributes",
                m.report.attributes(woo.attributesToCreate.length),
                woo.attributesToCreate,
              ],
            ] as const
          ).map(([key, label, items]) =>
            items.length > 0 ? (
              <div key={key} data-woo-create={key}>
                <h4 className="text-sm font-medium">{label}</h4>
                <ul className="list-disc pl-5 text-sm">
                  {items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </>
      )}
      <div>
        <h4 className="text-sm font-medium">{m.report.rowTypes}</h4>
        <p className="text-sm">{describeRowTypes(woo.rowTypes)}</p>
      </div>
      {stats.length > 0 && (
        <div>
          <h4 className="text-sm font-medium">{m.report.statsHeading}</h4>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2" data-woo-stats>
            {stats.map(([key, value]) => (
              <div key={key} className="flex justify-between gap-2 border-b border-border py-0.5">
                <dt className="text-muted-foreground">{m.report.stats[key] ?? key}</dt>
                <dd className="font-medium" data-woo-stat={key}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </div>
  );
}
