import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.js";

describe("parseCsv", () => {
  it("reads quoted cells, embedded commas, doubled quotes and newlines", () => {
    expect(parseCsv('a,b,c\n1,"x, y","say ""hi"""\n2,"line1\nline2",z\n')).toEqual([
      ["a", "b", "c"],
      ["1", "x, y", 'say "hi"'],
      ["2", "line1\nline2", "z"],
    ]);
  });
  it("handles CRLF, a BOM, a missing final newline and blank lines", () => {
    expect(parseCsv("﻿a,b\r\n1,2\r\n\r\n3,4")).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
  });
  it("supports tab and semicolon delimiters", () => {
    expect(parseCsv("a\tb\n1\t2", "\t")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv("a;b\n1;2", ";")).toEqual([["a", "b"], ["1", "2"]]);
  });
  it("keeps empty cells", () => {
    expect(parseCsv("a,b,c\n1,,3\n,,")).toEqual([["a", "b", "c"], ["1", "", "3"], ["", "", ""]]);
  });
  it("rejects an unterminated quote instead of swallowing the file", () => {
    expect(() => parseCsv('a,b\n1,"oops\n2,3')).toThrow(/unterminated/i);
  });
});
