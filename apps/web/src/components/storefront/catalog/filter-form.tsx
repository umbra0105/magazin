"use client";

import { useRef, type ReactNode } from "react";

/**
 * Formularul de filtre: un `<form method="get">` obișnuit (funcționează fără JavaScript, cu butonul «Aplică filtrele»). Cu
 * JavaScript, o casetă bifată sau un glisor mutat aplică filtrele singur, după o scurtă pauză (alegeri succesive nu
 * trimit mai multe cereri). Nu folosește `required` și nici validare nativă (`noValidate`): câmpurile sunt opționale.
 */
export function FilterForm({
  action,
  children,
  className,
}: {
  action: string;
  children: ReactNode;
  className?: string;
}) {
  const form = useRef<HTMLFormElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedule = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => form.current?.requestSubmit(), 450);
  };

  return (
    <form
      ref={form}
      action={action}
      method="get"
      noValidate
      className={className}
      onChange={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement)) return;
        // casetele și glisoarele aplică singure; câmpurile numerice se aplică cu Enter sau cu butonul (nu la fiecare tastă)
        if (target.type === "checkbox" || target.type === "range") schedule();
      }}
    >
      {children}
    </form>
  );
}
