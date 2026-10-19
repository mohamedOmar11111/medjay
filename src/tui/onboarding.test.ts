import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { slugify, startOnboarding, stepOnboarding, type OnboardState } from "./onboarding.js";

const BASE = join("/work");

function run(inputs: string[], lang: "en" | "ar" = "en") {
  let { state, say } = startOnboarding(lang);
  const said = [say];
  let create: ReturnType<typeof stepOnboarding>["create"];
  for (const input of inputs) {
    const r = stepOnboarding(state, input, BASE);
    state = r.state;
    said.push(r.say);
    create = r.create ?? create;
  }
  return { state, said, create };
}

describe("onboarding conversation", () => {
  it("asks for name, business, currency, then confirms and returns the init command", () => {
    const r = run(["Etlaala KSA", "3", "1", "yes"]);
    expect(r.said[0]).toMatch(/What's your business or brand called\?/);
    expect(r.said[1]).toMatch(/What best describes you\?/);
    expect(r.said[2]).toMatch(/Which currency/);
    expect(r.said[3]).toContain('Create "Etlaala KSA"');
    expect(r.said[3]).toContain("SAR");
    expect(r.create).toEqual({
      dir: join(BASE, "etlaala-ksa"),
      argv: ["init", join(BASE, "etlaala-ksa"), "--id", "etlaala-ksa", "--name", "Etlaala KSA", "--business-type", "high_ticket_hybrid", "--currency", "SAR", "--timezone", "Asia/Riyadh", "--language", "en"],
      name: "Etlaala KSA",
    });
    expect(r.state.step).toBe("creating");
  });

  it("accepts a currency code typed out, and picks a timezone for the Gulf and Egypt", () => {
    expect(run(["A", "1", "AED", "yes"]).create!.argv).toEqual(expect.arrayContaining(["--currency", "AED", "--timezone", "Asia/Dubai"]));
    expect(run(["A", "1", "egp", "yes"]).create!.argv).toEqual(expect.arrayContaining(["--currency", "EGP", "--timezone", "Africa/Cairo"]));
    expect(run(["A", "1", "USD", "yes"]).create!.argv).toEqual(expect.arrayContaining(["--currency", "USD", "--timezone", "UTC"]));
  });

  it("re-asks on a bad answer and does not advance", () => {
    const r = run(["", "Shop", "9", "banana", "xyz"]);
    expect(r.said[1]).toMatch(/call it/i);
    expect(r.said[3]).toMatch(/1 to 5/);
    expect(r.said[4]).toMatch(/1 to 5/);
    expect(r.said[5]).toMatch(/1 to 5/);
    expect(r.state.step).toBe("business");
  });

  it("starts over on no", () => {
    const r = run(["A", "1", "SAR", "no"]);
    expect(r.state.step).toBe("name");
    expect(r.create).toBeUndefined();
  });

  it("switches to Arabic when the person types Arabic, and passes the language to init", () => {
    const r = run(["متجر الرياض", "1", "1", "نعم"]);
    expect(r.said[1]).toMatch(/[؀-ۿ]/);
    expect(r.create!.argv).toEqual(expect.arrayContaining(["--language", "ar", "--name", "متجر الرياض"]));
    expect(r.create!.argv).toContain(join(BASE, "متجر-الرياض"));
  });

  it("never lets a name become a flag or escape the folder", () => {
    const r = run(["--name ../../evil", "1", "SAR", "yes"]);
    const argv = r.create!.argv;
    expect(argv[argv.indexOf("--name") + 1]).toBe("name ../../evil");
    expect(r.create!.dir).toBe(join(BASE, "name-evil"));
  });
});

describe("slugify", () => {
  it("makes a safe folder and workspace id", () => {
    expect(slugify("Etlaala KSA!")).toBe("etlaala-ksa");
    expect(slugify("  ")).toBe("workspace");
    expect(slugify("../x")).toBe("x");
    expect(slugify("a".repeat(100))).toHaveLength(60);
  });
});

describe("state is a plain value", () => {
  it("does not mutate the state it is given", () => {
    const { state } = startOnboarding("en");
    const frozen: OnboardState = Object.freeze({ ...state });
    expect(() => stepOnboarding(frozen, "Shop", BASE)).not.toThrow();
  });
});
