import { render } from "@react-email/render";
import { createElement } from "react";
import { emailMessagesRo as m } from "./messages";
import type { EmailTheme } from "./theme";
import { ActionEmail } from "./templates/action-email";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export type EmailContent =
  | { kind: "verify-email"; name: string; link: string; validForHours: number }
  | { kind: "reset-password"; name: string; link: string; validForMinutes: number };

/** Randează un email tranzacțional în HTML + variantă text, în română, cu tema dată. */
export async function renderEmail(
  theme: EmailTheme,
  content: EmailContent,
): Promise<RenderedEmail> {
  const footer = m.common.sentBy(theme.storeName);
  const element =
    content.kind === "verify-email"
      ? createElement(ActionEmail, {
          theme,
          preview: m.verifyEmail.preview,
          heading: m.verifyEmail.heading,
          greeting: m.common.greeting(content.name),
          paragraphs: [m.verifyEmail.intro(theme.storeName)],
          buttonLabel: m.verifyEmail.button,
          link: content.link,
          linkFallback: m.common.linkFallback,
          validity: m.verifyEmail.validity(content.validForHours),
          ignoreNotice: m.common.ignoreNotice,
          footer,
        })
      : createElement(ActionEmail, {
          theme,
          preview: m.resetPassword.preview,
          heading: m.resetPassword.heading,
          greeting: m.common.greeting(content.name),
          paragraphs: [m.resetPassword.intro(theme.storeName), m.resetPassword.afterNotice],
          buttonLabel: m.resetPassword.button,
          link: content.link,
          linkFallback: m.common.linkFallback,
          validity: m.resetPassword.validity(content.validForMinutes),
          ignoreNotice: m.common.ignoreNotice,
          footer,
        });
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  const subject =
    content.kind === "verify-email"
      ? m.verifyEmail.subject(theme.storeName)
      : m.resetPassword.subject(theme.storeName);
  return { subject, html, text };
}
