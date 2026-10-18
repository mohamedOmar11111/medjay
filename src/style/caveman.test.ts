import { describe, expect, it } from "vitest";
import { ALWAYS_PLAIN_SURFACES, cavemanDirective, directiveFor, resolveLevel, StyleConfigSchema } from "./caveman.js";

const config = (over: Record<string, unknown> = {}) => StyleConfigSchema.parse({ caveman: { internal: "full", whatsapp: "lite", ...over } });

describe("cavemanDirective", () => {
  it("is empty when off and differs by level", () => {
    expect(cavemanDirective("off")).toBe("");
    const [lite, full, ultra] = [cavemanDirective("lite"), cavemanDirective("full"), cavemanDirective("ultra")];
    expect(new Set([lite, full, ultra]).size).toBe(3);
    expect(lite).toMatch(/keep articles|full sentences/i);
    expect(full).toMatch(/drop articles/i);
    expect(ultra).toMatch(/abbreviat/i);
  });

  it("always protects numbers, ids, sources, quoted errors and code", () => {
    for (const level of ["lite", "full", "ultra"] as const) {
      expect(cavemanDirective(level), level).toMatch(/numbers/i);
      expect(cavemanDirective(level), level).toMatch(/sources? and dates?|citation/i);
      expect(cavemanDirective(level), level).toMatch(/error/i);
    }
  });

  it("always carries the plain-language exceptions for warnings and irreversible actions", () => {
    for (const level of ["lite", "full", "ultra"] as const) {
      expect(cavemanDirective(level), level).toMatch(/warning/i);
      expect(cavemanDirective(level), level).toMatch(/irreversible/i);
      expect(cavemanDirective(level), level).toMatch(/order matters|multi-step/i);
    }
  });

  it("is deterministic", () => {
    expect(cavemanDirective("full")).toBe(cavemanDirective("full"));
  });
});

describe("resolveLevel and directiveFor", () => {
  it("uses the configured level per surface", () => {
    expect(resolveLevel(config(), "internal")).toBe("full");
    expect(resolveLevel(config(), "whatsapp")).toBe("lite");
    expect(resolveLevel(config({ internal: "ultra" }), "internal")).toBe("ultra");
    expect(resolveLevel(config({ internal: "off" }), "internal")).toBe("off");
  });

  it("never applies to client copy, approvals, or security and spend warnings", () => {
    expect([...ALWAYS_PLAIN_SURFACES].sort()).toEqual(["approval", "client_copy", "security"]);
    for (const surface of ALWAYS_PLAIN_SURFACES) {
      expect(resolveLevel(config({ internal: "ultra", whatsapp: "ultra" }), surface), surface).toBe("off");
      expect(directiveFor(config({ internal: "ultra" }), surface, "en"), surface).toBe("");
    }
  });

  it("caps non-English output at lite, because the heavier levels are only defined for English", () => {
    expect(resolveLevel(config({ internal: "ultra" }), "internal", "ar")).toBe("lite");
    expect(resolveLevel(config({ internal: "full" }), "internal", "ar")).toBe("lite");
    expect(resolveLevel(config({ internal: "off" }), "internal", "ar")).toBe("off");
    expect(resolveLevel(config({ internal: "ultra" }), "internal", "en")).toBe("ultra");
  });

  it("tells the model to keep the user's language for non-English", () => {
    expect(directiveFor(config(), "internal", "ar")).toMatch(/language/i);
  });

  it("returns the directive text for configurable surfaces", () => {
    expect(directiveFor(config(), "internal", "en")).toBe(cavemanDirective("full"));
  });
});

describe("StyleConfigSchema", () => {
  it("defaults to full for internal prose and lite for WhatsApp, with slop checks on", () => {
    const parsed = StyleConfigSchema.parse({});
    expect(parsed.caveman).toEqual({ internal: "full", whatsapp: "lite" });
    expect(parsed.slop).toMatchObject({ fail_on: "error", extra_banned: [], allow: [] });
  });

  it("accepts the four levels and rejects others", () => {
    for (const level of ["off", "lite", "full", "ultra"]) expect(StyleConfigSchema.safeParse({ caveman: { internal: level } }).success).toBe(true);
    expect(StyleConfigSchema.safeParse({ caveman: { internal: "extreme" } }).success).toBe(false);
  });

  it("refuses to configure the always-plain surfaces", () => {
    for (const key of ["client_copy", "approval", "security"]) {
      expect(StyleConfigSchema.safeParse({ caveman: { [key]: "ultra" } }).success, key).toBe(false);
    }
  });

  it("validates slop settings", () => {
    expect(StyleConfigSchema.safeParse({ slop: { packs: ["protocol", "ar"], fail_on: "warn", allow: ["navigate"], extra_banned: [{ phrase: "x", suggestion: "y" }] } }).success).toBe(true);
    expect(StyleConfigSchema.safeParse({ slop: { packs: ["mystery"] } }).success).toBe(false);
    expect(StyleConfigSchema.safeParse({ slop: { fail_on: "never" } }).success).toBe(false);
    expect(StyleConfigSchema.safeParse({ slop: { extra_banned: [{ phrase: "" }] } }).success).toBe(false);
  });
});
