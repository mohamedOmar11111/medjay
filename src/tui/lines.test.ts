import { describe, expect, it } from "vitest";
import { lineSplitter } from "./lines.js";

describe("lineSplitter", () => {
  it("emits whole lines only, holding a partial line until it is finished", () => {
    const got: string[] = [];
    const s = lineSplitter((l) => got.push(l));
    s.push('{"a":1}\n{"b"');
    expect(got).toEqual(['{"a":1}']);
    s.push(':2}\n');
    expect(got).toEqual(['{"a":1}', '{"b":2}']);
  });
  it("handles Windows line endings and several lines in one chunk", () => {
    const got: string[] = [];
    const s = lineSplitter((l) => got.push(l));
    s.push("one\r\ntwo\r\nthree");
    expect(got).toEqual(["one", "two"]);
    s.end();
    expect(got).toEqual(["one", "two", "three"]);
  });
  it("end() with nothing buffered emits nothing", () => {
    const got: string[] = [];
    const s = lineSplitter((l) => got.push(l));
    s.push("x\n");
    s.end();
    expect(got).toEqual(["x"]);
  });
});
