// Money in a platform API is an integer count of the currency's smallest unit (Meta's daily_budget
// "11500" is SAR 115.00). The factor comes from an EXPLICIT table, not from a locale database and not
// from "times 100": a currency that is not listed is refused rather than guessed, because a wrong
// factor on a Kuwaiti dinar budget is a 10x spend error. Add a currency here only after checking how
// the platform counts its minor units.
const FACTORS: Readonly<Record<string, number>> = Object.freeze({
  // two decimals
  SAR: 100,
  AED: 100,
  EGP: 100,
  QAR: 100,
  USD: 100,
  EUR: 100,
  GBP: 100,
  // three decimals
  KWD: 1000,
  BHD: 1000,
  OMR: 1000,
  JOD: 1000,
  // no decimals
  JPY: 1,
  KRW: 1,
});

/** Minor units per major unit, or null when the currency is not in the table. */
export function minorUnitFactor(currency: string): number | null {
  return Object.hasOwn(FACTORS, currency) ? (FACTORS[currency] as number) : null;
}

/** The amount in minor units, or null when the currency is unknown or the amount has more decimals than it can hold. */
export function toMinorUnits(amount: number, currency: string): number | null {
  const factor = minorUnitFactor(currency);
  if (factor === null || !Number.isFinite(amount) || amount < 0) return null;
  const minor = Math.round(amount * factor);
  return Math.abs(minor / factor - amount) < 1e-9 ? minor : null;
}
