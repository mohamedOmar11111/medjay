import { describe, expect, it } from "vitest";
import { connectGuide, hasModelKey, kickoffPrompt, readyText } from "./setup-guide.js";

describe("hasModelKey (reads `mdj auth status`)", () => {
  it("is true when any provider has a key, from the keychain or the environment", () => {
    expect(hasModelKey("anthropic              not set\nopenai                 keychain\ngoogle                 not set\n")).toBe(true);
    expect(hasModelKey("google                 env MEDJAY_GOOGLE_API_KEY\n")).toBe(true);
  });
  it("is false when every provider says not set, or the text is empty or unrelated", () => {
    expect(hasModelKey("anthropic              not set (OS keychain, or MEDJAY_ANTHROPIC_API_KEY)\nopenai                 not set\ngoogle                 not set\nopenai_compatible      not set\n")).toBe(false);
    expect(hasModelKey("")).toBe(false);
    expect(hasModelKey("error: something broke")).toBe(false);
  });
});

describe("connectGuide", () => {
  it("tells a beginner where to get a key for each provider, what to type, and that the keychain keeps it", () => {
    const t = connectGuide("en");
    for (const url of ["aistudio.google.com/apikey", "platform.openai.com/api-keys", "console.anthropic.com/settings/keys"]) expect(t).toContain(url);
    expect(t).toContain("/connect google");
    expect(t).toMatch(/keychain/i);
    expect(t).toMatch(/take over/i);
  });
  it("in Arabic keeps the command and the links in ASCII", () => {
    const t = connectGuide("ar");
    expect(t).toContain("/connect google");
    expect(t).toContain("aistudio.google.com/apikey");
    expect(t).toMatch(/[؀-ۿ]/);
  });
});

describe("kickoffPrompt", () => {
  it("asks the model to take over the setup with concrete steps: where to go, what to look at, what to save and where", () => {
    const t = kickoffPrompt("en");
    expect(t).toMatch(/workspace_readiness/);
    expect(t).toMatch(/where to go/i);
    expect(t).toMatch(/what to (look at|choose)/i);
    expect(t).toMatch(/what to save/i);
    expect(t).toMatch(/exact folder/i);
  });
  it("is Arabic for an Arabic owner", () => {
    expect(kickoffPrompt("ar")).toMatch(/[؀-ۿ]/);
    expect(kickoffPrompt("ar")).toContain("workspace_readiness");
  });
});

describe("readyText", () => {
  it("says the workspace is ready, where it is, and that the model takes over next", () => {
    const t = readyText("/home/me/Medjay/shop", "en");
    expect(t).toContain("/home/me/Medjay/shop");
    expect(t).toMatch(/ready/i);
  });
});
