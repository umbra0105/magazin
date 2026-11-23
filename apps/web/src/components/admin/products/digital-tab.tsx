"use client";

import { ArrowDown, ArrowUp, RefreshCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import type { DigitalContentDto } from "@ecom/core";
import { Badge, Button, Dialog, FileInput, Input, Progress, Select, Textarea } from "@ecom/ui";
import {
  addDigitalLinkAction,
  deleteDigitalAssetAction,
  refreshDigitalAssetAction,
  reorderDigitalAssetsAction,
  saveDigitalSettingsAction,
  updateDigitalAssetAction,
} from "@/app/(admin)/admin/produse/digital-actions";
import { getMessages } from "@/messages";
import { CheckField, Field, Section } from "./editor-ui";

const m = getMessages().digitalAdmin;
const t = m.tab;

type Asset = DigitalContentDto["assets"][number];
const DELIVERY_TYPES = Object.keys(t.deliveryTypes);

const errorText = (code: unknown): string => {
  const errors = m.errors;
  return (typeof code === "string" && errors[code]) || (errors["failed"] ?? "");
};

/** Încarcă un fișier cu progres (fetch nu raportează progresul încărcării, deci XHR); serverul decide totul. */
function uploadWithProgress(
  url: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<{ ok: boolean; body: { code?: string; message?: string } }> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open("POST", url);
    request.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    request.setRequestHeader("content-type", file.type || "application/octet-stream");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      let body: { code?: string; message?: string } = {};
      try {
        body = JSON.parse(request.responseText) as typeof body;
      } catch {
        body = {};
      }
      resolve({ ok: request.status >= 200 && request.status < 300, body });
    };
    request.onerror = () => resolve({ ok: false, body: { code: "DIGITAL_UPLOAD_FAILED" } });
    request.send(file);
  });
}

/**
 * Tabul «Conținut digital» al unui produs digital (Faza 14b, `docs/17` §4.2): setările de livrare și acces, modulele (ordine,
 * previzualizare gratuită, titlu, ștergere), încărcare cu progres și legături externe. Toate scrierile cer `digital.manage` pe server;
 * aici doar se ascund controalele fără permisiune. Cheia de stocare nu ajunge niciodată în această componentă.
 */
