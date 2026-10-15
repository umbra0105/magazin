"use client";

import { Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Select } from "@ecom/ui";
import {
  attachDiagramProduct,
  detachDiagramProduct,
} from "@/app/(admin)/admin/fise-explodate/actions";
import type { ProductActionFailure } from "@/lib/product-action-support";
import { getMessages } from "@/messages";
import type { EditorCaps } from "./editor-types";
import { Field } from "./editor-ui";

const m = getMessages().admin.products;
const e = m.editor;
const s = e.spareParts;

export interface SparePartsDiagram {
  id: string;
  title: string;
  hotspotCount: number;
  productCount: number;
  imageUrl: string | null;
}

function failureText(result: ProductActionFailure): string {
  const errors = getMessages().admin.diagrams.errors as Record<string, string>;
  return result.message ?? errors[result.code] ?? e.common.generic;
}

/**
 * Tabul „Piese de schimb” (apare doar cu flag-ul `partsDiagrams` pornit): fișele explodate asociate
 * produsului și asocierea uneia existente. Hotspot-urile și imaginea se editează în pagina Fișe
 * explodate. Asocierea cere `products.write` (re-verificat pe server).
 */
export function SparePartsTab({
  productId,
  initialAttached,
  initialAvailable,
  caps,
}: {
  productId: string;
  initialAttached: readonly SparePartsDiagram[];
  initialAvailable: readonly SparePartsDiagram[];
  caps: EditorCaps;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [attached, setAttached] = useState<SparePartsDiagram[]>([...initialAttached]);
  const [available, setAvailable] = useState<SparePartsDiagram[]>([...initialAvailable]);
  const [choice, setChoice] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const editable = caps.canWrite;

  const run = (
    action: () => Promise<{ ok: true } | ProductActionFailure>,
    after: () => void,
    message: string,
  ) => {
    setStatus(null);
    setProblem(null);
    startTransition(async () => {
      try {
        const result = await action();
        if (result.ok) {
          after();
          setStatus(message);
          router.refresh();
        } else setProblem(failureText(result));
      } catch {
        setProblem(e.common.generic);
      }
    });
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <h2 className="text-lg font-semibold">{s.heading}</h2>
      <p className="text-sm text-muted-foreground">{s.help}</p>
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

      <section aria-labelledby="spare-attached" className="flex flex-col gap-3">
        <h3 id="spare-attached" className="text-base font-semibold">
          {s.attached}
        </h3>
        {attached.length === 0 ? (
          <p className="text-sm text-muted-foreground">{s.none}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {attached.map((d) => (
              <li
                key={d.id}
                data-spare-diagram={d.title}
                className="flex flex-wrap items-center gap-3 rounded-md border border-border p-2"
              >
                {d.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element -- imagine din /media (variante generate)
                  <img
                    src={d.imageUrl}
                    alt=""
                    width={64}
                    height={48}
                    className="h-12 w-16 rounded-md border border-border object-cover"
                  />
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                  <Link
                    href={`/admin/fise-explodate/${d.id}`}
                    aria-label={s.open(d.title)}
                    className="truncate text-sm font-medium text-primary underline-offset-2 hover:underline"
                  >
                    {d.title}
                  </Link>
                  <span className="text-xs text-muted-foreground">
                    {s.meta(d.hotspotCount, d.productCount)}
                  </span>
                </div>
                {editable && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    aria-label={s.detach(d.title)}
                    onClick={() =>
                      run(
                        () => detachDiagramProduct({ diagramId: d.id, productId }),
                        () => {
                          setAttached((c) => c.filter((x) => x.id !== d.id));
                          setAvailable((c) =>
                            [...c, d].sort((a, b) => a.title.localeCompare(b.title, "ro")),
                          );
                        },
                        s.detachedDone,
                      )
                    }
                  >
                    <Trash2 aria-hidden className="h-4 w-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {editable && (
        <section
          aria-labelledby="spare-attach"
          className="flex flex-col gap-3 rounded-md border border-border p-4"
        >
          <h3 id="spare-attach" className="text-base font-semibold">
            {s.attach}
          </h3>
          {available.length === 0 ? (
            <p className="text-sm text-muted-foreground">{s.noneAvailable}</p>
          ) : (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[14rem] flex-1">
                <Field id="spare-choice" label={s.choice}>
                  {(control) => (
                    <Select
                      {...control}
                      value={choice}
                      onChange={(ev) => setChoice(ev.target.value)}
                    >
                      <option value="">{s.choose}</option>
                      {available.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.title}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
              <Button
                type="button"
                disabled={pending || choice === ""}
                onClick={() => {
                  const diagram = available.find((d) => d.id === choice);
                  if (!diagram) return;
                  run(
                    () => attachDiagramProduct({ diagramId: diagram.id, productId }),
                    () => {
                      setAttached((c) => [...c, diagram]);
                      setAvailable((c) => c.filter((x) => x.id !== diagram.id));
                      setChoice("");
                    },
                    s.attachedDone,
                  );
                }}
              >
                {s.attachButton}
              </Button>
            </div>
          )}
          <p className="text-sm">
            <Link
              href="/admin/fise-explodate"
              className="text-primary underline-offset-2 hover:underline"
            >
              {s.manage}
            </Link>
          </p>
        </section>
      )}
      {!editable && <p className="text-sm text-muted-foreground">{e.common.readOnlyTab}</p>}
    </div>
  );
}
