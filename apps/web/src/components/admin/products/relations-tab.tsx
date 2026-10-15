"use client";

import { ArrowDown, ArrowUp, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Button, Input, Select } from "@ecom/ui";
import {
  addProductRelation,
  removeProductRelation,
  reorderProductRelations,
  searchRelatedProducts,
} from "@/app/(admin)/admin/produse/editor-actions";
import type { ProductActionFailure } from "@/lib/product-action-support";
import { getMessages } from "@/messages";
import type { EditorCaps, EditorRelation } from "./editor-types";
import { Field } from "./editor-ui";

const m = getMessages().admin.products;
const e = m.editor;
const r = e.relations;

type RelationType = keyof typeof r.types;
const TYPES = Object.keys(r.types) as RelationType[];

interface SearchHit {
  id: string;
  title: string;
  sku: string | null;
  status: string;
}

function failureText(result: ProductActionFailure): string {
  const errors = m.errors as Record<string, string>;
  return result.message ?? errors[result.code] ?? e.common.generic;
}

/**
 * Tabul Asociate. Relațiile sunt NESIMETRICE (principal → asociat) și se văd din ambele părți: aici,
 * „din acest produs către altele” (le poți ordona) și „din alte produse către acesta” (le poți șterge,
 * fiind același rând). Produsul asociat se caută după titlu sau SKU. Cere `products.write`.
 */
