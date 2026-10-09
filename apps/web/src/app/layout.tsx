import type { ReactNode } from "react";
import { SentryClient } from "@/components/sentry-client";
import { fontVariableClasses } from "@/lib/fonts";
import "./globals.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ro" className={fontVariableClasses}>
      <head>
        {/* Tema din Branding. Render-blocking în <head> = fără flash de temă greșită. */}
        {/* eslint-disable-next-line @next/next/no-css-tags -- CSS generat dinamic de ruta /theme.css, nu un fișier din bundle */}
        <link rel="stylesheet" href="/theme.css" />
      </head>
      <body>
        {children}
        <SentryClient />
      </body>
    </html>
  );
}
