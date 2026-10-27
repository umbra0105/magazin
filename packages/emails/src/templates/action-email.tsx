import { Button, Heading, Link, Text } from "@react-email/components";
import type { EmailTheme } from "../theme";
import { EmailLayout } from "./email-layout";

export interface ActionEmailProps {
  theme: EmailTheme;
  preview: string;
  heading: string;
  greeting: string;
  paragraphs: readonly string[];
  buttonLabel: string;
  link: string;
  linkFallback: string;
  /** Cât e valabil linkul; lipsește la mesajele fără expirare (de exemplu linkul spre un produs) */
  validity?: string;
  ignoreNotice: string;
  footer: string;
}

/** Emailul „un buton către un link” (verificare, resetare): același aspect, texte diferite. */
export function ActionEmail(props: ActionEmailProps) {
  const { theme } = props;
  const { colors } = theme;
  const text = { margin: "0 0 16px", fontSize: "16px", lineHeight: "24px", color: colors.fg };
  return (
    <EmailLayout theme={theme} preview={props.preview} footer={props.footer}>
      <Heading
        as="h1"
        style={{ margin: "0 0 16px", fontSize: "22px", lineHeight: "30px", color: colors.fg }}
      >
        {props.heading}
      </Heading>
      <Text style={text}>{props.greeting}</Text>
      {props.paragraphs.map((paragraph) => (
        <Text key={paragraph} style={text}>
          {paragraph}
        </Text>
      ))}
      <Button
        href={props.link}
        style={{
          display: "inline-block",
          backgroundColor: colors.primary,
          color: colors.primaryFg,
          borderRadius: `${theme.radiusPx}px`,
          padding: "12px 20px",
          fontSize: "16px",
          fontWeight: 600,
          textDecoration: "none",
        }}
      >
        {props.buttonLabel}
      </Button>
      {props.validity ? (
        <Text style={{ ...text, margin: "20px 0 8px", fontSize: "14px", color: colors.muted }}>
          {props.validity}
        </Text>
      ) : null}
      <Text
        style={{
          ...text,
          margin: props.validity ? "0 0 4px" : "20px 0 4px",
          fontSize: "14px",
          color: colors.muted,
        }}
      >
        {props.linkFallback}
      </Text>
      <Text style={{ margin: "0 0 16px", fontSize: "13px", wordBreak: "break-all" }}>
        <Link href={props.link} style={{ color: colors.primary }}>
          {props.link}
        </Link>
      </Text>
      <Text style={{ ...text, fontSize: "14px", color: colors.muted }}>{props.ignoreNotice}</Text>
    </EmailLayout>
  );
}