export function DigitalTab({
  productId,
  initial,
  canManage,
  maxUploadMb,
  providers,
}: {
  productId: string;
  initial: DigitalContentDto;
  canManage: boolean;
  maxUploadMb: number;
  providers: { video: string; file: string };
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const digital = initial.digital;
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // setări
  const [deliveryType, setDeliveryType] = useState(digital?.deliveryType ?? "download");
  const [maxDownloads, setMaxDownloads] = useState(
    digital?.maxDownloads == null ? "" : String(digital.maxDownloads),
  );
  const [whatYouGet, setWhatYouGet] = useState(digital?.whatYouGet ?? "");
  const [requirements, setRequirements] = useState(digital?.requirements ?? "");
  const [format, setFormat] = useState(digital?.format ?? "");
  const [limitError, setLimitError] = useState<string | undefined>();

  // module
  const [assets, setAssets] = useState<Asset[]>([...initial.assets]);
  const [removing, setRemoving] = useState<Asset | null>(null);
  const [renaming, setRenaming] = useState<Record<string, string>>({});

  // încărcare
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadPreview, setUploadPreview] = useState(false);
  const [fileError, setFileError] = useState<string | undefined>();
  const [percent, setPercent] = useState<number | null>(null);

  // legătură
  const [linkTitle, setLinkTitle] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [linkPreview, setLinkPreview] = useState(false);

  const refresh = () => startTransition(() => router.refresh());
  const fail = (code: unknown) => {
    setStatus(null);
    setProblem(errorText(code));
  };
  const ok = (message: string) => {
    setProblem(null);
    setStatus(message);
  };

  async function onSaveSettings(event: FormEvent) {
    event.preventDefault();
    setLimitError(undefined);
    const trimmed = maxDownloads.trim();
    let limit: number | null = null;
    if (trimmed !== "") {
      limit = Number(trimmed);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) {
        setLimitError(errorText("DIGITAL_INPUT_INVALID"));
        return;
      }
    }
    const result = await saveDigitalSettingsAction({
      productId,
      deliveryType,
      maxDownloads: limit,
      whatYouGet: whatYouGet.trim() === "" ? null : whatYouGet,
      requirements: requirements.trim() === "" ? null : requirements,
      format: format.trim() === "" ? null : format,
    });
    if (result.ok) {
      ok(t.saved);
      refresh();
    } else fail(result.code);
  }

  async function onUpload(event: FormEvent) {
    event.preventDefault();
    setFileError(undefined);
    if (!file) {
      setFileError(t.chooseFile);
      return;
    }
    if (file.size > maxUploadMb * 1024 * 1024) {
      setFileError(t.tooLarge(maxUploadMb));
      return;
    }
    setPercent(0);
    const query = new URLSearchParams({ preview: String(uploadPreview) });
    if (uploadTitle.trim() !== "") query.set("title", uploadTitle.trim());
    const result = await uploadWithProgress(
      `/api/admin/products/${encodeURIComponent(productId)}/digital?${query.toString()}`,
      file,
      setPercent,
    );
    setPercent(null);
    if (result.ok) {
      ok(t.uploaded);
      setFile(null);
      setUploadTitle("");
      setUploadPreview(false);
      setFileKey((key) => key + 1);
      refresh();
    } else fail(result.body.code);
  }

  async function onAddLink(event: FormEvent) {
    event.preventDefault();
    const result = await addDigitalLinkAction({
      productId,
      title: linkTitle,
      url: linkUrl,
      isPreview: linkPreview,
    });
    if (result.ok) {
      ok(t.linkAdded);
      setLinkTitle("");
      setLinkUrl("");
      setLinkPreview(false);
      refresh();
    } else fail(result.code);
  }

  async function move(index: number, delta: -1 | 1) {
    const next = [...assets];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target] as Asset, next[index] as Asset];
    setAssets(next);
    const result = await reorderDigitalAssetsAction({
      productId,
      orderedIds: next.map((a) => a.id),
    });
    if (result.ok) refresh();
    else {
      setAssets([...initial.assets]);
      fail(result.code);
    }
  }

  async function togglePreview(asset: Asset) {
    const result = await updateDigitalAssetAction({
      productId,
      assetId: asset.id,
      isPreview: !asset.isPreview,
    });
    if (result.ok) {
      setAssets((current) =>
        current.map((a) => (a.id === asset.id ? { ...a, isPreview: !a.isPreview } : a)),
      );
      refresh();
    } else fail(result.code);
  }

  async function saveTitle(asset: Asset) {
    const title = renaming[asset.id];
    if (title === undefined || title === asset.title) return;
    const result = await updateDigitalAssetAction({ productId, assetId: asset.id, title });
    if (result.ok) {
      setAssets((current) => current.map((a) => (a.id === asset.id ? { ...a, title } : a)));
      setRenaming((current) =>
        Object.fromEntries(Object.entries(current).filter(([key]) => key !== asset.id)),
      );
      ok(t.saved);
      refresh();
    } else fail(result.code);
  }

  async function refreshStatus(asset: Asset) {
    const result = await refreshDigitalAssetAction({ productId, assetId: asset.id });
    if (result.ok) refresh();
    else fail(result.code);
  }

  async function confirmRemove() {
    if (!removing) return;
    const target = removing;
    const result = await deleteDigitalAssetAction({ productId, assetId: target.id });
    setRemoving(null);
    if (result.ok) {
      setAssets((current) => current.filter((a) => a.id !== target.id));
      refresh();
    } else fail(result.code);
  }

  return (
    <div className="flex flex-col gap-8" data-digital-tab>
      <p className="max-w-prose text-ink-secondary">{t.lede}</p>
      {!canManage ? (
        <p role="note" className="rounded-lg bg-surface-subtle p-3 text-ink-secondary">
          {t.readOnly}
        </p>
      ) : null}
      <div aria-live="polite" className="min-h-6">
        {status ? <p className="text-tone-success-fg">{status}</p> : null}
        {problem ? (
          <p role="alert" className="text-tone-problem-fg">
            {problem}
          </p>
        ) : null}
      </div>

      <Section id="dg-settings" title={t.settingsTitle}>
        <form noValidate onSubmit={onSaveSettings} className="flex max-w-2xl flex-col gap-4">
          <Field id="dg-delivery" label={t.deliveryType}>
            {(control) => (
              <Select
                {...control}
                value={deliveryType}
                disabled={!canManage}
                onChange={(event) => setDeliveryType(event.target.value as typeof deliveryType)}
              >
                {DELIVERY_TYPES.map((key) => (
                  <option key={key} value={key}>
                    {t.deliveryTypes[key]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field id="dg-limit" label={t.maxDownloads} help={t.maxDownloadsHelp} error={limitError}>
            {(control) => (
              <Input
                {...control}
                inputMode="numeric"
                value={maxDownloads}
                disabled={!canManage}
                onChange={(event) => setMaxDownloads(event.target.value)}
              />
            )}
          </Field>
          <Field id="dg-get" label={t.whatYouGet}>
            {(control) => (
              <Textarea
                {...control}
                rows={3}
                value={whatYouGet}
                disabled={!canManage}
                onChange={(event) => setWhatYouGet(event.target.value)}
              />
            )}
          </Field>
          <Field id="dg-req" label={t.requirements}>
            {(control) => (
              <Textarea
                {...control}
                rows={2}
                value={requirements}
                disabled={!canManage}
                onChange={(event) => setRequirements(event.target.value)}
              />
            )}
          </Field>
          <Field id="dg-format" label={t.format}>
            {(control) => (
              <Input
                {...control}
                value={format}
                disabled={!canManage}
                onChange={(event) => setFormat(event.target.value)}
              />
            )}
          </Field>
          {canManage ? (
            <div>
              <Button type="submit">{t.saveSettings}</Button>
            </div>
          ) : null}
        </form>
      </Section>

      <Section id="dg-modules" title={t.modulesTitle}>
        {assets.length === 0 ? (
          <p className="text-ink-secondary">{t.empty}</p>
        ) : (
          <ol className="flex flex-col divide-y divide-line-subtle" data-digital-assets>
            {assets.map((asset, index) => (
              <li key={asset.id} className="flex flex-col gap-2 py-3" data-digital-asset>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="neutral">{t.type[asset.type]}</Badge>
                  <Badge
                    variant={
                      asset.status === "ready"
                        ? "success"
                        : asset.status === "processing"
                          ? "warning"
                          : "danger"
                    }
                  >
                    {t.status[asset.status]}
                  </Badge>
                  {asset.isPreview ? <Badge variant="info">{t.previewBadge}</Badge> : null}
                  <span className="text-label text-ink-secondary">
                    {asset.provider ? (t.provider[asset.provider] ?? asset.provider) : ""}
                    {asset.fileSize !== null ? ` · ${t.size(asset.fileSize)}` : ""}
                  </span>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <Field
                    id={`dg-title-${asset.id}`}
                    label={t.moduleTitle}
                    className="flex min-w-60 flex-1 flex-col gap-1.5"
                  >
                    {(control) => (
                      <Input
                        {...control}
                        value={renaming[asset.id] ?? asset.title}
                        disabled={!canManage}
                        onChange={(event) =>
                          setRenaming((current) => ({ ...current, [asset.id]: event.target.value }))
                        }
                      />
                    )}
                  </Field>
                  {canManage ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void saveTitle(asset)}
                        disabled={
                          renaming[asset.id] === undefined || renaming[asset.id] === asset.title
                        }
                      >
                        {t.saveTitle}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t.moveUp}
                        title={t.moveUp}
                        disabled={index === 0}
                        onClick={() => void move(index, -1)}
                      >
                        <ArrowUp aria-hidden className="size-5" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t.moveDown}
                        title={t.moveDown}
                        disabled={index === assets.length - 1}
                        onClick={() => void move(index, 1)}
                      >
                        <ArrowDown aria-hidden className="size-5" />
                      </Button>
                      {asset.status === "processing" ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={t.refresh}
                          title={t.refresh}
                          onClick={() => void refreshStatus(asset)}
                        >
                          <RefreshCw aria-hidden className="size-5" />
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`${t.remove}: ${asset.title}`}
                        title={t.remove}
                        onClick={() => setRemoving(asset)}
                      >
                        <Trash2 aria-hidden className="size-5" />
                      </Button>
                    </>
                  ) : null}
                </div>
                <CheckField
                  id={`dg-preview-${asset.id}`}
                  label={t.togglePreview}
                  checked={asset.isPreview}
                  disabled={!canManage}
                  onChange={() => void togglePreview(asset)}
                />
              </li>
            ))}
          </ol>
        )}
      </Section>

      {canManage ? (
        <>
          <Section id="dg-upload" title={t.uploadTitle}>
            <form noValidate onSubmit={onUpload} className="flex max-w-2xl flex-col gap-4">
              <p className="text-label text-ink-secondary">
                {t.uploadHelp(
                  t.provider[providers.video] ?? providers.video,
                  t.provider[providers.file] ?? providers.file,
                  maxUploadMb,
                )}
              </p>
              <Field id="dg-file" label={t.uploadTitle} error={fileError}>
                {(control) => (
                  <FileInput
                    key={fileKey}
                    id={control.id}
                    aria-invalid={control["aria-invalid"]}
                    onFilesChange={(files) => setFile(files[0] ?? null)}
                    disabled={percent !== null}
                  />
                )}
              </Field>
              <Field id="dg-upload-title" label={t.uploadTitleLabel}>
                {(control) => (
                  <Input
                    {...control}
                    value={uploadTitle}
                    onChange={(event) => setUploadTitle(event.target.value)}
                  />
                )}
              </Field>
              <CheckField
                id="dg-upload-preview"
                label={t.uploadPreview}
                checked={uploadPreview}
                onChange={setUploadPreview}
              />
              {percent !== null ? (
                <div className="flex flex-col gap-1">
                  <Progress value={percent} label={t.uploadProgress} />
                  <p className="text-label text-ink-secondary">{t.uploading(percent)}</p>
                </div>
              ) : null}
              <div>
                <Button type="submit" variant="outline" disabled={percent !== null}>
                  {t.upload}
                </Button>
              </div>
            </form>
          </Section>

          <Section id="dg-link" title={t.linkTitle}>
            <form noValidate onSubmit={onAddLink} className="flex max-w-2xl flex-col gap-4">
              <Field id="dg-link-title" label={t.linkName}>
                {(control) => (
                  <Input
                    {...control}
                    value={linkTitle}
                    onChange={(event) => setLinkTitle(event.target.value)}
                  />
                )}
              </Field>
              <Field id="dg-link-url" label={t.linkUrl}>
                {(control) => (
                  <Input
                    {...control}
                    value={linkUrl}
                    onChange={(event) => setLinkUrl(event.target.value)}
                  />
                )}
              </Field>
              <CheckField
                id="dg-link-preview"
                label={t.uploadPreview}
                checked={linkPreview}
                onChange={setLinkPreview}
              />
              <div>
                <Button type="submit" variant="outline">
                  {t.addLink}
                </Button>
              </div>
            </form>
          </Section>
        </>
      ) : null}

      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title={t.removeTitle}
        description={removing ? t.removeText(removing.title) : ""}
        closeLabel={t.cancel}
      >
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setRemoving(null)}>
            {t.cancel}
          </Button>
          <Button type="button" variant="destructive" onClick={() => void confirmRemove()}>
            {t.confirmRemove}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
