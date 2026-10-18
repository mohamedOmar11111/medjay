import type { KeyStore } from "../../src/models/credentials.js";

export function memoryKeystore(initial: Record<string, string> = {}): KeyStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    async get(account) {
      return data.get(account) ?? null;
    },
    async set(account, secret) {
      data.set(account, secret);
    },
    async delete(account) {
      return data.delete(account);
    },
  };
}

export const brokenKeystore: KeyStore = {
  async get() {
    throw new Error("no secret service available");
  },
  async set() {
    throw new Error("no secret service available");
  },
  async delete() {
    throw new Error("no secret service available");
  },
};
