import { strFromU8 } from "fflate";
import { DomainError } from "@ecom/shared";

/**
 * Verificarea FORMEI foilor dintr-un XLSX, ÎNAINTE ca biblioteca de citire să le transforme în tabel (Blocul C: C-01, C-04).
 *
 * `read-excel-file` construiește tabloul complet al foii înainte ca vreo limită a aplicației să poată fi aplicată: o
 * celulă ocupată la `XFD1048576` (1,4 KB de fișier) cere memorie cât să dărâme procesul, iar un șir partajat mare
 * referit de mii de celule sau zeci de MB de spații fac citirea să dureze minute. Aici foile se parcurg o singură dată,
 * liniar, fără să se construiască nimic, și se refuză fișierele cu:
 *  - o celulă CU VALOARE dincolo de `maxRows + 1` rânduri sau de `2 × maxColumns` coloane (celulele goale, doar cu
 *    stil, nu contează: Excel le scrie adesea);
 *  - un total de text expandat (șirurile partajate numărate la fiecare referință) peste `maxUncompressedBytes`;
 *  - spații/text în afara celulelor peste un plafon proporțional cu numărul de etichete (XML-ul scris de Excel nu are
 *    spațiu între etichete; cel indentat de alte programe are puțin);
 *  - prea multe etichete.
 * Scanerul respectă ghilimelele din atribute (un `>` într-o valoare nu închide eticheta), ca să nu poată fi păcălit
 * să vadă altă structură decât biblioteca; verificările de după citire rămân ca plasă de siguranță.
 */

export class XlsxShapeError extends DomainError {}

export interface ShapeLimits {
  maxRows: number;
  maxColumns: number;
  /** Plafonul de text expandat, în caractere (egal cu plafonul de octeți decomprimați). */
  maxUncompressedBytes: number;
}

/** Spațiu liber (în octeți) pentru indentare/antet înainte să conteze raportul pe etichetă. */
const PADDING_FIXED_BYTES = 2 * 1024 * 1024;
/** Octeți de spațiu per etichetă acceptați (indentare obișnuită: 2–12 caractere). */
const PADDING_BYTES_PER_TAG = 16;

const fail = (code: string, message: string): never => {
  throw new XlsxShapeError(code, message);
};

interface Tag {
  /** Numele în litere mici, fără prefix de spațiu de nume. */
  name: string;
  closing: boolean;
  selfClosing: boolean;
  /** Textul atributelor, brut. */
  attrs: string;
}

/**
 * Parcurge XML-ul într-o singură trecere: `onTag` pentru fiecare etichetă, `onText` pentru fiecare bucată de text
 * dintre etichete (cu începutul și sfârșitul). Comentariile, CDATA și instrucțiunile de procesare sunt sărite
 * (comentariile și instrucțiunile se numără ca text în afara celulelor).
 */
function scan(
  xml: string,
  onTag: (tag: Tag) => void,
  onText: (start: number, end: number) => void,
): void {
  const length = xml.length;
  let i = 0;
  while (i < length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      onText(i, length);
      return;
    }
    if (lt > i) onText(i, lt);
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      const stop = end < 0 ? length : end + 3;
      onText(lt, stop);
      i = stop;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      const stop = end < 0 ? length : end + 3;
      onText(lt + 9, end < 0 ? length : end);
      i = stop;
      continue;
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const end = xml.indexOf(">", lt + 2);
      const stop = end < 0 ? length : end + 1;
      onText(lt, stop);
      i = stop;
      continue;
    }
    // etichetă: sfârșitul = primul «>» care nu e între ghilimele
    let j = lt + 1;
    let quote = "";
    while (j < length) {
      const ch = xml[j];
      if (quote) {
        if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      j++;
    }
    if (j >= length) {
      onText(lt, length);
      return;
    }
    let inner = xml.slice(lt + 1, j);
    const closing = inner.startsWith("/");
    if (closing) inner = inner.slice(1);
    const selfClosing = inner.endsWith("/");
    if (selfClosing) inner = inner.slice(0, -1);
    const space = inner.search(/[\s]/);
    const rawName = space < 0 ? inner : inner.slice(0, space);
    const colon = rawName.indexOf(":");
    onTag({
      name: (colon < 0 ? rawName : rawName.slice(colon + 1)).toLowerCase(),
      closing,
      selfClosing,
      attrs: space < 0 ? "" : inner.slice(space),
    });
    i = j + 1;
  }
}

const attr = (attrs: string, name: string): string | null => {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attrs);
  return match ? (match[1] ?? match[2] ?? "") : null;
};

/** Lungimea (în caractere) a fiecărui șir partajat din `sharedStrings.xml`, în ordinea lor. */
export function sharedStringLengths(xml: string): number[] {
  const lengths: number[] = [];
  let inItem = false;
  let inText = false;
  let current = 0;
  scan(
    xml,
    (tag) => {
      if (tag.name === "si") {
        if (tag.closing || tag.selfClosing) {
          if (inItem || tag.selfClosing) lengths.push(current);
          inItem = false;
          current = 0;
        } else {
          inItem = true;
          current = 0;
        }
      } else if (tag.name === "t") {
        inText = inItem && !tag.closing && !tag.selfClosing;
      }
    },
    (start, end) => {
      if (inItem && inText) current += end - start;
    },
  );
  return lengths;
}

/** «AD12» → { column: 30, row: 12 } (coloana 1-based). */
export function parseCellRef(ref: string): { column: number; row: number } | null {
  const match = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(ref);
  if (!match) return null;
  let column = 0;
  for (const ch of (match[1] as string).toUpperCase())
    column = column * 26 + (ch.charCodeAt(0) - 64);
  return { column, row: Number(match[2]) };
}

