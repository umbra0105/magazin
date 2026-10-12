import type { ReactNode } from "react";
import { SentryClient } from "@/components/sentry-client";
import { fontVariableClasses } from "@/lib/fonts";
import "./globals.css";

/**
 * Tot ce se afișează depinde de baza de date (setări, branding, sesiune): nimic nu se prerandează la
 * build, altfel build-ul ar cere DB și ar îngheța conținutul magazinului în imaginea de build.
 */
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: scriptul de temă din admin setează `color-scheme` pe <html> înainte de hidratare.
    <html lang="ro" className={fontVariableClasses} suppressHydrationWarning>
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
