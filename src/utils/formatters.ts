import { nanoid } from "nanoid";

/**
 * Format an integer amount (smallest currency unit) for display.
 * e.g. 150000 NGN → "₦1,500.00"
 */
export function formatAmount(amount: number, currency: string): string {
  const majorUnit = amount / 100;
  const symbols: Record<string, string> = {
    NGN: "₦",
    USD: "$",
    GHS: "₵",
    KES: "KSh ",
    ZAR: "R",
    GBP: "£",
    EUR: "€",
  };
  const symbol = symbols[currency] ?? `${currency} `;
  return `${symbol}${majorUnit.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
}

/** Generate a human-readable invoice code. e.g. INV-20240315-A3B2C */
export function generateInvoiceCode(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `INV-${date}-${nanoid(5).toUpperCase()}`;
}

/** Generate a human-readable payroll batch code. e.g. PAY-20240315-X9Y2Z */
export function generateBatchCode(): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `PAY-${date}-${nanoid(5).toUpperCase()}`;
}

/** Format a date for WhatsApp messages. */
export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** Normalize a WhatsApp phone to bare number (strip +, spaces, dashes). */
export function normalizePhone(phone: string): string {
  return phone.replace(/[\s+\-()]/g, "");
}

/** Build a divider line for WhatsApp formatting. */
export const DIVIDER = "─────────────────────────";
