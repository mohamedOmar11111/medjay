// Leaf constants any layer may import.
export const SLOT_NAMES = ["fast", "reasoning", "creative"] as const;
export type SlotName = (typeof SLOT_NAMES)[number];