export interface ShapeStats {
  tags: number;
  populatedCells: number;
  expandedText: number;
  paddingBytes: number;
  maxRow: number;
  maxColumn: number;
}

/** Verifică forma unei foi; aruncă `XlsxShapeError` la prima limită depășită. */
export function assertSheetShape(
  xml: string,
  sharedLengths: readonly number[],
  limits: ShapeLimits,
): ShapeStats {
  const maxRow = limits.maxRows + 1;
  const maxColumn = limits.maxColumns * 2;
  const maxTags = 6 * maxRow * limits.maxColumns;
  const stats: ShapeStats = {
    tags: 0,
    populatedCells: 0,
    expandedText: 0,
    paddingBytes: 0,
    maxRow: 0,
    maxColumn: 0,
  };

  let rowNo = 0;
  let columnNo = 0;
  let inCell = false;
  let cellType = "";
  let cellRow = 0;
  let cellColumn = 0;
  let cellLength = 0;
  let inValue = false;
  let inText = false;
  let inInline = false;

  const finishCell = () => {
    if (!inCell) return;
    inCell = false;
    if (cellLength <= 0) return;
    stats.populatedCells++;
    stats.expandedText += cellLength;
    if (cellRow > stats.maxRow) stats.maxRow = cellRow;
    if (cellColumn > stats.maxColumn) stats.maxColumn = cellColumn;
    if (cellRow > maxRow) {
      fail(
        "IMPORT_FILE_TOO_MANY_ROWS",
        `Fișierul are mai mult de ${limits.maxRows} de rânduri de date`,
      );
    }
    if (cellColumn > maxColumn) {
      fail(
        "IMPORT_FILE_TOO_MANY_COLUMNS",
        `Fișierul are mai mult de ${limits.maxColumns} de coloane`,
      );
    }
    if (stats.expandedText > limits.maxUncompressedBytes) {
      fail(
        "IMPORT_FILE_TOO_LARGE",
        `Textul din celulele fișierului XLSX depășește ${Math.round(limits.maxUncompressedBytes / (1024 * 1024))} MB (șirurile repetate se numără la fiecare folosire)`,
      );
    }
  };

  scan(
    xml,
    (tag) => {
      stats.tags++;
      if (stats.tags > maxTags) {
        fail("IMPORT_FILE_TOO_LARGE", "Foaia XLSX are un număr nerezonabil de elemente");
      }
      switch (tag.name) {
        case "row":
          if (!tag.closing) {
            const r = Number(attr(tag.attrs, "r") ?? Number.NaN);
            rowNo = Number.isInteger(r) && r > 0 ? r : rowNo + 1;
            columnNo = 0;
          }
          break;
        case "c":
          if (tag.closing) {
            finishCell();
            break;
          }
          finishCell();
          inCell = true;
          cellType = attr(tag.attrs, "t") ?? "";
          cellLength = 0;
          inValue = false;
          inInline = false;
          inText = false;
          {
            const ref = parseCellRef(attr(tag.attrs, "r") ?? "");
            if (ref) {
              cellRow = ref.row;
              cellColumn = ref.column;
              columnNo = ref.column;
              rowNo = ref.row;
            } else {
              columnNo += 1;
              cellRow = rowNo;
              cellColumn = columnNo;
            }
          }
          if (tag.selfClosing) finishCell();
          break;
        case "v":
          inValue = inCell && !tag.closing && !tag.selfClosing;
          break;
        case "is":
          inInline = inCell && !tag.closing && !tag.selfClosing;
          break;
        case "t":
          inText = inInline && !tag.closing && !tag.selfClosing;
          break;
        default:
          break;
      }
    },
    (start, end) => {
      const size = end - start;
      if (inCell && inValue) {
        const text = xml.slice(start, end).trim();
        if (cellType === "s") {
          const index = Number.parseInt(text, 10);
          cellLength += Number.isInteger(index) && index >= 0 ? (sharedLengths[index] ?? 0) : 0;
        } else {
          cellLength += text.length;
        }
      } else if (inCell && inText) {
        cellLength += size;
      } else {
        stats.paddingBytes += size;
        if (stats.paddingBytes > PADDING_FIXED_BYTES + PADDING_BYTES_PER_TAG * stats.tags) {
          fail(
            "IMPORT_FILE_TOO_LARGE",
            "Foaia XLSX conține spațiu sau text în afara celulelor în exces; fișierul pare deteriorat sau construit special",
          );
        }
      }
    },
  );
  finishCell();
  // verificare finală: spațiul de la coadă poate depăși plafonul calculat cu etichetele de până atunci
  if (stats.paddingBytes > PADDING_FIXED_BYTES + PADDING_BYTES_PER_TAG * stats.tags) {
    fail(
      "IMPORT_FILE_TOO_LARGE",
      "Foaia XLSX conține spațiu sau text în afara celulelor în exces; fișierul pare deteriorat sau construit special",
    );
  }
  return stats;
}

/** Verifică toate foile păstrate dintr-o arhivă XLSX deja desfăcută (`entries`: nume → octeți). */
export function assertWorkbookShape(
  entries: Readonly<Record<string, Uint8Array>>,
  limits: ShapeLimits,
): void {
  const shared = entries["xl/sharedStrings.xml"];
  const sharedLengths = shared ? sharedStringLengths(strFromU8(shared)) : [];
  for (const [name, bytes] of Object.entries(entries)) {
    if (!/^xl\/worksheets\/[^/]+\.xml$/.test(name)) continue;
    assertSheetShape(strFromU8(bytes), sharedLengths, limits);
  }
}
