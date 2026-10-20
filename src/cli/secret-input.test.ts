import { describe, expect, it } from "vitest";
import { cleanPastedSecret } from "./secret-input.js";

describe("cleanPastedSecret", () => {
  it("drops control characters and bracketed-paste markers a terminal adds around a paste", () => {
    expect(cleanPastedSecret("\u001b[200~sk-ant-abc_123-XYZ\u001b[201~")).toBe("sk-ant-abc_123-XYZ");
    expect(cleanPastedSecret("\u0016sk-ant-abc\u0016")).toBe("sk-ant-abc");
    expect(cleanPastedSecret("  sk-ant-abc \r\n")).toBe("sk-ant-abc");
  });
});
