"use client";

import { useRef, useState } from "react";
import { MediaPicker } from "@/components/admin/media/media-picker";

/** Harness E2E pentru `MediaPicker`: deschide selectorul în moduri diferite și arată ce primește. */
export function PickerHarness() {
  const [mode, setMode] = useState<"single" | "multiple" | null>(null);
  const [max, setMax] = useState(3);
  const [initial, setInitial] = useState<string[]>([]);
  const [initialText, setInitialText] = useState("");
  const [result, setResult] = useState<string[] | null>(null);
  const [cancelled, setCancelled] = useState(0);
  const opener = useRef<HTMLButtonElement | null>(null);

  const open = (nextMode: "single" | "multiple", nextMax = 3) => {
    setMax(nextMax);
    setInitial(
      initialText
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
    setMode(nextMode);
  };

  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-xl font-semibold">Harness selector media (doar teste)</h1>
      <label className="flex flex-col gap-1 text-sm">
        Id-uri alese inițial (separate prin virgulă)
        <input
          value={initialText}
          onChange={(e) => setInitialText(e.target.value)}
          className="h-10 rounded-md border border-border bg-background px-2"
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          ref={opener}
          type="button"
          onClick={() => open("single")}
          className="h-10 rounded-md border border-border px-3"
        >
          Deschide selector (unic)
        </button>
        <button
          type="button"
          onClick={() => open("multiple", 3)}
          className="h-10 rounded-md border border-border px-3"
        >
          Deschide selector (multiplu, max 3)
        </button>
      </div>
      <p data-testid="cancelled">anulări: {cancelled}</p>
      <pre data-testid="result">{result === null ? "niciun rezultat" : JSON.stringify(result)}</pre>

      <MediaPicker
        open={mode !== null}
        mode={mode ?? "single"}
        max={max}
        initialSelectedIds={initial}
        onClose={() => {
          setMode(null);
          setCancelled((n) => n + 1);
        }}
        onConfirm={(ids) => {
          setResult(ids);
          setMode(null);
        }}
      />
    </main>
  );
}
