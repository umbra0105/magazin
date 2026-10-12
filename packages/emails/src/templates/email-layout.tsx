import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from "@react-email/components";
import type { ReactNode } from "react";
import type { EmailTheme } from "../theme";

/**
 * Cadrul comun al emailurilor: antet cu numele magazinului (sau logo), conținut, subsol. Stiluri
 * inline din `EmailTheme`, layout simplu cu un singur container (compatibil cu clienții de email).
 */
export function EmailLayout({
  theme,
  preview,
  footer,
  children,
}: {
  theme: EmailTheme;
  preview: string;
  footer: string;
  children: ReactNode;
}) {
  const { colors } = theme;
  return (
    <Html lang="ro">
      <Head />
      <Preview>{preview}</Preview>
      <Body
        style={{
          margin: 0,
          padding: "24px 0",
          backgroundColor: colors.bg,
          color: colors.fg,
          fontFamily: theme.fontFamily,
        }}
      >
        <Container
          style={{
            maxWidth: "560px",
            margin: "0 auto",
            backgroundColor: colors.bg,
            border: `1px solid ${colors.border}`,
            borderRadius: `${theme.radiusPx}px`,
            padding: "32px",
          }}
        >
          <Section>
            {theme.logoUrl ? (
              <Img src={theme.logoUrl} alt={theme.storeName} height="40" />
            ) : (
              <Text style={{ margin: 0, fontSize: "20px", fontWeight: 700, color: colors.fg }}>
                {theme.storeName}
              </Text>
            )}
          </Section>
          <Hr style={{ borderColor: colors.border, margin: "20px 0" }} />
          {children}
          <Hr style={{ borderColor: colors.border, margin: "24px 0 16px" }} />
          <Text style={{ margin: 0, fontSize: "12px", color: colors.muted }}>{footer}</Text>
        </Container>
      </Body>
    </Html>
  );
}
