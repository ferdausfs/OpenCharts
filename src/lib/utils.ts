import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(value: number, decimals = 2): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatNumber(value: number, decimals = 2): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

export function formatDate(date: string | Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(date));
}

export function formatDateFull(date: string | Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(date));
}

export function pnlClass(value: number): string {
  if (value > 0) return "text-success";
  if (value < 0) return "text-destructive";
  return "text-muted-foreground";
}

/**
 * Local calendar date as YYYY-MM-DD.
 *
 * `toISOString().slice(0, 10)` returns the UTC date, which is a different day
 * from the user's for most of the world — a date picker defaulting to it can
 * land on a day the app has no data for.
 */
export function toLocalDateString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * The calendar day after a YYYY-MM-DD date, as YYYY-MM-DD.
 *
 * Date arithmetic, not `+24h` clock math — on DST transition days a 24-hour
 * offset can land back on the same calendar date (25-hour day) or skip one
 * (23-hour day). Multi-day replay chains on this being exact.
 */
export function nextLocalDateString(dateStr: string): string {
  const parts = dateStr.split("-").map(Number);
  const date = new Date(parts[0] ?? 1970, (parts[1] ?? 1) - 1, parts[2] ?? 1);
  date.setDate(date.getDate() + 1);
  return toLocalDateString(date);
}
