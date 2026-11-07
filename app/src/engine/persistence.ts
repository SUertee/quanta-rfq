import { useCallback, useRef, useState, type SetStateAction } from 'react';

const prefix = 'quanta-workspace-v1:';
export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(prefix + key);
    return raw == null ? fallback : JSON.parse(raw, (_k, v) => v?.__quantaSet === true ? new Set(v.values) : v);
  } catch { return fallback; }
}

/** Write during the user action, not a delayed debounce or page-unload callback. */
export function useStoredState<T>(key: string, initial: T | (() => T)) {
  const [value, update] = useState<T>(() => readStored(key, typeof initial === 'function' ? (initial as () => T)() : initial));
  const latest = useRef(value);
  const setValue = useCallback((action: SetStateAction<T>) => {
    const next = typeof action === 'function' ? (action as (v: T) => T)(latest.current) : action;
    latest.current = next;
    try {
      localStorage.setItem(prefix + key, JSON.stringify(next, (_k, v) => v instanceof Set ? { __quantaSet: true, values: [...v] } : v));
    } catch {
      window.dispatchEvent(new Event('quanta-save-failed'));
    }
    update(next);
  }, [key]);
  return [value, setValue] as const;
}
