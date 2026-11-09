"use client";

import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { cn } from "../lib/cn";
import {
  TOAST_DURATION_MS,
  addToast,
  autoDismisses,
  removeToast,
  type ToastInput,
  type ToastItem,
  type ToastTone,
} from "./toast-state";

interface ToastApi {
  /** Arată o notificare; întoarce id-ul ei (pentru `dismiss`). */
  notify: (input: ToastInput) => string;
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICONS: Record<ToastTone, typeof Info> = {
  success: CircleCheck,
  info: Info,
  warning: TriangleAlert,
  danger: CircleAlert,
};

const TONE_TEXT: Record<ToastTone, string> = {
  success: "text-tone-success-fg",
  info: "text-tone-info-fg",
  warning: "text-tone-warning-fg",
  danger: "text-tone-problem-fg",
};

/** Notificările scurte ale adminului: dreapta jos, 4 secunde, cu buton de închidere; erorile rămân până sunt închise. */
export function ToastProvider({
  closeLabel,
  children,
}: {
  /** Eticheta butonului de închidere (din traduceri). */
  closeLabel: string;
  children: ReactNode;
}) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: string) => setItems((list) => removeToast(list, id)), []);
  const notify = useCallback((input: ToastInput): string => {
    counter.current += 1;
    const id = `toast-${counter.current}`;
    setItems((list) => addToast(list, { ...input, id }));
    return id;
  }, []);
  const api = useMemo<ToastApi>(() => ({ notify, dismiss }), [notify, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        data-toast-viewport
        className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:left-auto sm:w-96"
      >
        {items.map((item) => (
          <ToastView key={item.id} item={item} closeLabel={closeLabel} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({
  item,
  closeLabel,
  onDismiss,
}: {
  item: ToastItem;
  closeLabel: string;
  onDismiss: (id: string) => void;
}) {
  const Icon = ICONS[item.tone];
  useEffect(() => {
    if (!autoDismisses(item.tone)) return;
    const timer = setTimeout(() => onDismiss(item.id), TOAST_DURATION_MS);
    return () => clearTimeout(timer);
  }, [item.id, item.tone, onDismiss]);

  return (
    <div
      // eroarea se anunță imediat (alert), restul politicos (status)
      role={item.tone === "danger" ? "alert" : "status"}
      data-toast={item.tone}
      className="pointer-events-auto flex w-full items-start gap-3 rounded-lg bg-surface-page p-3 text-ink shadow-popover"
    >
      <Icon aria-hidden="true" className={cn("mt-0.5 size-5 shrink-0", TONE_TEXT[item.tone])} />
      <div className="min-w-0 flex-1">
        <p className="text-body font-medium">{item.title}</p>
        {item.description ? (
          <p className="text-body text-ink-secondary">{item.description}</p>
        ) : null}
      </div>
      <button
        type="button"
        aria-label={closeLabel}
        onClick={() => onDismiss(item.id)}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-ink-secondary transition-colors duration-(--motion) hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error("useToast se folosește doar sub <ToastProvider>");
  return api;
}
