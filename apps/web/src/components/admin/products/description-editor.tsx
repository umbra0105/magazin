"use client";

import Image from "@tiptap/extension-image";
import { Table, TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import {
  EditorContent,
  Mark,
  mergeAttributes,
  useEditor,
  useEditorState,
  type Editor,
} from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Subscript,
  Superscript,
  Table as TableIcon,
  Trash2,
  Underline,
  Undo2,
  Unlink,
  type LucideIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { Button, Dialog, Input, Select } from "@ecom/ui";
import { previewDescriptionImages } from "@/app/(admin)/admin/produse/editor-actions";
import { MediaPicker } from "@/components/admin/media/media-picker";
import { normalizeEditorHref } from "@/lib/editor-link";
import { getMessages } from "@/messages";

const t = getMessages().admin.products.editor.general.editor;

/**
 * Editorul vizual al descrierii (15c, pasul 6), pe Tiptap. Schema lui e o a doua listă albă, aliniată cu cea a serverului
 * (`rich-text/rules.ts`): titluri 2–4, aldin/cursiv/subliniat/tăiat, exponent/indice, liste, citat, linie, link, tabel, imagine
 * din biblioteca media. Comoditate, nu securitate: serverul refiltrează TOT la salvare (lista albă, linkuri, imagini).
 *
 *  - fără cod, fără blocuri de cod, fără imagini lipite din afară (doar `<img data-media-id>` din bibliotecă);
 *  - linkurile trec prin aceeași regulă ca la server (`normalizeEditorHref`); dialogurile sunt ale aplicației, nu ferestre native;
 *  - bara de unelte e un singur punct de Tab, cu săgeți / Home / End (șablonul «toolbar» din ARIA).
 */

/** Exponent (`<sup>`): marcaj propriu, fără pachet nou. */
const Superscript_ = Mark.create({
  name: "superscript",
  excludes: "subscript",
  parseHTML: () => [{ tag: "sup" }],
  renderHTML: ({ HTMLAttributes }) => ["sup", mergeAttributes(HTMLAttributes), 0],
});

/** Indice (`<sub>`). */
const Subscript_ = Mark.create({
  name: "subscript",
  excludes: "superscript",
  parseHTML: () => [{ tag: "sub" }],
  renderHTML: ({ HTMLAttributes }) => ["sub", mergeAttributes(HTMLAttributes), 0],
});

/** Imagine DOAR din biblioteca media: se recunoaște după `data-media-id`; o imagine fără el (lipită din altă parte) se ignoră. */
const LibraryImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      mediaId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-media-id"),
        renderHTML: (attributes: Record<string, unknown>) =>
          typeof attributes["mediaId"] === "string"
            ? { "data-media-id": attributes["mediaId"] }
            : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: "img[data-media-id]" }];
  },
}).configure({ allowBase64: false, inline: false });

const extensions = [
  StarterKit.configure({
    code: false,
    codeBlock: false,
    heading: { levels: [2, 3, 4] },
    link: {
      openOnClick: false,
      autolink: false,
      linkOnPaste: false,
      isAllowedUri: (url: string) => normalizeEditorHref(url) !== null,
    },
  }),
  Superscript_,
  Subscript_,
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader,
  TableCell,
  LibraryImage,
];

type Format = "paragraph" | "h2" | "h3" | "h4";

function toolbarState(editor: Editor) {
  const attrs = editor.getAttributes("image");
  return {
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    underline: editor.isActive("underline"),
    strike: editor.isActive("strike"),
    superscript: editor.isActive("superscript"),
    subscript: editor.isActive("subscript"),
    bulletList: editor.isActive("bulletList"),
    orderedList: editor.isActive("orderedList"),
    blockquote: editor.isActive("blockquote"),
    link: editor.isActive("link"),
    inTable: editor.isActive("table"),
    inImage: editor.isActive("image"),
    imageAlt: typeof attrs["alt"] === "string" ? (attrs["alt"] as string) : "",
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
    format: (editor.isActive("heading", { level: 2 })
      ? "h2"
      : editor.isActive("heading", { level: 3 })
        ? "h3"
        : editor.isActive("heading", { level: 4 })
          ? "h4"
          : "paragraph") as Format,
  };
}

export interface DescriptionEditorProps {
  /** Conținutul de pornire (HTML re-sanitizat de server, cu imaginile arătate prin previzualizare). */
  initialHtml: string;
  /** Fără drept de conținut, editorul e doar pentru citire (fără bară de unelte). */
  editable: boolean;
  id: string;
  invalid?: boolean;
  describedBy?: string | undefined;
  /** HTML-ul curent; șir gol când editorul e gol (serverul îl salvează ca NULL). */
  onChange: (html: string) => void;
}

