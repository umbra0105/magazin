import type { ReactNode } from "react";
import { SentryClient } from "@/components/sentry-client";
import "./globals.css";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ro">
      <body>
        {children}
        <SentryClient />
      </body>
    </html>
  );
}
