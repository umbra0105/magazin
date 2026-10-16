"use client";

import { useId, useState, type InputHTMLAttributes, type ReactNode, type Ref } from "react";
import { cn } from "../lib/cn";
import { describeFiles } from "../lib/file-size";
import { buttonVariants } from "./button";

export interface FileInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "onChange" | "className" | "children" | "value" | "defaultValue" | "id" | "size"
> {
  /** Obligatoriu: legătura cu `<Label htmlFor>` a câmpului. */
  id: string;
  ref?: Ref<HTMLInputElement>;
  /** Textul butonului vizibil (implicit «Alege fișierul» / «Alege fișierele»). */
  buttonLabel?: string;
  /** Conținutul butonului, în locul textului (ex. o pictogramă + text pentru cititoare de ecran). */
  children?: ReactNode;
  /** Textul când nu e ales nimic (implicit «Niciun fișier ales»). */
  emptyLabel?: string;
  /** Nu arată textul cu fișierul ales (butoane de acțiune într-un rând, panouri cu propria listă). */
  hideStatus?: boolean;
  /** După alegere golește câmpul, ca același fișier să poată fi ales din nou. */
  clearAfterChange?: boolean;
  variant?: "default" | "outline" | "ghost";
  size?: "default" | "sm";
  /** Apelat cu fișierele alese (gol dacă alegerea s-a anulat). */
  onFilesChange?: (files: File[]) => void;
  className?: string;
}

/**
 * ÎNLOCUIEȘTE `<input type="file">` în toată aplicația (testul de arhitectură interzice varianta
 * directă): câmpul nativ afișează «Choose File / No file chosen» în limba browserului, greu de distins
 * pe fundal alb. Aici câmpul REAL rămâne în pagină (ascuns vizual, dar focusabil și accesibil de la
 * tastatură; se trimite în formulare și merge cu `ref`), iar `<label htmlFor>` îl arată ca un buton
 * cu inel de focus, în română. Textul cu fișierul ales și mărimea lui e o regiune `aria-live`.
 * Pentru a goli câmpul după o acțiune reușită, se schimbă `key`-ul componentei.
 */
export function FileInput({
  id,
  ref,
  buttonLabel,
  children,
  emptyLabel = "Niciun fișier ales",
  hideStatus = false,
  clearAfterChange = false,
  variant = "outline",
  size = "default",
  onFilesChange,
  className,
  multiple,
  disabled,
  ...rest
}: FileInputProps) {
  const statusId = useId();
  const [files, setFiles] = useState<File[]>([]);
  const label = buttonLabel ?? (multiple ? "Alege fișierele" : "Alege fișierul");
  const describedBy = [rest["aria-describedby"], hideStatus ? undefined : statusId]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      <input
        {...rest}
        ref={ref}
        id={id}
        type="file"
        multiple={multiple}
        disabled={disabled}
        aria-describedby={describedBy || undefined}
        className="peer sr-only"
        onChange={(event) => {
          const chosen = [...(event.target.files ?? [])];
          onFilesChange?.(chosen);
          if (clearAfterChange) {
            event.target.value = "";
            setFiles([]);
          } else setFiles(chosen);
        }}
      />
      <label
        htmlFor={id}
        className={cn(
          buttonVariants({ variant, size }),
          "cursor-pointer peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background peer-disabled:pointer-events-none peer-disabled:opacity-60",
        )}
      >
        {children ?? label}
      </label>
      {!hideStatus && (
        <span
          id={statusId}
          role="status"
          aria-live="polite"
          className="min-w-0 break-all text-sm text-muted-foreground"
        >
          {describeFiles(files, {
            empty: emptyLabel,
            many: (count, total) => `${count} fișiere alese (${total})`,
          })}
        </span>
      )}
    </div>
  );
}
