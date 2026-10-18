// Leaf constants any layer may import.
export const SLOT_NAMES = ["fast", "reasoning", "creative"] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

/** A MEDJAY_* environment variable name: the only kind that may hold a credential or reference one. */
export const ENV_REF_PATTERN = /^MEDJAY_[A-Z0-9][A-Z0-9_]*$/;
/** A keychain account name. */
export const KEYCHAIN_REF_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

/** Where a model call's output goes. Lets us measure, per surface, what terse (caveman) output saves. */
export const USAGE_SURFACES = ["internal_narration", "whatsapp_reply", "client_copy", "diagnosis", "other"] as const;
export type UsageSurface = (typeof USAGE_SURFACES)[number];

const ISO_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

/** True for a known ISO 4217 currency code such as USD, SAR, EGP. */
export const isIsoCurrency = (code: string): boolean => /^[A-Z]{3}$/.test(code) && ISO_CURRENCIES.has(code);
