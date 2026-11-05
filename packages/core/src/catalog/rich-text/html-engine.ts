/*
 * Singurul loc care importă `sanitize-html`. Biblioteca nu are tipuri, iar `@types/sanitize-html` nu e în lista de
 * pachete aprobate pentru 15c: declarația minimă locală trebuie să fie vizibilă oricărui consumator care compilează
 * sursa din `@ecom/core` (aplicația web, joburi), nu doar pachetului `core`. De aceea referința de mai jos, într-un
 * singur fișier; restul modulului importă de aici.
 */
// eslint-disable-next-line @typescript-eslint/triple-slash-reference -- declarația ambientă trebuie încărcată și din afara pachetului core
/// <reference path="../../types/sanitize-html.d.ts" />
import sanitizeHtml, { type Attributes, type IOptions } from "sanitize-html";

export { sanitizeHtml, type Attributes, type IOptions };