export function DescriptionEditor({
  initialHtml,
  editable,
  id,
  invalid,
  describedBy,
  onChange,
}: DescriptionEditorProps) {
  const editor = useEditor({
    immediatelyRender: false,
    editable,
    content: initialHtml,
    extensions,
    editorProps: {
      attributes: {
        id,
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": t.contentLabel,
        ...(invalid && { "aria-invalid": "true" }),
        ...(describedBy && { "aria-describedby": describedBy }),
        class: "rich-text min-h-48 px-3 py-2 outline-none",
      },
    },
    onUpdate: ({ editor: current }) => onChange(current.isEmpty ? "" : current.getHTML()),
  });

  return (
    <div
      data-description-editor
      className="rounded-md border border-line-input bg-surface-page focus-within:ring-2 focus-within:ring-brand"
    >
      {editor && editable ? <Toolbar editor={editor} /> : null}
      <div className="overflow-x-auto">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

interface ToolProps {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
}

/**
 * Un clic pe butonul barei nu trebuie să mute focusul din editor (altfel selecția și tastarea următoare se pierd: `focus()` din Tiptap
 * revine abia în cadrul următor). De la tastatură, butonul primește focus normal, iar comanda îl duce înapoi în editor.
 */
const keepEditorFocus = (event: MouseEvent) => event.preventDefault();

/**
 * Editorul stă în formularul tabului General: un Enter într-un câmp al dialogurilor lui ar trimite acel formular (ar salva
 * produsul). De aceea dialogurile NU conțin <form>: Enter aplică dialogul, explicit, fără să urce mai departe.
 */
const onEnter = (action: () => void) => (event: KeyboardEvent<HTMLInputElement>) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  event.stopPropagation();
  action();
};

function Tool({ label, icon: Icon, onClick, pressed, disabled }: ToolProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      {...(pressed !== undefined && { "aria-pressed": pressed })}
      disabled={disabled ?? false}
      data-tool
      className="shrink-0 aria-pressed:bg-tone-neutral-bg aria-pressed:text-tone-neutral-fg"
      onMouseDown={keepEditorFocus}
      onClick={onClick}
    >
      <Icon aria-hidden className="size-4" />
    </Button>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: current }) => toolbarState(current),
  });
  const ref = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLElement | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const [rows, setRows] = useState("3");
  const [columns, setColumns] = useState("2");
  const [header, setHeader] = useState(true);
  const [tableError, setTableError] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [imageError, setImageError] = useState(false);

  // după orice dialog (link, tabel, imagine), focusul și selecția revin în editor: tastarea următoare nu poate ajunge în altă parte
  const dialogWasOpen = useRef(false);
  useEffect(() => {
    const open = linkOpen || tableOpen || pickerOpen;
    // `view.focus()` e sincron și păstrează selecția curentă; `commands.focus()` ar reface, în cadrul următor, o selecție veche
    if (dialogWasOpen.current && !open) editor.view.focus();
    dialogWasOpen.current = open;
  }, [linkOpen, tableOpen, pickerOpen, editor]);

  const items = (): HTMLElement[] =>
    Array.from(ref.current?.querySelectorAll<HTMLElement>("[data-tool]") ?? []);

  // un singur element al barei intră în ordinea de Tab (cel activ); celelalte se ajung cu săgeți
  useEffect(() => {
    const list = items();
    const current =
      activeRef.current && list.includes(activeRef.current) ? activeRef.current : list[0];
    for (const element of list) element.tabIndex = element === current ? 0 : -1;
  });

  const onFocus = (event: FocusEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!target.hasAttribute("data-tool")) return;
    activeRef.current = target;
    for (const element of items()) element.tabIndex = element === target ? 0 : -1;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    // un <select> folosește stânga/dreapta pentru opțiuni în unele browsere: acolo nu mutăm focusul
    if (target.tagName === "SELECT") return;
    const list = items();
    const index = list.indexOf(target);
    if (index < 0) return;
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % list.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + list.length) % list.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = list.length - 1;
    if (next < 0) return;
    event.preventDefault();
    list[next]?.focus();
  };

  const chain = () => editor.chain().focus();

  const openLink = () => {
    const href = editor.getAttributes("link")["href"];
    setLinkUrl(typeof href === "string" ? href : "");
    setLinkError(false);
    setLinkOpen(true);
  };

  const applyLink = () => {
    const href = normalizeEditorHref(linkUrl);
    if (href === null) {
      setLinkError(true);
      return;
    }
    if (editor.state.selection.empty && !editor.isActive("link")) {
      editor
        .chain()
        .insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] })
        .run();
    } else {
      editor.chain().extendMarkRange("link").setLink({ href }).run();
    }
    setLinkOpen(false);
  };

  const applyTable = () => {
    const r = Number(rows);
    const c = Number(columns);
    const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= 20;
    if (!valid(r) || !valid(c)) {
      setTableError(true);
      return;
    }
    editor.chain().insertTable({ rows: r, cols: c, withHeaderRow: header }).run();
    setTableOpen(false);
  };

  const insertImages = async (ids: string[]) => {
    setPickerOpen(false);
    setImageError(false);
    try {
      const result = await previewDescriptionImages({ ids });
      if (!result.ok || result.items.length === 0) {
        setImageError(true);
        return;
      }
      for (const item of result.items) {
        editor
          .chain()
          .insertContent({
            type: "image",
            attrs: { src: item.src, alt: item.alt, mediaId: item.id },
          })
          .run();
      }
    } catch {
      setImageError(true);
    }
  };

  const setFormat = (value: Format) => {
    if (value === "paragraph") chain().setParagraph().run();
    else
      chain()
        .setHeading({ level: Number(value.slice(1)) as 2 | 3 | 4 })
        .run();
  };

  return (
    <div className="border-b border-line-subtle">
      <div
        ref={ref}
        role="toolbar"
        aria-label={t.toolbarLabel}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        className="flex flex-wrap items-center gap-1 p-1.5"
      >
        <Select
          aria-label={t.format.label}
          data-tool
          className="h-(--control-h-compact) w-auto min-w-32 text-body"
          value={state.format}
          onChange={(event) => setFormat(event.target.value as Format)}
        >
          <option value="paragraph">{t.format.paragraph}</option>
          <option value="h2">{t.format.h2}</option>
          <option value="h3">{t.format.h3}</option>
          <option value="h4">{t.format.h4}</option>
        </Select>
        <span aria-hidden="true" data-tool-divider className="mx-1 h-5 w-px bg-line-subtle" />
        <Tool
          label={t.bold}
          icon={Bold}
          pressed={state.bold}
          onClick={() => chain().toggleBold().run()}
        />
        <Tool
          label={t.italic}
          icon={Italic}
          pressed={state.italic}
          onClick={() => chain().toggleItalic().run()}
        />
        <Tool
          label={t.underline}
          icon={Underline}
          pressed={state.underline}
          onClick={() => chain().toggleUnderline().run()}
        />
        <Tool
          label={t.strike}
          icon={Strikethrough}
          pressed={state.strike}
          onClick={() => chain().toggleStrike().run()}
        />
        <Tool
          label={t.superscript}
          icon={Superscript}
          pressed={state.superscript}
          onClick={() => chain().toggleMark("superscript").run()}
        />
        <Tool
          label={t.subscript}
          icon={Subscript}
          pressed={state.subscript}
          onClick={() => chain().toggleMark("subscript").run()}
        />
        <span aria-hidden="true" data-tool-divider className="mx-1 h-5 w-px bg-line-subtle" />
        <Tool
          label={t.bulletList}
          icon={List}
          pressed={state.bulletList}
          onClick={() => chain().toggleBulletList().run()}
        />
        <Tool
          label={t.orderedList}
          icon={ListOrdered}
          pressed={state.orderedList}
          onClick={() => chain().toggleOrderedList().run()}
        />
        <Tool
          label={t.blockquote}
          icon={Quote}
          pressed={state.blockquote}
          onClick={() => chain().toggleBlockquote().run()}
        />
        <Tool label={t.rule} icon={Minus} onClick={() => chain().setHorizontalRule().run()} />
        <span aria-hidden="true" data-tool-divider className="mx-1 h-5 w-px bg-line-subtle" />
        <Tool label={t.link} icon={LinkIcon} pressed={state.link} onClick={openLink} />
        <Tool
          label={t.unlink}
          icon={Unlink}
          disabled={!state.link}
          onClick={() => chain().extendMarkRange("link").unsetLink().run()}
        />
        <Tool
          label={t.table}
          icon={TableIcon}
          onClick={() => {
            setTableError(false);
            setTableOpen(true);
          }}
        />
        <Tool label={t.image} icon={ImageIcon} onClick={() => setPickerOpen(true)} />
        <span aria-hidden="true" data-tool-divider className="mx-1 h-5 w-px bg-line-subtle" />
        <Tool
          label={t.undo}
          icon={Undo2}
          disabled={!state.canUndo}
          onClick={() => chain().undo().run()}
        />
        <Tool
          label={t.redo}
          icon={Redo2}
          disabled={!state.canRedo}
          onClick={() => chain().redo().run()}
        />
        <Tool
          label={t.clear}
          icon={RemoveFormatting}
          onClick={() => chain().unsetAllMarks().clearNodes().run()}
        />
        {state.inTable ? (
          <div role="group" aria-label={t.tableTools.label} className="flex items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-tool
              onMouseDown={keepEditorFocus}
              onClick={() => chain().addRowAfter().run()}
            >
              {t.tableTools.addRow}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-tool
              onMouseDown={keepEditorFocus}
              onClick={() => chain().addColumnAfter().run()}
            >
              {t.tableTools.addColumn}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-tool
              onMouseDown={keepEditorFocus}
              onClick={() => chain().deleteRow().run()}
            >
              {t.tableTools.deleteRow}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-tool
              onMouseDown={keepEditorFocus}
              onClick={() => chain().deleteColumn().run()}
            >
              {t.tableTools.deleteColumn}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-tool
              onMouseDown={keepEditorFocus}
              onClick={() => chain().toggleHeaderRow().run()}
            >
              {t.tableTools.toggleHeader}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-tool
              onMouseDown={keepEditorFocus}
              aria-label={t.tableTools.deleteTable}
              onClick={() => chain().deleteTable().run()}
            >
              <Trash2 aria-hidden className="size-4" />
              <span className="sr-only">{t.tableTools.deleteTable}</span>
            </Button>
          </div>
        ) : null}
      </div>

      {state.inImage ? (
        <div className="flex items-center gap-2 border-t border-line-subtle p-2">
          <label htmlFor="description-image-alt" className="text-body">
            {t.imageAlt}
          </label>
          <Input
            id="description-image-alt"
            onKeyDown={onEnter(() => chain().run())}
            value={state.imageAlt}
            maxLength={300}
            className="h-(--control-h-compact)"
            onChange={(event) =>
              editor.chain().updateAttributes("image", { alt: event.target.value }).run()
            }
          />
        </div>
      ) : null}
      {imageError ? (
        <p role="alert" className="px-3 py-2 text-body text-tone-problem-fg">
          {t.imageFailed}
        </p>
      ) : null}

      <Dialog
        open={linkOpen}
        onClose={() => setLinkOpen(false)}
        title={t.linkDialog.title}
        closeLabel={t.linkDialog.close}
      >
        <div className="flex flex-col gap-3 p-4">
          <label htmlFor="description-link-url" className="text-body font-medium">
            {t.linkDialog.url}
          </label>
          <Input
            id="description-link-url"
            value={linkUrl}
            onChange={(event) => {
              setLinkUrl(event.target.value);
              setLinkError(false);
            }}
            aria-invalid={linkError || undefined}
            aria-describedby="description-link-help"
            onKeyDown={onEnter(applyLink)}
            autoComplete="off"
            autoFocus
          />
          <p id="description-link-help" className="text-label text-ink-secondary">
            {t.linkDialog.help}
          </p>
          {linkError ? (
            <p role="alert" data-problem className="text-body text-tone-problem-fg">
              {t.linkDialog.invalid}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setLinkOpen(false)}>
              {t.linkDialog.cancel}
            </Button>
            <Button type="button" onClick={applyLink}>
              {t.linkDialog.apply}
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog
        open={tableOpen}
        onClose={() => setTableOpen(false)}
        title={t.tableDialog.title}
        closeLabel={t.tableDialog.close}
      >
        <div className="flex flex-col gap-3 p-4">
          <label htmlFor="description-table-rows" className="text-body font-medium">
            {t.tableDialog.rows}
          </label>
          <Input
            id="description-table-rows"
            onKeyDown={onEnter(applyTable)}
            inputMode="numeric"
            value={rows}
            onChange={(event) => {
              setRows(event.target.value);
              setTableError(false);
            }}
            autoComplete="off"
          />
          <label htmlFor="description-table-columns" className="text-body font-medium">
            {t.tableDialog.columns}
          </label>
          <Input
            id="description-table-columns"
            onKeyDown={onEnter(applyTable)}
            inputMode="numeric"
            value={columns}
            onChange={(event) => {
              setColumns(event.target.value);
              setTableError(false);
            }}
            autoComplete="off"
          />
          <label className="flex items-center gap-2 text-body">
            <input
              type="checkbox"
              checked={header}
              onChange={(event) => setHeader(event.target.checked)}
            />
            {t.tableDialog.header}
          </label>
          {tableError ? (
            <p role="alert" data-problem className="text-body text-tone-problem-fg">
              {t.tableDialog.invalid}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setTableOpen(false)}>
              {t.tableDialog.cancel}
            </Button>
            <Button type="button" onClick={applyTable}>
              {t.tableDialog.insert}
            </Button>
          </div>
        </div>
      </Dialog>

      {/*
        Selectorul media are formulare proprii (căutare), iar editorul stă în formularul tabului General: îl randăm într-un
        portal (în afara formularului în DOM) și oprim propagarea «submit» în arborele React, ca o căutare să nu salveze produsul.
      */}
      {createPortal(
        <div onSubmit={(event) => event.stopPropagation()}>
          <MediaPicker
            open={pickerOpen}
            mode="single"
            title={t.imagePickerTitle}
            onClose={() => setPickerOpen(false)}
            onConfirm={(ids) => void insertImages(ids)}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}
