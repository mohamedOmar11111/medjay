import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonical.js";

describe("canonicalJson", () => {
  it("sorts object keys lexicographically at every depth", () => {
    const out = canonicalJson({ b: 1, a: { d: 4, c: [3, { z: 1, y: 2 }] } });
    expect(out).toBe('{"a":{"c":[3,{"y":2,"z":1}],"d":4},"b":1}');
  });

  it("is independent of key insertion order", () => {
    const one = canonicalJson({ x: 1, y: 2, z: { m: 1, n: 2 } });
    const two = canonicalJson({ z: { n: 2, m: 1 }, y: 2, x: 1 });
    expect(one).toBe(two);
  });

  it("emits no whitespace and preserves array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson({ a: [1, 2] })).not.toMatch(/\s/);
  });

  it("keeps non-ASCII text (Arabic) as-is without Unicode normalization", () => {
    const decomposed = "é"; // e + combining acute
    const composed = "é"; // precomposed e-acute
    expect(canonicalJson({ name: "عميل" })).toBe('{"name":"عميل"}');
    expect(canonicalJson(decomposed)).not.toBe(canonicalJson(composed));
  });

  it("escapes line breaks inside strings so output never contains a raw CR or LF", () => {
    const out = canonicalJson({ note: "line1\r\nline2\nline3" });
    expect(out).not.toMatch(/[\r\n]/);
    expect(out).toBe('{"note":"line1\\r\\nline2\\nline3"}');
  });

  it("serializes primitives and null", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(0)).toBe("0");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson(1.5)).toBe("1.5");
    expect(canonicalJson("x")).toBe('"x"');
  });

  it.each([
    ["undefined value", { a: undefined }],
    ["NaN", { a: Number.NaN }],
    ["Infinity", { a: Number.POSITIVE_INFINITY }],
    ["bigint", { a: 1n }],
    ["function", { a: () => 1 }],
    ["symbol", { a: Symbol("x") }],
    ["Date object", { a: new Date(0) }],
    ["class instance", { a: new (class Foo { x = 1 })() }],
  ])("rejects non-canonical input: %s", (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(/not canonical|not serializable|unsupported/i);
  });

  it("rejects circular structures", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(/circular/i);
  });
});
