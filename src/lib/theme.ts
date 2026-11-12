/**
 * Theme preference.
 *
 * Persisted in localStorage and applied as a `light` class on <html>. The
 * default is dark (the terminal look); `light` activates the `.light` CSS
 * block in global.css and the CHART_COLORS.light chart palette.
 *
 * All writes go through setTheme(), so components can subscribe with
 * useSyncExternalStore and re-render on switches without a MutationObserver.
 */

export type ThemePref = "dark" | "light";

const KEY = "theme";
const listeners = new Set<() => void>();

function read(): ThemePref {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function apply(pref: ThemePref): void {
  document.documentElement.classList.toggle("light", pref === "light");
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function getTheme(): ThemePref {
  return read();
}

/** Snapshot for useSyncExternalStore. */
export function isDarkTheme(): boolean {
  return read() === "dark";
}

export function setTheme(pref: ThemePref): void {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* private mode — still apply for this session */
  }
  apply(pref);
  emit();
}

export function toggleTheme(): void {
  setTheme(read() === "dark" ? "light" : "dark");
}

export function subscribeTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Apply the persisted theme once at startup, before the first paint. */
export function initTheme(): void {
  apply(read());
}
