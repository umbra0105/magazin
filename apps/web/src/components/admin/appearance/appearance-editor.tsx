"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import { Button, Dialog, Input, Label, SaveBar, Section, Select, Textarea, cn } from "@ecom/ui";
import type {
  AnnouncementTone,
  CardLayout,
  ColorToken,
  ContainerWidth,
  ContrastWarning,
  FontKey,
  FooterVariant,
  HeaderVariant,
  PresetKey,
  RadiusKey,
} from "@ecom/core";
import { previewAppearance, saveAppearance } from "@/app/(admin)/admin/setari/aspect/actions";
import { UnsavedChangesProvider, useDirtyFlag } from "@/components/admin/products/unsaved-changes";
import { getMessages } from "@/messages";
import {
  applyPreset,
  isDirty,
  isHexColor,
  normalizeErrors,
  toPreviewBranding,
  toSavePayload,
  type AppearanceForm,
  type BrandingForm,
  type ColorValues,
} from "./appearance-form";
import { AppearancePreview } from "./appearance-preview";

const m = getMessages().admin.appearance;

/** Alegerile oferite (vin de pe server, din aceleași liste ca validarea): clientul nu importă nucleul. */
export interface AppearanceOptions {
  colorTokens: ColorToken[];
  fonts: { key: FontKey; label: string }[];
  radii: RadiusKey[];
  presets: { key: PresetKey; label: string; form: BrandingForm }[];
  headerVariants: HeaderVariant[];
  footerVariants: FooterVariant[];
  containerWidths: ContainerWidth[];
  cardLayouts: CardLayout[];
  announcementTones: AnnouncementTone[];
  announcementMaxLength: number;
  customCssMaxLength: number;
}

export interface AppearanceEditorProps {
  initial: AppearanceForm;
  options: AppearanceOptions;
  canSave: boolean;
  storeName: string;
}

const PREVIEW_DELAY_MS = 350;

type Mode = "light" | "dark";

function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-label text-ink-secondary">{hint}</p> : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-label text-tone-problem-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ColorField({
  id,
  label,
  value,
  error,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error?: string | undefined;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const valid = isHexColor(value);
  const shown = error ?? (valid || value === "" ? undefined : m.colors.invalid);
  return (
    <Field id={id} label={label} error={shown}>
      <div className="flex items-center gap-2">
        <span
          aria-label={m.colors.swatch(label)}
          role="img"
          className="size-8 shrink-0 rounded-md border border-line-input"
          style={valid ? { backgroundColor: value.trim() } : undefined}
        />
        <Input
          id={id}
          value={value}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          maxLength={7}
          aria-invalid={shown ? true : undefined}
          aria-describedby={shown ? `${id}-error` : undefined}
          onChange={(event) => onChange(event.target.value)}
          className="font-mono"
        />
      </div>
    </Field>
  );
}

export function AppearanceEditor(props: AppearanceEditorProps) {
  return (
    <UnsavedChangesProvider message={getMessages().admin.products.editor.unsavedConfirm}>
      <EditorForm {...props} />
    </UnsavedChangesProvider>
  );
}

