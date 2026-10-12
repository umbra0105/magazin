"use client";

import { LogOut, Monitor, Moon, Sun, User } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@ecom/ui";
import { authErrorMessage, authPost } from "@/lib/auth-client";
import {
  THEME_CHOICES,
  applyThemeChoice,
  readThemeChoice,
  writeThemeChoice,
  type ThemeChoice,
} from "@/lib/theme-choice";
import { getMessages } from "@/messages";

const m = getMessages().admin;
const authMessages = getMessages().auth;

const THEME_ICONS = { system: Monitor, light: Sun, dark: Moon } as const;

/**
 * Meniul utilizatorului, ca „disclosure”: un buton cu `aria-expanded` care deschide un panou. Enter/Spațiu
 * îl deschid, Tab trece prin conținut, Escape îl închide și întoarce focusul pe buton, un click în
 * afară îl închide. Deconectarea e un buton care face POST (niciodată un link GET: un link ar
 * permite deconectarea de pe alt site).
 */
export function UserMenu({ email }: { email: string }) {
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<ThemeChoice>("system");
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Alegerea salvată se citește după montare (în try/catch, vezi theme-choice.ts).
    setChoice(readThemeChoice());
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  function chooseTheme(next: ThemeChoice) {
    setChoice(next);
    applyThemeChoice(next);
    writeThemeChoice(next); // dacă stocarea nu merge, alegerea rămâne valabilă pe pagina curentă
  }

  async function signOut() {
    setSigningOut(true);
    setError(null);
    const result = await authPost("/api/auth/sign-out", {});
    if (result.ok) {
      router.replace("/autentificare");
      router.refresh();
      return;
    }
    setSigningOut(false);
    setError(authErrorMessage(result, "login", authMessages));
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={m.userMenu.button}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={
          "flex h-11 items-center gap-2 rounded-md px-3 text-sm hover:bg-border/50 " +
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        }
      >
        <User aria-hidden="true" className="size-5" />
        <span className="hidden max-w-[12rem] truncate sm:inline">{email}</span>
      </button>
      <div
        id={panelId}
        hidden={!open}
        className="absolute right-0 z-50 mt-2 w-72 rounded-lg border border-border bg-background p-3 shadow-lg"
      >
        <p className="truncate px-2 pb-2 text-sm text-muted-foreground">{email}</p>
        <Link
          href="/cont"
          className="flex h-11 items-center rounded-md px-2 text-sm hover:bg-border/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {m.userMenu.account}
        </Link>
        <div role="group" aria-label={m.userMenu.theme} className="mt-2 px-2">
          <p className="pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {m.userMenu.theme}
          </p>
          <div className="flex gap-1">
            {THEME_CHOICES.map((option) => {
              const Icon = THEME_ICONS[option];
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={choice === option}
                  onClick={() => chooseTheme(option)}
                  className={cn(
                    "flex h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-md border border-border text-xs " +
                      "hover:bg-border/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
                    choice === option && "border-primary bg-border/50 font-semibold",
                  )}
                >
                  <Icon aria-hidden="true" className="size-4" />
                  {m.theme[option]}
                </button>
              );
            })}
          </div>
        </div>
        {error ? (
          <p role="alert" className="mt-2 px-2 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <button
          type="button"
          onClick={signOut}
          disabled={signingOut}
          className={
            "mt-2 flex h-11 w-full items-center gap-2 rounded-md px-2 text-sm hover:bg-border/50 disabled:opacity-60 " +
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          }
        >
          <LogOut aria-hidden="true" className="size-4" />
          {signingOut ? m.userMenu.signingOut : m.userMenu.signOut}
        </button>
      </div>
    </div>
  );
}
