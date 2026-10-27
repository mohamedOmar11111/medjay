import { describe, expect, it } from "vitest";
import { MIN_NODE, nodeProblem, quietSqliteWarning } from "./node-check.js";

describe("nodeProblem", () => {
  it("accepts Node 22.13 and newer", () => {
    for (const v of ["22.13.0", "22.13.1", "22.20.3", "23.0.0", "24.16.0", "26.1.0"]) expect(nodeProblem(v), v).toBeNull();
  });

  it("explains an older Node in plain words, with the version it found and where to get a newer one", () => {
    for (const v of ["18.20.4", "20.11.1", "22.4.0", "22.12.9"]) {
      const text = nodeProblem(v)!;
      expect(text, v).toContain(`Node.js ${MIN_NODE.major}.${MIN_NODE.minor}`);
      expect(text, v).toContain(v);
      expect(text, v).toContain("nodejs.org");
      expect(text, v).not.toMatch(/ERR_|stack/);
    }
  });

  it("does not block on a version string it cannot read", () => {
    expect(nodeProblem("")).toBeNull();
    expect(nodeProblem("not-a-version")).toBeNull();
  });
});

describe("quietSqliteWarning", () => {
  const fakeProcess = () => {
    const listeners = new Map<string, ((w: Error) => void)[]>();
    const written: string[] = [];
    return {
      written,
      listeners,
      removeAllListeners(name: string) {
        listeners.delete(name);
      },
      on(name: string, fn: (w: Error) => void) {
        listeners.set(name, [...(listeners.get(name) ?? []), fn]);
      },
      stderr: { write: (text: string) => void written.push(text) },
      emit(name: string, w: Error) {
        for (const fn of listeners.get(name) ?? []) fn(w);
      },
    };
  };
  const warning = (name: string, message: string) => Object.assign(new Error(message), { name });

  it("hides node's 'SQLite is an experimental feature' warning, which every command prints on Node 22", () => {
    const proc = fakeProcess();
    quietSqliteWarning(proc);
    proc.emit("warning", warning("ExperimentalWarning", "SQLite is an experimental feature and might change at any time"));
    expect(proc.written).toEqual([]);
  });

  it("still shows every other warning, including other experimental features", () => {
    const proc = fakeProcess();
    quietSqliteWarning(proc);
    proc.emit("warning", warning("DeprecationWarning", "something old"));
    proc.emit("warning", warning("ExperimentalWarning", "Type Stripping is an experimental feature"));
    expect(proc.written.join("")).toContain("DeprecationWarning: something old");
    expect(proc.written.join("")).toContain("Type Stripping");
  });

  it("replaces node's own printer instead of adding a second one", () => {
    const proc = fakeProcess();
    proc.on("warning", () => proc.stderr.write("node default printer\n"));
    quietSqliteWarning(proc);
    proc.emit("warning", warning("DeprecationWarning", "x"));
    expect(proc.written.join("")).not.toContain("node default printer");
    expect(proc.written).toHaveLength(1);
  });
});
