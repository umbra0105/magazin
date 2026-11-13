"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type FormEvent } from "react";
import {
  Button,
  Dialog,
  EmptyState,
  Input,
  RowHeader,
  TBody,
  THead,
  Table,
  Td,
  Th,
  Tr,
} from "@ecom/ui";
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
 * deschide editorul fișei. Fără `canWrite`, doar listă. Tabelul e `Table stacked` (docs/17 §3): pe telefon fiecare
 * fișă e un card cu miniatura, titlul și numărătorile; lista goală are o singură acțiune de creare.
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
      {canWrite && diagrams.length > 0 && (
        <div className="flex justify-end">
          <Button type="button" onClick={() => setCreating(true)}>
            {m.new}
          </Button>
        </div>
      )}

      {diagrams.length === 0 ? (
        <EmptyState
          title={m.empty}
          {...(canWrite && {
            action: (
              <Button type="button" onClick={() => setCreating(true)}>
                {m.new}
              </Button>
            ),
          })}
        />
      ) : (
        <Table stacked aria-label={m.listLabel}>
          <THead>
            <Tr>
              <Th>{m.table.image}</Th>
              <Th>{m.table.title}</Th>
              <Th numeric>{m.table.hotspots}</Th>
              <Th numeric>{m.table.products}</Th>
            </Tr>
          </THead>
          <TBody>
            {diagrams.map((d) => (
              <Tr key={d.id} data-diagram-row={d.title}>
                <Td data-cell="image">
                  {d.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- imagine din /media (variante generate)
                    <img
                      src={d.imageUrl}
                      alt=""
                      width={64}
                      height={48}
                      loading="lazy"
                      className="h-12 w-16 rounded-md border border-line-subtle object-cover"
                    />
                  ) : (
                    <span className="text-label text-ink-secondary">{m.noImage}</span>
                  )}
                </Td>
                <RowHeader stack="lead" className="font-medium">
                  <Link
                    href={`/admin/produse/fise-explodate/${d.id}`}
                    aria-label={m.open(d.title)}
                    className="text-link underline-offset-2 hover:underline"
                  >
                    {d.title}
                  </Link>
                </RowHeader>
                <Td numeric className="whitespace-nowrap text-ink-secondary" data-cell="hotspots">
                  {m.counts.hotspots(d.hotspotCount)}
                </Td>
                <Td numeric className="whitespace-nowrap text-ink-secondary" data-cell="products">
                  {m.counts.products(d.productCount)}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
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
  const titleRef = useRef<HTMLInputElement>(null);
  const pickRef = useRef<HTMLButtonElement>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const found: Record<string, string> = {};
    if (title.trim() === "") found["title"] = m.create.titleRequired;
    if (!mediaId) found["image"] = m.create.imageRequired;
    setErrors(found);
    setProblem(null);
    if (Object.keys(found).length > 0) {
      // focus pe primul câmp greșit (formularul are `noValidate`, mesajele sunt ale aplicației)
      if (found["title"]) titleRef.current?.focus();
      else pickRef.current?.focus();
      return;
    }
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
                ref={titleRef}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={200}
                autoFocus
              />
            )}
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-label text-ink-secondary">{m.create.image}</span>
            <p className="text-label text-ink-secondary">{m.create.imageHelp}</p>
            <p className="text-body" data-diagram-image-state>
              {mediaId ? m.create.chosen : m.create.none}
            </p>
            <div>
              <Button
                ref={pickRef}
                type="button"
                variant="outline"
                onClick={() => setPickerOpen(true)}
              >
                {mediaId ? m.create.change : m.create.pick}
              </Button>
            </div>
            {errors["image"] && (
              <p data-problem className="text-body text-tone-problem-fg">
                {errors["image"]}
              </p>
            )}
          </div>
          {problem && (
            <p
              role="alert"
              data-problem
              className="rounded-lg bg-tone-problem-bg p-3 text-body text-tone-problem-fg"
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
