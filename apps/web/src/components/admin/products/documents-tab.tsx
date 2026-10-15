"use client";

import { ArrowDown, ArrowUp, Download, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type FormEvent } from "react";
import { Button, Dialog, Input, Select } from "@ecom/ui";
import {
  deleteProductDocument,
  reorderProductDocuments,
  updateProductDocument,
} from "@/app/(admin)/admin/produse/document-actions";
import type { ProductActionFailure } from "@/lib/product-action-support";
import { getMessages } from "@/messages";
import type { EditorCaps, EditorDocument } from "./editor-types";
import { CheckField, Field } from "./editor-ui";

const m = getMessages().admin.products;
const e = m.editor;
const d = e.documents;

type DocumentType = keyof typeof d.types;
const TYPES = Object.keys(d.types) as DocumentType[];
type Language = keyof typeof d.languages;
const LANGUAGES = Object.keys(d.languages) as Language[];

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1).replace(".", ",")} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

function uploadErrorText(code: unknown, message: unknown): string {
  const codes = d.codes as Record<string, string>;
  if (typeof code === "string" && codes[code]) return codes[code];
  return typeof message === "string" && message !== "" ? message : e.common.generic;
}

function actionErrorText(result: ProductActionFailure): string {
  const codes = d.codes as Record<string, string>;
  const errors = m.errors as Record<string, string>;
  return result.message ?? codes[result.code] ?? errors[result.code] ?? e.common.generic;
}

/**
 * Tabul Documente. Încărcarea merge pe ruta proprie `POST /api/admin/products/<id>/documents`
 * (fișierul curge ca flux, cu limită de mărime; nu trece prin server actions și nu intră în
 * biblioteca media). Serverul verifică originea, sesiunea, permisiunea, tipul real din octeți și
 * conținutul activ din PDF; aici se arată doar mesajele lui. Descărcarea se face prin link cu
 * expirare scurtă și `attachment`. Cere `products.content.write`.
 */
