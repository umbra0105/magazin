"use client";

import type { Dispatch, SetStateAction } from "react";
import type { WooAnalysis, WooOptions, WooReportSection } from "@ecom/core";
import { Label, RowHeader, Select, TBody, THead, Table, Td, Th, Tr } from "@ecom/ui";
import { getMessages } from "@/messages";

const m = getMessages().admin.productImport.woo;

const SHIPPING_CLASSES = ["standard", "oversized", "pallet"] as const;

/** Contoarele modului «doar descrieri» se arată într-un bloc propriu, nu în lista de constatări. */
const DESCRIPTION_COUNTER_STATS = [
  "productsNotFound",
  "descriptionsKeptEdited",
  "descriptionsKeptNoHistory",
  "descriptionsOverLimit",
];

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
      <p className="text-body text-ink-secondary">{m.intro}</p>
      <p className="text-body" data-woo-row-types>
        {m.rowTypes(describeRowTypes(analysis.rowTypes))}
      </p>

      <fieldset className="flex flex-col gap-2" data-woo-mode>
        <legend className="mb-1 text-body font-semibold">{m.mode.heading}</legend>
        {(["full", "descriptionsOnly"] as const).map((value) => (
          <label key={value} className="flex items-start gap-2 text-body">
            <input
              type="radio"
              name="woo-mode"
              className="mt-1 size-4 shrink-0 accent-brand"
              checked={options.mode === value}
              onChange={() => update({ mode: value })}
              data-woo-mode-option={value}
            />
            <span>{m.mode[value]}</span>
          </label>
        ))}
        {options.mode === "descriptionsOnly" && (
          <div className="flex flex-col gap-2 pl-6" data-woo-descriptions-only>
            <p className="text-label text-ink-secondary">{m.mode.descriptionsOnlyHelp}</p>
            <label className="flex items-start gap-2 text-body font-medium">
              <input
                type="checkbox"
                className="mt-1 size-4 shrink-0 accent-brand"
                checked={options.overwriteEditedDescriptions}
                onChange={(event) => update({ overwriteEditedDescriptions: event.target.checked })}
                aria-describedby="woo-overwrite-help"
                data-woo-overwrite-edited
              />
              <span>{m.mode.overwrite}</span>
            </label>
            <p id="woo-overwrite-help" className="pl-6 text-label text-ink-secondary">
              {m.mode.overwriteHelp}
            </p>
          </div>
        )}
      </fieldset>

      {options.mode === "full" && (
        <WooFullOptions analysis={analysis} options={options} update={update} />
      )}
    </div>
  );
}

