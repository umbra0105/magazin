/**
 * Declarație MINIMĂ pentru `sanitize-html` 2.18.1 (biblioteca nu vine cu tipuri, iar `@types/sanitize-html` nu e
 * în lista de pachete aprobate pentru 15c). Conține doar ce folosește `catalog/rich-text`; la o actualizare a
 * bibliotecii se verifică împotriva documentației ei.
 */
declare module "sanitize-html" {
  export interface Attributes {
    [name: string]: string;
  }

  export interface Tag {
    tagName: string;
    attribs: Attributes;
    text?: string;
  }

  export interface Frame {
    tag: string;
    attribs: Attributes;
    text: string;
  }

  export type Transformer = (tagName: string, attribs: Attributes) => Tag;

  export interface IOptions {
    allowedTags?: readonly string[] | false;
    allowedAttributes?: Readonly<Record<string, readonly string[]>> | false;
    allowedSchemes?: readonly string[];
    allowedSchemesAppliedToAttributes?: readonly string[];
    allowProtocolRelative?: boolean;
    disallowedTagsMode?: "discard" | "escape" | "recursiveEscape" | "completelyDiscard";
    nonTextTags?: readonly string[];
    transformTags?: Readonly<Record<string, string | Transformer>>;
    exclusiveFilter?: (frame: Frame) => boolean | "excludeTag";
    nestingLimit?: number;
    parser?: { decodeEntities?: boolean };
    selfClosing?: readonly string[];
    onOpenTag?: (name: string, attribs: Attributes) => void;
  }

  export default function sanitizeHtml(dirty: string, options?: IOptions): string;
}