export function DocumentsTab({
  productId,
  initial,
  maxUploadMb,
  caps,
}: {
  productId: string;
  initial: readonly EditorDocument[];
  maxUploadMb: number;
  caps: EditorCaps;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [documents, setDocuments] = useState<EditorDocument[]>([...initial]);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<EditorDocument | null>(null);
  const editable = caps.canContent;

  // formularul de încărcare
  const fileRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);
  const [type, setType] = useState<DocumentType>("manual");
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState<Language>("ro");
  const [showInTab, setShowInTab] = useState(true);
  const [fileError, setFileError] = useState<string | null>(null);

  const base = `/api/admin/products/${productId}/documents`;

  /** Trimite un fișier la rută; întoarce documentul sau textul erorii. */
  const send = async (
    file: File,
    query: URLSearchParams,
  ): Promise<{ ok: true; document: EditorDocument } | { ok: false; message: string }> => {
    try {
      const response = await fetch(`${base}?${query.toString()}`, {
        method: "POST",
        headers: { "x-file-name": encodeURIComponent(file.name) },
        body: file,
      });
      const body = (await response.json().catch(() => ({}))) as {
        document?: EditorDocument;
        code?: string;
        message?: string;
      };
      if (response.ok && body.document) return { ok: true, document: body.document };
      return { ok: false, message: uploadErrorText(body.code, body.message) };
    } catch {
      return { ok: false, message: e.common.generic };
    }
  };

  const onUpload = async (event: FormEvent) => {
    event.preventDefault();
    setStatus(null);
    setProblem(null);
    setFileError(null);
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setFileError(d.chooseFile);
      return;
    }
    if (file.size > maxUploadMb * 1024 * 1024) {
      setFileError(d.tooLarge(maxUploadMb));
      return;
    }
    const query = new URLSearchParams({ type, language, showInTab: String(showInTab) });
    if (title.trim() !== "") query.set("title", title.trim());
    setUploading(true);
    const result = await send(file, query);
    setUploading(false);
    if (result.ok) {
      setDocuments((current) => [...current, result.document]);
      setStatus(d.uploaded);
      setTitle("");
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    } else {
      setProblem(result.message);
    }
  };

  const onReplace = async (file: File | undefined) => {
    const target = replaceTarget.current;
    replaceTarget.current = null;
    if (replaceRef.current) replaceRef.current.value = "";
    if (!file || !target) return;
    setStatus(null);
    setProblem(null);
    if (file.size > maxUploadMb * 1024 * 1024) {
      setProblem(d.tooLarge(maxUploadMb));
      return;
    }
    setUploading(true);
    const result = await send(file, new URLSearchParams({ type: "other", replace: target }));
    setUploading(false);
    if (result.ok) {
      setDocuments((current) =>
        current.map((doc) => (doc.id === target ? { ...doc, ...result.document } : doc)),
      );
      setStatus(d.replaced);
      router.refresh();
    } else {
      setProblem(result.message);
    }
  };

  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= documents.length) return;
    const ids = documents.map((x) => x.id);
    const [moved] = ids.splice(index, 1);
    if (!moved) return;
    ids.splice(target, 0, moved);
    setProblem(null);
    startTransition(async () => {
      try {
        const result = await reorderProductDocuments({ id: productId, orderedIds: ids });
        if (result.ok) {
          setDocuments((current) =>
            result.order
              .map((id) => current.find((x) => x.id === id))
              .filter((x): x is EditorDocument => x !== undefined),
          );
          router.refresh();
        } else {
          setProblem(actionErrorText(result));
        }
      } catch {
        setProblem(e.common.generic);
      }
    });
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <h2 className="text-lg font-semibold">{d.heading}</h2>
      <p className="text-sm text-muted-foreground">{d.help}</p>

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
        <form
          onSubmit={(event) => void onUpload(event)}
          noValidate
          className="flex flex-col gap-4 rounded-md border border-border p-4"
          aria-label={d.upload}
        >
          <h3 className="text-base font-semibold">{d.upload}</h3>
          <Field
            id="doc-file"
            label={d.file}
            help={d.accepted(maxUploadMb)}
            error={fileError ?? undefined}
          >
            {(control) => (
              <input
                {...control}
                ref={fileRef}
                type="file"
                accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp"
                className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-2"
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="doc-type" label={d.type}>
              {(control) => (
                <Select
                  {...control}
                  value={type}
                  onChange={(ev) => setType(ev.target.value as DocumentType)}
                >
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {d.types[t]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field id="doc-language" label={d.language}>
              {(control) => (
                <Select
                  {...control}
                  value={language}
                  onChange={(ev) => setLanguage(ev.target.value as Language)}
                >
                  {LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      {d.languages[l]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Field id="doc-title" label={d.title}>
            {(control) => (
              <Input
                {...control}
                value={title}
                maxLength={200}
                onChange={(ev) => setTitle(ev.target.value)}
              />
            )}
          </Field>
          <CheckField
            id="doc-show"
            label={d.showInTab}
            checked={showInTab}
            onChange={setShowInTab}
          />
          <div>
            <Button type="submit" disabled={uploading}>
              {uploading ? d.uploading : d.submit}
            </Button>
          </div>
        </form>
      )}

      {/* câmp de fișier ascuns, pentru „Înlocuiește fișierul” */}
      <input
        ref={replaceRef}
        type="file"
        hidden
        accept=".pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp"
        onChange={(ev) => void onReplace(ev.target.files?.[0])}
        data-replace-input
      />

      {documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">{d.empty}</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label={d.listLabel}>
          {documents.map((doc, index) =>
            editingId === doc.id ? (
              <EditRow
                key={doc.id}
                doc={doc}
                onCancel={() => setEditingId(null)}
                onSaved={(next) => {
                  setDocuments((current) => current.map((x) => (x.id === doc.id ? next : x)));
                  setEditingId(null);
                  setStatus(d.updated);
                  router.refresh();
                }}
              />
            ) : (
              <li
                key={doc.id}
                data-document-row={doc.title}
                className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3"
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{doc.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {[
                      (d.types as Record<string, string>)[doc.type] ?? doc.type,
                      (d.languages as Record<string, string>)[doc.language] ?? doc.language,
                      doc.mime === "application/pdf"
                        ? "PDF"
                        : doc.mime.replace("image/", "").toUpperCase(),
                      formatSize(doc.sizeBytes),
                      doc.showInTab ? "" : d.hiddenInTab,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  <a
                    href={`${base}/${doc.id}`}
                    aria-label={d.download(doc.title)}
                    className="inline-flex h-11 items-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-border/30"
                  >
                    <Download aria-hidden className="h-4 w-4" />
                    {d.downloadText}
                  </a>
                  {editable && (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={pending || index === 0}
                        aria-label={d.moveUp(doc.title)}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp aria-hidden className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={pending || index === documents.length - 1}
                        aria-label={d.moveDown(doc.title)}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown aria-hidden className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        aria-label={d.edit(doc.title)}
                        onClick={() => setEditingId(doc.id)}
                      >
                        <Pencil aria-hidden className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        disabled={uploading}
                        aria-label={d.replace(doc.title)}
                        onClick={() => {
                          replaceTarget.current = doc.id;
                          replaceRef.current?.click();
                        }}
                      >
                        <RefreshCw aria-hidden className="h-4 w-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        aria-label={d.remove(doc.title)}
                        onClick={() => setRemoving(doc)}
                      >
                        <Trash2 aria-hidden className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      {!editable && <p className="text-sm text-muted-foreground">{e.common.readOnlyTab}</p>}

      {removing && (
        <RemoveDialog
          doc={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setDocuments((current) => current.filter((x) => x.id !== removing.id));
            setRemoving(null);
            setStatus(d.deleted);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function EditRow({
  doc,
  onCancel,
  onSaved,
}: {
  doc: EditorDocument;
  onCancel: () => void;
  onSaved: (next: EditorDocument) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState(doc.title);
  const [type, setType] = useState(doc.type);
  const [language, setLanguage] = useState(doc.language);
  const [showInTab, setShowInTab] = useState(doc.showInTab);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    const patch: Record<string, unknown> = {};
    if (title.trim() !== doc.title) patch["title"] = title.trim();
    if (type !== doc.type) patch["type"] = type;
    if (language !== doc.language) patch["language"] = language;
    if (showInTab !== doc.showInTab) patch["showInTab"] = showInTab;
    if (Object.keys(patch).length === 0) {
      onCancel();
      return;
    }
    startTransition(async () => {
      try {
        const result = await updateProductDocument({ documentId: doc.id, patch });
        if (result.ok) {
          const { title: t, type: ty, language: l, showInTab: s } = result.document;
          onSaved({ ...doc, title: t, type: ty, language: l, showInTab: s });
        } else {
          setProblem(actionErrorText(result));
        }
      } catch {
        setProblem(e.common.generic);
      }
    });
  };

  return (
    <li data-document-edit={doc.title} className="rounded-md border border-border bg-border/20 p-4">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <p className="text-sm font-medium">{d.edit(doc.title)}</p>
        <Field id={`doc-edit-title-${doc.id}`} label={d.title}>
          {(control) => (
            <Input
              {...control}
              value={title}
              maxLength={200}
              onChange={(ev) => setTitle(ev.target.value)}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`doc-edit-type-${doc.id}`} label={d.type}>
            {(control) => (
              <Select {...control} value={type} onChange={(ev) => setType(ev.target.value)}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {d.types[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id={`doc-edit-language-${doc.id}`} label={d.language}>
            {(control) => (
              <Select {...control} value={language} onChange={(ev) => setLanguage(ev.target.value)}>
                {LANGUAGES.map((l) => (
                  <option key={l} value={l}>
                    {d.languages[l]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <CheckField
          id={`doc-edit-show-${doc.id}`}
          label={d.showInTab}
          checked={showInTab}
          onChange={setShowInTab}
        />
        {problem && (
          <p
            role="alert"
            data-problem
            className="rounded-md border border-danger p-3 text-sm text-danger"
          >
            {problem}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {d.save}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            {d.cancel}
          </Button>
        </div>
      </form>
    </li>
  );
}

function RemoveDialog({
  doc,
  onClose,
  onRemoved,
}: {
  doc: EditorDocument;
  onClose: () => void;
  onRemoved: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Dialog
      open
      onClose={onClose}
      title={d.removeTitle(doc.title)}
      description={d.removeDescription}
      closeLabel={d.close}
    >
      <div className="flex flex-col gap-4">
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
            {d.cancel}
          </Button>
          <Button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                try {
                  const result = await deleteProductDocument({ documentId: doc.id });
                  if (result.ok) onRemoved();
                  else setProblem(actionErrorText(result));
                } catch {
                  setProblem(e.common.generic);
                }
              })
            }
          >
            {pending ? d.removing : d.removeConfirm}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
