import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnRunner } from "./runner.js";

function script(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mdj-runner-"));
  const file = join(dir, "child.mjs");
  writeFileSync(file, body);
  return file;
}

describe("spawnRunner stdin", () => {
  it("passes stdin to the child without putting it in argv", async () => {
    const cli = script('let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify({len:s.length,argvHasSecret:process.argv.join(" ").includes("sekret")})));');
    let out = "";
    const { code } = await spawnRunner(cli)(["auth", "set", "x"], (t) => (out += t), { stdin: "sekret-value" }).done;
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ len: 12, argvHasSecret: false });
  });

  it("gives a child started without the stdin option an empty stdin", async () => {
    const cli = script('let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(s.length));');
    let out = "";
    await spawnRunner(cli)([], (t) => (out += t)).done;
    expect(out.trim()).toBe("0");
  });
});
