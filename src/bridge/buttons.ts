// Interactive button ids carry their own MAC, so a tap can only mean what the card that offered it
// said: action, plan number and plan hash prefix. Forging or editing one fails verification.
import { createHmac, timingSafeEqual } from "node:crypto";

export type ButtonAction = "STRIKE" | "HOLD" | "DROP";
const ACTIONS: readonly string[] = ["STRIKE", "HOLD", "DROP"];

const mac = (key: string, action: string, plan: number, hash: string) => createHmac("sha256", `medjay-button:${key}`).update(`${action}:${plan}:${hash}`, "utf8").digest("hex").slice(0, 16);

export function signButton(key: string, action: ButtonAction, plan: number, hash: string): string {
  return `${action}:${plan}:${hash}:${mac(key, action, plan, hash)}`;
}

export function verifyButton(key: string, id: string): { action: ButtonAction; plan: number; hash: string } | null {
  const parts = id.split(":");
  if (parts.length !== 4) return null;
  const [action, planText, hash, given] = parts as [string, string, string, string];
  const plan = Number(planText);
  if (!ACTIONS.includes(action) || !Number.isInteger(plan) || plan < 1 || !/^[0-9a-f]{8,64}$/.test(hash)) return null;
  const expected = Buffer.from(mac(key, action, plan, hash), "utf8");
  const actual = Buffer.from(given, "utf8");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return { action: action as ButtonAction, plan, hash };
}