export function RelationsTab({
  productId,
  initial,
  caps,
}: {
  productId: string;
  initial: readonly EditorRelation[];
  caps: EditorCaps;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [relations, setRelations] = useState<EditorRelation[]>([...initial]);
  const [type, setType] = useState<RelationType>("accessory");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const editable = caps.canWrite;

  const outgoing = relations.filter((x) => x.direction === "outgoing");
  const incoming = relations.filter((x) => x.direction === "incoming");

  /** Rulează o acțiune care întoarce lista nouă de relații. */
  const mutate = (
    run: () => Promise<{ ok: true; relations: EditorRelation[] } | ProductActionFailure>,
    message: string,
  ) => {
    setProblem(null);
    setStatus(null);
    startTransition(async () => {
      try {
        const result = await run();
        if (result.ok) {
          setRelations(result.relations);
          setStatus(message);
          router.refresh();
        } else {
          setProblem(failureText(result));
        }
      } catch {
        setProblem(e.common.generic);
      }
    });
  };

  const search = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    setSearching(true);
    try {
      const result = await searchRelatedProducts({ q: query.trim(), excludeId: productId });
      if (result.ok) setHits(result.results);
      else setProblem(failureText(result));
    } catch {
      setProblem(e.common.generic);
    } finally {
      setSearching(false);
    }
  };

  const move = (relationType: string, index: number, delta: -1 | 1) => {
    const group = outgoing.filter((x) => x.type === relationType);
    const target = index + delta;
    if (target < 0 || target >= group.length) return;
    const ids = group.map((x) => x.id);
    const [moved] = ids.splice(index, 1);
    if (!moved) return;
    ids.splice(target, 0, moved);
    mutate(
      () => reorderProductRelations({ id: productId, type: relationType, orderedIds: ids }),
      e.common.saved,
    );
  };

  const statusNote = (product: EditorRelation["product"]): string =>
    product.deleted
      ? r.deleted
      : product.status === "draft"
        ? r.draft
        : product.status === "archived"
          ? r.archived
          : "";

  const row = (rel: EditorRelation, index: number, group: EditorRelation[]) => (
    <li
      key={rel.id}
      data-relation-row={`${rel.direction}:${rel.type}`}
      className="flex flex-wrap items-center gap-3 rounded-md border border-border p-2"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <Link
          href={`/admin/produse/${rel.product.id}`}
          aria-label={r.open(rel.product.title)}
          className="truncate text-sm font-medium text-primary underline-offset-2 hover:underline"
        >
          {rel.product.title}
        </Link>
        <span className="text-xs text-muted-foreground">
          {[rel.product.sku, statusNote(rel.product)].filter(Boolean).join(" · ")}
        </span>
      </div>
      {editable && (
        <div className="flex gap-1">
          {rel.direction === "outgoing" && (
            <>
              <Button
                type="button"
                variant="outline"
                disabled={pending || index === 0}
                aria-label={r.moveUp(rel.product.title)}
                onClick={() => move(rel.type, index, -1)}
              >
                <ArrowUp aria-hidden className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending || index === group.length - 1}
                aria-label={r.moveDown(rel.product.title)}
                onClick={() => move(rel.type, index, 1)}
              >
                <ArrowDown aria-hidden className="h-4 w-4" />
              </Button>
            </>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            aria-label={r.remove(rel.product.title)}
            onClick={() =>
              mutate(() => removeProductRelation({ id: productId, relationId: rel.id }), r.removed)
            }
          >
            <X aria-hidden className="h-4 w-4" />
          </Button>
        </div>
      )}
    </li>
  );

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <h2 className="text-lg font-semibold">{r.heading}</h2>
      <p className="text-sm text-muted-foreground">{r.help}</p>

      <p role="status" className="text-sm text-muted-foreground">
        {status}
      </p>
      {problem && (
        <p
          role="alert"
          data-problem
          className="rounded-md border border-danger p-3 text-sm text-danger"
        >
          {problem}
        </p>
      )}

      {editable && (
        <section
          aria-labelledby="relation-add"
          className="flex flex-col gap-3 rounded-md border border-border p-4"
        >
          <h3 id="relation-add" className="text-base font-semibold">
            {r.add}
          </h3>
          <Field id="relation-type" label={r.type} help={r.typeHelp[type]}>
            {(control) => (
              <Select
                {...control}
                value={type}
                onChange={(ev) => setType(ev.target.value as RelationType)}
              >
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {r.types[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <form onSubmit={search} className="flex flex-wrap items-end gap-2">
            <div className="min-w-[14rem] flex-1">
              <Field id="relation-search" label={r.search}>
                {(control) => (
                  <Input
                    {...control}
                    value={query}
                    onChange={(ev) => setQuery(ev.target.value)}
                    autoComplete="off"
                    maxLength={100}
                  />
                )}
              </Field>
            </div>
            <Button type="submit" variant="outline" disabled={searching || query.trim().length < 2}>
              {searching ? r.searching : r.searchButton}
            </Button>
          </form>
          {hits !== null &&
            (hits.length === 0 ? (
              <p className="text-sm text-muted-foreground">{r.noResults}</p>
            ) : (
              <ul className="flex flex-col gap-1" aria-label={r.search}>
                {hits.map((hit) => (
                  <li key={hit.id} className="flex flex-wrap items-center gap-3">
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {hit.title}
                      <span className="text-muted-foreground">
                        {hit.sku ? ` · ${hit.sku}` : ""}
                      </span>
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={pending}
                      aria-label={r.addButton(hit.title)}
                      onClick={() =>
                        mutate(
                          () =>
                            addProductRelation({
                              id: productId,
                              relatedProductId: hit.id,
                              type,
                            }),
                          r.added,
                        )
                      }
                    >
                      {r.addAction}
                    </Button>
                  </li>
                ))}
              </ul>
            ))}
        </section>
      )}

      <section aria-labelledby="relations-out" className="flex flex-col gap-3">
        <h3 id="relations-out" className="text-base font-semibold">
          {r.outgoing}
        </h3>
        {outgoing.length === 0 ? (
          <p className="text-sm text-muted-foreground">{r.noneOutgoing}</p>
        ) : (
          TYPES.filter((t) => outgoing.some((x) => x.type === t)).map((t) => {
            const group = outgoing.filter((x) => x.type === t);
            return (
              <div key={t} className="flex flex-col gap-2">
                <h4 className="text-sm font-medium">{r.types[t]}</h4>
                <ul className="flex flex-col gap-2">{group.map((rel, i) => row(rel, i, group))}</ul>
              </div>
            );
          })
        )}
      </section>

      <section aria-labelledby="relations-in" className="flex flex-col gap-3">
        <h3 id="relations-in" className="text-base font-semibold">
          {r.incoming}
        </h3>
        {incoming.length === 0 ? (
          <p className="text-sm text-muted-foreground">{r.noneIncoming}</p>
        ) : (
          TYPES.filter((t) => incoming.some((x) => x.type === t)).map((t) => {
            const group = incoming.filter((x) => x.type === t);
            return (
              <div key={t} className="flex flex-col gap-2">
                <h4 className="text-sm font-medium">{r.types[t]}</h4>
                <ul className="flex flex-col gap-2">{group.map((rel, i) => row(rel, i, group))}</ul>
              </div>
            );
          })
        )}
      </section>

      {!editable && <p className="text-sm text-muted-foreground">{e.common.readOnlyTab}</p>}
    </div>
  );
}
