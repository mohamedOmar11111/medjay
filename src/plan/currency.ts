// Money in a platform API is an integer count of the currency's smallest unit (Meta's daily_budget
// "11500" is SAR 115.00). The exponent comes from ISO 4217 as Intl knows it (SAR 2, JPY 0, KWD 3).
export function currencyExponent(currency: string): number {
  return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

/** The amount in minor units, or null when it has more decimals than the currency can hold. */
export function toMinorUnits(amount: number, currency: string): number | null {
  if (!Number.isFinite(amount) || amount < 0) return null;
  const scale = 10 ** currencyExponent(currency);
  const minor = Math.round(amount * scale);
  return Math.abs(minor / scale - amount) < 1e-9 ? minor : null;
}
