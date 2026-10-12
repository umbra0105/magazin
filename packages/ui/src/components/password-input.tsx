"use client";

import { Eye, EyeOff } from "lucide-react";
import { useState, type Ref } from "react";
import { cn } from "../lib/cn";
import { Input, type InputProps } from "./input";

export interface PasswordInputProps extends Omit<InputProps, "type" | "ref"> {
  /** Textele butoanelor vin din fișierul de traduceri (nu sunt hardcodate aici). */
  showLabel: string;
  hideLabel: string;
  ref?: Ref<HTMLInputElement>;
}

/**
 * Câmp de parolă cu buton de afișare/ascundere. Butonul are `aria-pressed` și etichetă proprie,
 * nu iese din ordinea de tab și nu trimite formularul.
 */
export function PasswordInput({
  className,
  showLabel,
  hideLabel,
  ref,
  ...props
}: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        ref={ref}
        type={visible ? "text" : "password"}
        className={cn("pr-12", className)}
        // Fără corecții automate și majuscule pe un câmp de parolă.
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        {...props}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-pressed={visible}
        aria-label={visible ? hideLabel : showLabel}
        className={
          "absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-md text-muted-foreground " +
          "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        }
      >
        {visible ? (
          <EyeOff aria-hidden="true" className="size-5" />
        ) : (
          <Eye aria-hidden="true" className="size-5" />
        )}
      </button>
    </div>
  );
}
