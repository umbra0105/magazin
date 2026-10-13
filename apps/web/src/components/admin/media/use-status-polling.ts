"use client";

import { useEffect, useRef } from "react";
import { getMediaStatuses } from "@/app/(admin)/admin/media/actions";
import type { LibraryItem } from "./media-types";

const POLL_MS = 3000;

/**
 * Interoghează periodic starea fișierelor `ids` (cât timp lista nu e goală) și raportează ce a
 * primit. Folosit de bibliotecă (fișierele pending/processing din pagină) și de selector (fișierele
 * încărcate din el, până devin `ready`). O interogare ratată nu strică nimic: următoarea reia.
 */
export function useStatusPolling(ids: readonly string[], onItems: (items: LibraryItem[]) => void) {
  const callback = useRef(onItems);
  callback.current = onItems;
  const key = ids.join(",");

  useEffect(() => {
    if (key === "") return;
    const list = key.split(",");
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const result = await getMediaStatuses(list);
        if (!cancelled && result.ok) callback.current(result.items);
      } catch {
        // următoarea interogare încearcă din nou
      }
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [key]);
}
