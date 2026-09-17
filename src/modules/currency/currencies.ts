import { z } from "zod";

// App-level, NOT per-org — every tenant converts expenses against the same
// set. Restricted to what Frankfurter/ECB actually publish rates for;
// notably AED, SAR and RUB are NOT ECB-covered and are intentionally absent.
// Adding a currency here is the one place that needs to change — the schema
// (ExchangeRate.currency is a plain string) and the Frankfurter client don't.
export const SUPPORTED_CURRENCIES = [
  { code: "INR", name: "Indian Rupee" },
  { code: "USD", name: "United States Dollar" },
  { code: "EUR", name: "Euro" },
  { code: "GBP", name: "British Pound" },
  { code: "AUD", name: "Australian Dollar" },
  { code: "CAD", name: "Canadian Dollar" },
  { code: "SGD", name: "Singapore Dollar" },
  { code: "JPY", name: "Japanese Yen" },
  { code: "CHF", name: "Swiss Franc" },
  { code: "CNY", name: "Chinese Renminbi Yuan" },
  { code: "HKD", name: "Hong Kong Dollar" },
] as const;

export const SUPPORTED_CURRENCY_CODES = SUPPORTED_CURRENCIES.map((c) => c.code) as [
  (typeof SUPPORTED_CURRENCIES)[number]["code"],
  ...(typeof SUPPORTED_CURRENCIES)[number]["code"][],
];

export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number]["code"];

// The non-INR codes Frankfurter needs to be asked for a rate on — INR itself
// is always 1 and is never fetched or stored.
export const CONVERTIBLE_CURRENCY_CODES = SUPPORTED_CURRENCY_CODES.filter(
  (code): code is Exclude<CurrencyCode, "INR"> => code !== "INR",
);

// Validates any currency input (expense submission, this module's own
// routes) against the supported set — a code Frankfurter doesn't cover
// should fail at the boundary, not surface as a missing-rate error later.
export const currencyCodeSchema = z.enum(SUPPORTED_CURRENCY_CODES);