/** Opțiunile importului obișnuit (nu se arată în modul «doar descrieri», unde nu au efect). */
function WooFullOptions({
  analysis,
  options,
  update,
}: {
  analysis: WooAnalysis;
  options: WooOptions;
  update: (patch: Partial<WooOptions>) => void;
}) {
  return (
    <>
      <fieldset className="flex flex-col gap-1">
        <label className="flex items-start gap-2 text-body font-medium">
          <input
            type="checkbox"
            className="mt-1 size-4 shrink-0 accent-brand"
            checked={options.keepStatus}
            onChange={(event) => update({ keepStatus: event.target.checked })}
            aria-describedby="woo-status-help"
            data-woo-keep-status
          />
          <span>{m.status.label}</span>
        </label>
        <p id="woo-status-help" className="pl-6 text-label text-ink-secondary">
          {m.status.help}
        </p>
      </fieldset>

      {analysis.images.hasColumn && (
        <fieldset className="flex flex-col gap-2" data-woo-images>
          <legend className="mb-1 text-body font-semibold">{m.images.heading}</legend>
          <p className="text-body">
            {m.images.found(
              analysis.images.total,
              analysis.images.onAllowedHosts,
              analysis.images.onOtherHosts,
              analysis.images.invalid,
            )}
          </p>
          {analysis.images.hosts.length > 0 && (
            <div>
              <h3 className="text-label font-medium text-ink-secondary">{m.images.hostsHeading}</h3>
              <ul className="list-disc pl-5 text-body" data-woo-image-hosts>
                {analysis.images.hosts.map((host) => (
                  <li key={host.host} data-image-host={host.host} data-allowed={host.allowed}>
                    {m.images.hostLine(host.host, host.count, host.allowed)}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!analysis.images.canImport ? (
            <p
              role="note"
              className="rounded-lg bg-surface-subtle p-3 text-body"
              data-images-no-right
            >
              {m.images.noRight}
            </p>
          ) : (
            <>
              {analysis.images.allowedHosts.length === 0 && (
                <p
                  role="note"
                  className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
                  data-images-no-hosts
                >
                  {m.images.noHosts}
                </p>
              )}
              <label className="flex items-start gap-2 text-body font-medium">
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0 accent-brand"
                  checked={options.importImages}
                  onChange={(event) => update({ importImages: event.target.checked })}
                  aria-describedby="woo-images-help"
                  data-woo-import-images
                />
                <span>{m.images.checkbox}</span>
              </label>
              <p id="woo-images-help" className="pl-6 text-label text-ink-secondary">
                {m.images.help}
              </p>
            </>
          )}
        </fieldset>
      )}

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-1 text-body font-semibold">{m.units.heading}</legend>
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
            <p className="text-label text-ink-secondary">
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
            <p className="text-label text-ink-secondary">
              {m.units.fromHeader(analysis.units.dimensions)}
            </p>
          )}
        </div>
      </fieldset>

      {analysis.shippingClasses.length > 0 && (
        <section aria-labelledby="woo-shipping" className="flex flex-col gap-2">
          <h3 id="woo-shipping" className="text-body font-semibold">
            {m.shipping.heading}
          </h3>
          <p className="text-label text-ink-secondary">{m.shipping.help}</p>
          <Table stacked aria-label={m.shipping.heading} data-woo-shipping>
            <THead>
              <Tr>
                <Th>{m.shipping.column}</Th>
                <Th>{m.shipping.target}</Th>
              </Tr>
            </THead>
            <TBody>
              {analysis.shippingClasses.map((item) => (
                <Tr key={item.key}>
                  <RowHeader className="font-medium">
                    {item.name}{" "}
                    <span className="font-normal text-ink-secondary">
                      ({m.shipping.products(item.count)})
                    </span>
                  </RowHeader>
                  <Td stack="actions" className="py-2">
                    <Label htmlFor={`woo-ship-${item.key}`} className="sr-only">
                      {`${m.shipping.target}: ${item.name}`}
                    </Label>
                    <Select
                      className="max-w-md"
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
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </section>
      )}

      {analysis.attributes.length > 0 && (
        <section aria-labelledby="woo-attributes" className="flex flex-col gap-2">
          <h3 id="woo-attributes" className="text-body font-semibold">
            {m.attributes.heading}
          </h3>
          <p className="text-label text-ink-secondary">{m.attributes.help}</p>
          <Table stacked aria-label={m.attributes.heading} data-woo-attributes>
            <THead>
              <Tr>
                <Th>{m.attributes.column}</Th>
                <Th>{m.attributes.target}</Th>
              </Tr>
            </THead>
            <TBody>
              {analysis.attributes.map((item) => (
                <Tr key={item.key}>
                  <RowHeader className="font-medium">
                    {item.name}{" "}
                    <span className="font-normal text-ink-secondary">
                      ({m.attributes.products(item.count)})
                    </span>
                  </RowHeader>
                  <Td stack="actions" className="py-2">
                    <Label htmlFor={`woo-attr-${item.key}`} className="sr-only">
                      {`${m.attributes.target}: ${item.name}`}
                    </Label>
                    <Select
                      className="max-w-md"
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
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </section>
      )}

      {(analysis.ignoredColumns.length > 0 || analysis.blockedColumns.length > 0) && (
        <details className="rounded-lg border border-line-subtle p-3 text-body" data-woo-columns>
          <summary className="cursor-pointer font-medium">{m.columns.heading}</summary>
          <p className="mt-2 text-label text-ink-secondary">{m.columns.help}</p>
          {analysis.blockedColumns.length > 0 && (
            <p className="mt-2 text-label" data-woo-blocked>
              <strong>{m.columns.blocked}</strong>
              {analysis.blockedColumns.join(", ")}
            </p>
          )}
          <ul className="mt-2 list-disc pl-5 text-label">
            {analysis.ignoredColumns.map((column) => (
              <li key={column.header}>
                <span className="font-medium">{column.header}</span> — {column.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
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

/** Imaginile din fișier, fără nicio adresă completă: câte, de pe ce domenii, ce se respinge și de ce. */
function WooImageReport({ images }: { images: NonNullable<WooReportSection["images"]> }) {
  const r = m.report.images;
  const { stats } = images;
  const extra = Object.entries(stats).filter(
    ([key, value]) => typeof value === "number" && value > 0 && key in r.stats,
  ) as [string, number][];
  return (
    <div className="flex flex-col gap-2" data-woo-images-report>
      <h4 className="text-body font-medium">{r.heading}</h4>
      {!images.enabled ? (
        <p className="text-body text-ink-secondary">{r.off}</p>
      ) : (
        <>
          <p className="text-body" data-images-summary>
            {r.summary(stats.total, stats.accepted, stats.rejected)}
          </p>
          {extra.length > 0 && (
            <ul className="list-disc pl-5 text-body">
              {extra.map(([key, value]) => (
                <li key={key} data-images-stat={key}>
                  {r.stats[key]}: {value}
                </li>
              ))}
            </ul>
          )}
          {Object.keys(stats.byHost).length > 0 && (
            <div>
              <h5 className="text-label font-medium text-ink-secondary">{r.hostsHeading}</h5>
              <ul className="list-disc pl-5 text-body" data-images-hosts>
                {Object.entries(stats.byHost).map(([host, count]) => (
                  <li key={host}>
                    {host}: {count}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {Object.keys(stats.rejectedByReason).length > 0 && (
            <div>
              <h5 className="text-label font-medium text-ink-secondary">{r.reasonsHeading}</h5>
              <ul className="list-disc pl-5 text-body" data-images-rejected>
                {Object.entries(stats.rejectedByReason).map(([reason, count]) => (
                  <li key={reason} data-images-reason={reason}>
                    {r.reasons[reason] ?? reason}: {count}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {images.issues.length > 0 && (
            <details className="rounded-lg border border-line-subtle p-2 text-body">
              <summary className="cursor-pointer font-medium">{r.issuesHeading}</summary>
              <div className="mt-2">
                <Table stacked aria-label={r.issuesHeading} data-images-issues>
                  <THead>
                    <Tr>
                      <Th numeric>{r.row}</Th>
                      <Th>{r.sku}</Th>
                      <Th>{r.host}</Th>
                      <Th>{r.reason}</Th>
                    </Tr>
                  </THead>
                  <TBody>
                    {images.issues.map((issue, index) => (
                      <Tr key={`${issue.row}-${index}`}>
                        <Td numeric>{issue.row}</Td>
                        <Td className="break-all">{issue.sku || "—"}</Td>
                        <Td className="break-all">{issue.host ?? "—"}</Td>
                        <Td stack="title">{issue.message}</Td>
                      </Tr>
                    ))}
                  </TBody>
                </Table>
              </div>
              {images.issuesTruncated && (
                <p className="mt-1 text-label text-ink-secondary">{r.truncated}</p>
              )}
            </details>
          )}
        </>
      )}
    </div>
  );
}

/** Ce creează importul WooCommerce și constatările lui, în raport (la verificare și după aplicare). */
export function WooReportExtras({ woo }: { woo: WooReportSection }) {
  const nothing =
    woo.categoriesToCreate.length + woo.brandsToCreate.length + woo.attributesToCreate.length === 0;
  const hiddenStats = woo.descriptionsOnly
    ? [...DESCRIPTION_COUNTER_STATS, "categoriesToCreate", "brandsToCreate", "attributesToCreate"]
    : ["categoriesToCreate", "brandsToCreate", "attributesToCreate"];
  const stats = Object.entries(woo.stats).filter(
    ([key, value]) => value > 0 && !hiddenStats.includes(key),
  );
  const counters = woo.descriptionsOnly
    ? ([
        ["updated", woo.descriptionsOnly.updated],
        ["keptEdited", woo.stats.descriptionsKeptEdited],
        ["keptNoHistory", woo.stats.descriptionsKeptNoHistory],
        ["notFound", woo.stats.productsNotFound],
        ["overLimit", woo.stats.descriptionsOverLimit],
      ] as const)
    : null;
  return (
    <div className="flex flex-col gap-4 rounded-lg border border-line-subtle p-3" data-woo-report>
      <h3 className="text-body font-semibold">{m.report.heading}</h3>
      {counters && (
        <div data-woo-desc-counters>
          <h4 className="text-body font-medium">{m.report.descriptions.heading}</h4>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-body sm:grid-cols-2">
            {counters.map(([key, value]) => (
              <div
                key={key}
                className="flex justify-between gap-2 border-b border-line-subtle py-0.5"
              >
                <dt className="text-ink-secondary">{m.report.descriptions[key]}</dt>
                <dd className="font-medium" data-woo-desc-counter={key}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {nothing ? (
        <p className="text-body text-ink-secondary">{m.report.none}</p>
      ) : (
        <>
          <p className="text-label text-ink-secondary">{m.report.confirmNote}</p>
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
                <h4 className="text-body font-medium">{label}</h4>
                <ul className="list-disc pl-5 text-body">
                  {items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
            ) : null,
          )}
        </>
      )}
      {woo.images && woo.images.stats.total > 0 && <WooImageReport images={woo.images} />}
      <div>
        <h4 className="text-body font-medium">{m.report.rowTypes}</h4>
        <p className="text-body">{describeRowTypes(woo.rowTypes)}</p>
      </div>
      {stats.length > 0 && (
        <div>
          <h4 className="text-body font-medium">{m.report.statsHeading}</h4>
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-body sm:grid-cols-2" data-woo-stats>
            {stats.map(([key, value]) => (
              <div
                key={key}
                className="flex justify-between gap-2 border-b border-line-subtle py-0.5"
              >
                <dt className="text-ink-secondary">{m.report.stats[key] ?? key}</dt>
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
