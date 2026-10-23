"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Button, Dialog, Input } from "@ecom/ui";
import { createDiagram } from "@/app/(admin)/admin/produse/fise-explodate/actions";
import { Field } from "@/components/admin/products/editor-ui";
import { getMessages } from "@/messages";
import { MediaPicker } from "../media/media-picker";

const m = getMessages().admin.diagrams;

export interface DiagramListRow {
  id: string;
  title: string;
  hotspotCount: number;
  productCount: number;
  imageUrl: string | null;
  imageName: string;
}

/**
 * Lista fișelor explodate și crearea uneia noi (titlu + imagine din bibliotecă). După creare se
 * deschide editorul fișei. Fără `canWrite`, doar listă.
 */
export function DiagramList({
  diagrams,
  canWrite,
}: {
  diagrams: readonly DiagramListRow[];
  canWrite: boolean;
}) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      {canWrite && (
        <div>
          <Button type="button" onClick={() => setCreating(true)}>
            {m.new}
          </Button>
        </div>
      )}

      {diagrams.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[32rem] text-sm">
            <caption className="sr-only">{m.listLabel}</caption>
            <thead>
              <tr className="border-b border-border text-left">
                <th scope="col" className="p-3 font-medium">
                  {m.table.image}
                </th>
                <th scope="col" className="p-3 font-medium">
                  {m.table.title}
                </th>
                <th scope="col" className="p-3 font-medium">
                  {m.table.hotspots}
                </th>
                <th scope="col" className="p-3 font-medium">
                  {m.table.products}
                </th>
              </tr>
            </thead>
            <tbody>
              {diagrams.map((d) => (
                <tr
                  key={d.id}
                  data-diagram-row={d.title}
                  className="border-b border-border last:border-0"
                >
                  <td className="p-3">
                    {d.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- imagine din /media (variante generate)
                      <img
                        src={d.imageUrl}
                        alt=""
                        width={64}
                        height={48}
                        loading="lazy"
                        className="h-12 w-16 rounded-md border border-border object-cover"
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">{m.noImage}</span>
                    )}
                  </td>
                  <th scope="row" className="p-3 text-left font-medium">
                    <Link
                      href={`/admin/produse/fise-explodate/${d.id}`}
                      aria-label={m.open(d.title)}
                      className="text-primary underline-offset-2 hover:underline"
                    >
                      {d.title}
                    </Link>
                  </th>
                  <td className="p-3">{d.hotspotCount}</td>
                  <td className="p-3">{d.productCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating && <CreateDialog onClose={() => setCreating(false)} />}
    </div>
  );
}

function CreateDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [mediaId, setMediaId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (title.trim() === "") found["title"] = m.create.titleRequired;
    if (!mediaId) found["image"] = m.create.imageRequired;
    setErrors(found);
    setProblem(null);
    if (Object.keys(found).length > 0) return;
    startTransition(async () => {
      try {
        const result = await createDiagram({ title: title.trim(), mediaId });
        if (result.ok) {
          router.push(`/admin/produse/fise-explodate/${result.id}`);
          return;
        }
        const errorsByCode = m.errors as Record<string, string>;
        setProblem(result.message ?? errorsByCode[result.code] ?? m.errors.generic);
      } catch {
        setProblem(m.errors.generic);
      }
    });
  };

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={m.create.title}
        closeLabel={m.create.close}
        className="max-w-xl"
      >
        <form onSubmit={submit} noValidate className="flex flex-col gap-4">
          <Field
            id="diagram-title"
            label={m.create.titleField}
            help={m.create.titleHelp}
            error={errors["title"]}
          >
            {(control) => (
              <Input
                {...control}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                autoFocus
              />
            )}
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">{m.create.image}</span>
            <p className="text-xs text-muted-foreground">{m.create.imageHelp}</p>
            <p className="text-sm" data-diagram-image-state>
              {mediaId ? m.create.chosen : m.create.none}
            </p>
            <div>
              <Button type="button" variant="outline" onClick={() => setPickerOpen(true)}>
                {mediaId ? m.create.change : m.create.pick}
              </Button>
            </div>
            {errors["image"] && (
              <p data-problem className="text-sm text-danger">
                {errors["image"]}
              </p>
            )}
          </div>
          {problem && (
            <p
              role="alert"
              data-problem
              className="rounded-md border border-danger p-3 text-sm text-danger"
            >
              {problem}
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {m.create.cancel}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? m.create.submitting : m.create.submit}
            </Button>
          </div>
        </form>
      </Dialog>

      {pickerOpen && (
        <MediaPicker
          open
          mode="single"
          title={m.create.pickerTitle}
          initialSelectedIds={mediaId ? [mediaId] : []}
          onClose={() => setPickerOpen(false)}
          onConfirm={(ids) => {
            setMediaId(ids[0] ?? null);
            setPickerOpen(false);
            setErrors((c) => ({ ...c, image: "" }));
          }}
        />
      )}
    </>
  );
}
