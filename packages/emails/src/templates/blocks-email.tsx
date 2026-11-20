import { Button, Heading, Link, Text } from "@react-email/components";
import type { EmailBlock } from "../blocks";
import type { EmailTheme } from "../theme";
import { EmailLayout } from "./email-layout";

export interface BlocksEmailProps {
  theme: EmailTheme;
  preview: string;
  heading: string;
  greeting: string;
  /** Textul de început (cel suprascris sau cel implicit), în paragrafe. */
  intro: readonly string[];
  blocks: readonly EmailBlock[];
  footer: string;
  /** Previzualizare sau trimitere de test: banda cu date de probă, marcată clar. */
  sampleNotice?: string;
}

/** Emailul pe blocuri al comenzilor: același cadru, conținut structurat (paragrafe, butoane, tabele). Doar valori din temă. */
export function BlocksEmail(props: BlocksEmailProps) {
  const { theme } = props;
  const { colors } = theme;
  const text = { margin: "0 0 16px", fontSize: "16px", lineHeight: "24px", color: colors.fg };
  const small = { ...text, fontSize: "14px", lineHeight: "22px", margin: "0 0 8px" };
  const cell = {
    padding: "6px 0",
    fontSize: "14px",
    lineHeight: "20px",
    color: colors.fg,
    verticalAlign: "top" as const,
    borderBottom: `1px solid ${colors.border}`,
  };
  return (
    <EmailLayout theme={theme} preview={props.preview} footer={props.footer}>
      {props.sampleNotice ? (
        <Text
          style={{
            margin: "0 0 16px",
            padding: "8px 12px",
            fontSize: "13px",
            border: `1px dashed ${colors.border}`,
            color: colors.muted,
            borderRadius: `${theme.radiusPx}px`,
          }}
        >
          {props.sampleNotice}
        </Text>
      ) : null}
      <Heading
        as="h1"
        style={{ margin: "0 0 16px", fontSize: "22px", lineHeight: "30px", color: colors.fg }}
      >
        {props.heading}
      </Heading>
      <Text style={text}>{props.greeting}</Text>
      {props.intro.map((paragraph, index) => (
        <Text key={`intro-${index}`} style={text}>
          {paragraph}
        </Text>
      ))}
      {props.blocks.map((block, index) => {
        const key = `block-${index}`;
        switch (block.type) {
          case "paragraph":
            return (
              <Text
                key={key}
                style={{
                  ...(block.tone === "muted" ? small : text),
                  ...(block.tone === "muted" ? { color: colors.muted } : {}),
                  ...(block.tone === "strong" ? { fontWeight: 600 } : {}),
                }}
              >
                {block.text}
              </Text>
            );
          case "button":
            return (
              <div key={key} style={{ margin: "8px 0 16px" }}>
                <Button
                  href={block.link}
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
                  {block.label}
                </Button>
                <Text style={{ margin: "8px 0 0", fontSize: "13px", wordBreak: "break-all" }}>
                  <Link href={block.link} style={{ color: colors.primary }}>
                    {block.link}
                  </Link>
                </Text>
              </div>
            );
          case "section":
            return (
              <div key={key} style={{ margin: "20px 0 8px" }}>
                <Heading
                  as="h2"
                  style={{
                    margin: "0 0 8px",
                    fontSize: "16px",
                    lineHeight: "24px",
                    color: colors.fg,
                  }}
                >
                  {block.title}
                </Heading>
                {block.paragraphs.map((paragraph, i) => (
                  <Text key={`${key}-${i}`} style={small}>
                    {paragraph}
                  </Text>
                ))}
              </div>
            );
          case "keyvalue":
            return (
              <div key={key} style={{ margin: "16px 0" }}>
                {block.title ? (
                  <Heading
                    as="h2"
                    style={{
                      margin: "0 0 8px",
                      fontSize: "16px",
                      lineHeight: "24px",
                      color: colors.fg,
                    }}
                  >
                    {block.title}
                  </Heading>
                ) : null}
                <table role="presentation" width="100%" style={{ borderCollapse: "collapse" }}>
                  <tbody>
                    {block.rows.map((row) => (
                      <tr key={row.label}>
                        <td style={{ ...cell, color: colors.muted, width: "40%" }}>{row.label}</td>
                        <td style={cell}>{row.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "lines":
            return (
              <div key={key} style={{ margin: "16px 0" }}>
                <Heading
                  as="h2"
                  style={{
                    margin: "0 0 8px",
                    fontSize: "16px",
                    lineHeight: "24px",
                    color: colors.fg,
                  }}
                >
                  {block.title}
                </Heading>
                <table role="presentation" width="100%" style={{ borderCollapse: "collapse" }}>
                  <tbody>
                    {block.rows.map((row, i) => (
                      <tr key={`${row.title}-${i}`}>
                        <td style={cell}>
                          {row.title}
                          {row.detail ? (
                            <span
                              style={{ display: "block", color: colors.muted, fontSize: "13px" }}
                            >
                              {row.detail}
                            </span>
                          ) : null}
                        </td>
                        <td style={{ ...cell, whiteSpace: "nowrap", textAlign: "right" }}>
                          {row.quantity}
                        </td>
                        <td style={{ ...cell, whiteSpace: "nowrap", textAlign: "right" }}>
                          {row.amount}
                        </td>
                      </tr>
                    ))}
                    {block.totals.map((total) => (
                      <tr key={total.label}>
                        <td
                          colSpan={2}
                          style={{
                            ...cell,
                            borderBottom: "none",
                            textAlign: "right",
                            fontWeight: total.strong ? 700 : 400,
                          }}
                        >
                          {total.label}
                        </td>
                        <td
                          style={{
                            ...cell,
                            borderBottom: "none",
                            whiteSpace: "nowrap",
                            textAlign: "right",
                            fontWeight: total.strong ? 700 : 400,
                          }}
                        >
                          {total.value}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </EmailLayout>
  );
}