function EditorForm({ initial, options, canSave, storeName }: AppearanceEditorProps) {
  const router = useRouter();
  const base = useId();
  const [saved, setSaved] = useState<AppearanceForm>(initial);
  const [form, setForm] = useState<AppearanceForm>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startSave] = useTransition();
  const [mode, setMode] = useState<Mode>("light");
  const [previewCss, setPreviewCss] = useState("");
  const [warnings, setWarnings] = useState<ContrastWarning[]>([]);
  const [previewError, setPreviewError] = useState(false);
  const [updating, setUpdating] = useState(true);
  const [confirmPreset, setConfirmPreset] = useState<PresetKey | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const requestNo = useRef(0);

  const dirty = isDirty(form, saved);
  useDirtyFlag("appearance", dirty);

  const patchBranding = (patch: Partial<BrandingForm>) => {
    setStatus(null);
    setForm((current) => ({ ...current, branding: { ...current.branding, ...patch } }));
  };
  const patchSettings = (patch: Partial<AppearanceForm["settings"]>) => {
    setStatus(null);
    setForm((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
  };
  const setColor = (theme: Mode, token: ColorToken, value: string) => {
    setStatus(null);
    setForm((current) => ({
      ...current,
      branding: {
        ...current.branding,
        colors: {
          ...current.branding.colors,
          [theme]: { ...current.branding.colors[theme], [token]: value } as ColorValues,
        },
      },
    }));
  };

  // Previzualizarea: tema din formular trece prin server (validare + CSS din valori validate), cu întârziere ca să nu se
  // trimită o cerere la fiecare tastă; un răspuns mai vechi nu îl înlocuiește pe unul mai nou.
  const branding = form.branding;
  useEffect(() => {
    const number = ++requestNo.current;
    setUpdating(true);
    const timer = setTimeout(() => {
      previewAppearance({
        branding: toPreviewBranding({ branding, settings: form.settings }),
        mode,
      })
        .then((result) => {
          if (number !== requestNo.current) return;
          setUpdating(false);
          setPreviewError(false);
          if (result.ok) {
            setPreviewCss(result.css);
            setWarnings(result.warnings);
            setErrors((current) => dropBrandingErrors(current));
          } else {
            setErrors((current) => ({
              ...dropBrandingErrors(current),
              ...normalizeErrors(result.errors),
            }));
          }
        })
        .catch(() => {
          if (number !== requestNo.current) return;
          setUpdating(false);
          setPreviewError(true);
        });
    }, PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
    // `form.settings` nu influențează tema: previzualizarea se actualizează doar la schimbarea temei sau a modului afișat
  }, [branding, mode]);

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSave || pending) return;
    setProblem(null);
    setStatus(null);
    if (form.settings.announcementEnabled && form.settings.announcementText.trim() === "") {
      setErrors((current) => ({
        ...current,
        "settings.announcementText": m.announcement.needsText,
      }));
      setProblem(m.fixErrors);
      focusFirstInvalid();
      return;
    }
    startSave(async () => {
      try {
        const result = await saveAppearance(toSavePayload(form));
        if (result.ok) {
          setErrors({});
          setSaved(form);
          setStatus(m.saved);
          router.refresh();
        } else {
          setErrors(normalizeErrors(result.errors));
          setProblem(m.fixErrors);
          focusFirstInvalid();
        }
      } catch {
        setProblem(m.saveFailed);
      }
    });
  };

  // Focusul pe primul câmp greșit se mută abia după ce erorile s-au desenat (efectul rulează după commit, nu înainte de el).
  const [focusTick, setFocusTick] = useState(0);
  const focusFirstInvalid = () => setFocusTick((tick) => tick + 1);
  useEffect(() => {
    if (focusTick === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusTick]);

  const disabled = !canSave;
  const id = (name: string) => `${base}-${name}`;
  const pendingPreset = options.presets.find((preset) => preset.key === confirmPreset);

  return (
    <div className="flex flex-col gap-8">
      <aside aria-labelledby={id("preview-title")} className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id={id("preview-title")} className="text-section">
            {m.sections.preview}
          </h2>
          <div role="group" aria-label={m.preview.mode} className="flex gap-1">
            {(["light", "dark"] as const).map((value) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant="outline"
                aria-pressed={mode === value}
                className={mode === value ? "bg-surface-hover font-semibold" : undefined}
                onClick={() => setMode(value)}
              >
                {m.preview[value]}
              </Button>
            ))}
          </div>
        </div>
        <p role="status" className="min-h-5 text-label text-ink-secondary">
          {previewError ? m.preview.failed : updating ? m.preview.updating : ""}
        </p>
        <AppearancePreview
          css={previewCss}
          settings={form.settings}
          storeName={storeName}
          logoUrl={form.branding.logoUrl.trim() === "" ? null : form.branding.logoUrl.trim()}
          updating={updating}
        />
      </aside>
      <form
        ref={formRef}
        noValidate
        onSubmit={onSubmit}
        data-appearance-form
        className="flex max-w-3xl min-w-0 flex-col gap-8"
      >
        <Section id="preset" title={m.sections.preset} description={m.sections.presetHelp}>
          <div role="group" aria-label={m.sections.preset} className="grid gap-3 sm:grid-cols-3">
            {options.presets.map((preset) => {
              const current = form.branding.preset === preset.key;
              return (
                <div
                  key={preset.key}
                  className={cn(
                    "flex flex-col gap-3 rounded-lg border p-3",
                    current ? "border-brand" : "border-line-subtle",
                  )}
                >
                  <p className="font-semibold">{preset.label}</p>
                  <div className="flex gap-1.5" aria-hidden="true">
                    {(["bg", "fg", "primary", "accent"] as const).map((token) => (
                      <span
                        key={token}
                        className="size-5 rounded-full border border-line-input"
                        style={{ backgroundColor: preset.form.colors.light[token] }}
                      />
                    ))}
                  </div>
                  {current ? (
                    <p className="text-label text-ink-secondary">{m.preset.current}</p>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={disabled}
                      onClick={() => setConfirmPreset(preset.key)}
                    >
                      {m.preset.apply}
                      <span className="sr-only"> {preset.label}</span>
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </Section>

        <Section id="colors" title={m.sections.colors} description={m.sections.colorsHelp}>
          {(["light", "dark"] as const).map((theme) => (
            <fieldset key={theme} className="flex flex-col gap-3">
              <legend className="mb-2 font-semibold">{m.colors[theme]}</legend>
              <div className="grid gap-4 sm:grid-cols-2">
                {options.colorTokens.map((token) => (
                  <ColorField
                    key={token}
                    id={id(`color-${theme}-${token}`)}
                    label={m.colors.tokens[token]}
                    value={form.branding.colors[theme][token]}
                    error={errors[`colors.${theme}.${token}`]}
                    disabled={disabled}
                    onChange={(value) => setColor(theme, token, value)}
                  />
                ))}
              </div>
            </fieldset>
          ))}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.branding.darkMode}
              disabled={disabled}
              onChange={(event) => patchBranding({ darkMode: event.target.checked })}
              className="size-4"
            />
            <span>{m.colors.darkMode}</span>
          </label>
          <div role="status" data-contrast className="flex flex-col gap-1 text-body">
            {warnings.length === 0 ? (
              <p className="text-ink-secondary">{m.colors.contrastOk}</p>
            ) : (
              warnings.map((warning) => (
                <p
                  key={`${warning.mode}-${warning.foreground}-${warning.background}`}
                  className="rounded-lg bg-tone-warning-bg p-2 text-tone-warning-fg"
                >
                  {m.colors[warning.mode]}:{" "}
                  {m.colors.contrast(
                    m.colors.tokens[warning.foreground],
                    m.colors.tokens[warning.background],
                    warning.ratio,
                  )}
                </p>
              ))
            )}
          </div>
        </Section>

        <Section id="type" title={m.sections.typography}>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id={id("font-heading")} label={m.typography.headingFont}>
              <Select
                id={id("font-heading")}
                value={form.branding.fonts.heading}
                disabled={disabled}
                onChange={(event) =>
                  patchBranding({
                    fonts: { ...form.branding.fonts, heading: event.target.value as FontKey },
                  })
                }
              >
                {options.fonts.map((font) => (
                  <option key={font.key} value={font.key}>
                    {font.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id={id("font-body")} label={m.typography.bodyFont}>
              <Select
                id={id("font-body")}
                value={form.branding.fonts.body}
                disabled={disabled}
                onChange={(event) =>
                  patchBranding({
                    fonts: { ...form.branding.fonts, body: event.target.value as FontKey },
                  })
                }
              >
                {options.fonts.map((font) => (
                  <option key={font.key} value={font.key}>
                    {font.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id={id("radius")} label={m.typography.radius}>
              <Select
                id={id("radius")}
                value={form.branding.radius}
                disabled={disabled}
                onChange={(event) => patchBranding({ radius: event.target.value as RadiusKey })}
              >
                {options.radii.map((radius) => (
                  <option key={radius} value={radius}>
                    {m.typography.radiusOptions[radius]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Section>

        <Section
          id="assets"
          title={m.sections.brandAssets}
          description={m.sections.brandAssetsHelp}
        >
          <div className="grid gap-4">
            {(
              [
                ["logoUrl", m.assets.logo],
                ["faviconUrl", m.assets.favicon],
                ["ogImageUrl", m.assets.ogImage],
              ] as const
            ).map(([key, label]) => {
              const error = errors[key] ? m.assets.invalid : undefined;
              return (
                <Field key={key} id={id(key)} label={label} error={error}>
                  <Input
                    id={id(key)}
                    value={form.branding[key]}
                    disabled={disabled}
                    inputMode="url"
                    spellCheck={false}
                    autoComplete="off"
                    placeholder="https://…"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? `${id(key)}-error` : undefined}
                    onChange={(event) => patchBranding({ [key]: event.target.value })}
                  />
                </Field>
              );
            })}
          </div>
        </Section>

        <Section id="layout" title={m.sections.layout}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id={id("header")} label={m.layout.headerVariant}>
              <Select
                id={id("header")}
                value={form.settings.headerVariant}
                disabled={disabled}
                onChange={(event) =>
                  patchSettings({ headerVariant: event.target.value as HeaderVariant })
                }
              >
                {options.headerVariants.map((value) => (
                  <option key={value} value={value}>
                    {m.layout.headerOptions[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id={id("footer")} label={m.layout.footerVariant}>
              <Select
                id={id("footer")}
                value={form.settings.footerVariant}
                disabled={disabled}
                onChange={(event) =>
                  patchSettings({ footerVariant: event.target.value as FooterVariant })
                }
              >
                {options.footerVariants.map((value) => (
                  <option key={value} value={value}>
                    {m.layout.footerOptions[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id={id("container")} label={m.layout.containerWidth}>
              <Select
                id={id("container")}
                value={form.settings.containerWidth}
                disabled={disabled}
                onChange={(event) =>
                  patchSettings({ containerWidth: event.target.value as ContainerWidth })
                }
              >
                {options.containerWidths.map((value) => (
                  <option key={value} value={value}>
                    {m.layout.containerOptions[value]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id={id("card")} label={m.layout.cardLayout}>
              <Select
                id={id("card")}
                value={form.settings.cardLayout}
                disabled={disabled}
                onChange={(event) =>
                  patchSettings({ cardLayout: event.target.value as CardLayout })
                }
              >
                {options.cardLayouts.map((value) => (
                  <option key={value} value={value}>
                    {m.layout.cardOptions[value]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Section>

        <Section
          id="announcement"
          title={m.sections.announcement}
          description={m.sections.announcementHelp}
        >
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={form.settings.announcementEnabled}
              disabled={disabled}
              onChange={(event) => patchSettings({ announcementEnabled: event.target.checked })}
              className="size-4"
            />
            <span>{m.announcement.enabled}</span>
          </label>
          <Field
            id={id("announcement-text")}
            label={m.announcement.text}
            error={errors["settings.announcementText"]}
            hint={m.announcement.textHint(
              form.settings.announcementText.length,
              options.announcementMaxLength,
            )}
          >
            <Input
              id={id("announcement-text")}
              value={form.settings.announcementText}
              disabled={disabled}
              maxLength={options.announcementMaxLength}
              aria-invalid={errors["settings.announcementText"] ? true : undefined}
              aria-describedby={
                errors["settings.announcementText"] ? `${id("announcement-text")}-error` : undefined
              }
              onChange={(event) => patchSettings({ announcementText: event.target.value })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id={id("announcement-href")}
              label={m.announcement.href}
              hint={m.announcement.hrefHelp}
              error={errors["settings.announcementHref"] ? m.announcement.hrefInvalid : undefined}
            >
              <Input
                id={id("announcement-href")}
                value={form.settings.announcementHref}
                disabled={disabled}
                inputMode="url"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={errors["settings.announcementHref"] ? true : undefined}
                aria-describedby={
                  errors["settings.announcementHref"]
                    ? `${id("announcement-href")}-error`
                    : undefined
                }
                onChange={(event) => patchSettings({ announcementHref: event.target.value })}
              />
            </Field>
            <Field id={id("announcement-tone")} label={m.announcement.tone}>
              <Select
                id={id("announcement-tone")}
                value={form.settings.announcementTone}
                disabled={disabled}
                onChange={(event) =>
                  patchSettings({ announcementTone: event.target.value as AnnouncementTone })
                }
              >
                {options.announcementTones.map((value) => (
                  <option key={value} value={value}>
                    {m.announcement.toneOptions[value]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Section>

        <Section id="css" title={m.sections.customCss} description={m.sections.customCssHelp}>
          <Field
            id={id("custom-css")}
            label={m.customCss.label}
            error={errors["customCss"]}
            hint={m.customCss.counter(form.branding.customCss.length, options.customCssMaxLength)}
          >
            <Textarea
              id={id("custom-css")}
              value={form.branding.customCss}
              disabled={disabled}
              rows={8}
              spellCheck={false}
              autoComplete="off"
              maxLength={options.customCssMaxLength}
              aria-invalid={errors["customCss"] ? true : undefined}
              aria-describedby={errors["customCss"] ? `${id("custom-css")}-error` : undefined}
              onChange={(event) => patchBranding({ customCss: event.target.value })}
              className="font-mono"
            />
          </Field>
        </Section>

        <SaveBar
          pending={pending}
          canSave={canSave}
          dirty={dirty}
          status={status}
          problem={problem}
          labels={{ save: m.save, saving: m.saving, unsavedMark: m.unsaved }}
        />
      </form>

      <Dialog
        open={pendingPreset !== undefined}
        onClose={() => setConfirmPreset(null)}
        title={m.preset.confirmTitle}
        description={m.preset.confirmBody}
        closeLabel={m.preset.close}
      >
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={() => setConfirmPreset(null)}>
            {m.preset.cancel}
          </Button>
          <Button
            type="button"
            onClick={() => {
              if (pendingPreset) {
                patchBranding(applyPreset(form.branding, pendingPreset.form));
              }
              setConfirmPreset(null);
            }}
          >
            {m.preset.confirm}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

/** Erorile temei din răspunsurile anterioare ale previzualizării (cele ale setărilor, care vin doar la salvare, rămân). */
function dropBrandingErrors(errors: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(errors).filter(([key]) => key.startsWith("settings.")));
}
