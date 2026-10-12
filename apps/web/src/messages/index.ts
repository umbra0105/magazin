import { ro, type Messages } from "./ro";

/**
 * Mesajele aplicației. Deocamdată o singură limbă (română); când se adaugă una nouă, alegerea se
 * face aici după `regional.locale` din setări, fără să se schimbe componentele.
 */
export function getMessages(): Messages {
  return ro;
}

export { ro };
export type { Messages };
