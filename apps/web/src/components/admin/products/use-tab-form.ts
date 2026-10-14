"use client";

import { useCallback, useState } from "react";
import { useDirtyFlag } from "./unsaved-changes";

/**
 * Starea unui tab cu formular: valorile curente, valorile salvate ultima oară („baseline”) și
 * câmpurile modificate. Tabul își trimite DOAR câmpurile modificate (nu cele neatinse), ca o cerere
 * a unui Editor să nu conțină câmpuri interzise pe care nu le-a modificat. Declară automat starea
 * „modificat” pentru protecția la părăsirea paginii.
 */
export function useTabForm<T extends Record<string, string | boolean>>(
  initial: T,
  flagKey: string,
) {
  const [values, setValues] = useState<T>(initial);
  const [baseline, setBaseline] = useState<T>(initial);

  const changed = (Object.keys(values) as (keyof T)[]).filter(
    (key) => values[key] !== baseline[key],
  );
  const dirty = changed.length > 0;
  useDirtyFlag(flagKey, dirty);

  const set = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
  }, []);

  return {
    values,
    baseline,
    changed,
    dirty,
    set,
    /** Marchează valorile curente (sau cele date) ca salvate. */
    commit: (next?: T) => setBaseline(next ?? values),
  };
}
