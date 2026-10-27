import { render } from "@react-email/render";
import { createElement } from "react";
import { emailMessagesRo as m } from "./messages";
import type { EmailTheme } from "./theme";
import { ActionEmail, type ActionEmailProps } from "./templates/action-email";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export type EmailContent =
  | { kind: "verify-email"; name: string; link: string; validForHours: number }
  | { kind: "reset-password"; name: string; link: string; validForMinutes: number }
  | { kind: "back-in-stock"; productTitle: string; variantLabel: string | null; link: string };

/** Subiectul și previzualizarea stau pe o singură linie, indiferent ce conține titlul produsului. */
const oneLine = (value: string): string => value.replace(/\s+/g, " ").trim();

function propsFor(theme: EmailTheme, content: EmailContent): ActionEmailProps {
  const footer = m.common.sentBy(theme.storeName);
  switch (content.kind) {
    case "verify-email":
      return {
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
      };
    case "reset-password":
      return {
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
      };
    case "back-in-stock":
      return {
        theme,
        preview: m.backInStock.preview(oneLine(content.productTitle)),
        heading: m.backInStock.heading,
        greeting: m.common.greeting(""),
        paragraphs: [
          m.backInStock.intro(oneLine(content.productTitle), content.variantLabel),
          m.backInStock.onlyMessage,
        ],
        buttonLabel: m.backInStock.button,
        link: content.link,
        linkFallback: m.common.linkFallback,
        ignoreNotice: m.backInStock.ignoreNotice,
        footer,
      };
  }
}

function subjectFor(theme: EmailTheme, content: EmailContent): string {
  switch (content.kind) {
    case "verify-email":
      return m.verifyEmail.subject(theme.storeName);
    case "reset-password":
      return m.resetPassword.subject(theme.storeName);
    case "back-in-stock":
      return m.backInStock.subject(oneLine(theme.storeName), oneLine(content.productTitle));
  }
}

/** Randează un email tranzacțional în HTML + variantă text, în română, cu tema dată. */
export async function renderEmail(
  theme: EmailTheme,
  content: EmailContent,
): Promise<RenderedEmail> {
  const element = createElement(ActionEmail, propsFor(theme, content));
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { subject: subjectFor(theme, content), html, text };
}
