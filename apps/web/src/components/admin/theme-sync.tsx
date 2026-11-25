"use client";

import { useLayoutEffect } from "react";
import { syncThemeFromStorage } from "@/lib/theme-choice";

/**
 * Aplică alegerea de temă salvată când layout-ul adminului se montează. Scriptul inline din layout (fără flash) rulează doar la
 * încărcarea completă a paginii; la navigarea pe client din pagina de autentificare spre admin nu rulează, iar interfața ar rămâne
 * pe tema sistemului deși meniul contului evidențiază alegerea salvată. Nu desenează nimic.
 */
export function ThemeSync() {
  useLayoutEffect(() => {
    syncThemeFromStorage();
  }, []);
  return null;
}
