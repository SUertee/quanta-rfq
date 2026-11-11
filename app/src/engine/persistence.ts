import {getAuth} from '../auth';
import { useCallback, useRef, useState, type SetStateAction } from 'react';

const prefix = 'quanta-workspace-v1:';
/** Every signed-in account has separate browser records and credentials. */
export function accountStorageKey(key: string): string {
  const accountId = getAuth()?.account.id;
  return accountId ? `quanta-account:${encodeURIComponent(accountId)}:${key}` : key;
}
export const workspaceStorageKey = (key: string) => accountStorageKey(prefix + key);
export function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(workspaceStorageKey(key));
    return raw == null ? fallback : JSON.parse(raw, (_k, v) => v?.__quantaSet === true ? new Set(v.values) : v);
  } catch { return fallback; }
}

/** Write during the user action, not a delayed debounce or page-unload callback. */
export function useStoredState<T>(key: string, initial: T | (() => T)) {
  const [value, update] = useState<T>(() => readStored(key, typeof initial === 'function' ? (initial as () => T)() : initial));
  const storageKey = workspaceStorageKey(key);
  const latest = useRef(value);
  const setValue = useCallback((action: SetStateAction<T>) => {
    const next = typeof action === 'function' ? (action as (v: T) => T)(latest.current) : action;
    latest.current = next;
    try {
      localStorage.setItem(storageKey, JSON.stringify(next, (_k, v) => v instanceof Set ? { __quantaSet: true, values: [...v] } : v));
    } catch {
      window.dispatchEvent(new Event('quanta-save-failed'));
    }
    update(next);
  }, [storageKey]);
  return [value, setValue] as const;
}
