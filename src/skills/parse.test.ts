import { describe, expect, it } from "vitest";
import { parseSkill } from "./parse.js";

const GD = `---
name: gd-m09-email-lifecycle-planner
description: Build useful email sequences around a subscriber or customer action. Use when designing a lifecycle sequence.
---

# M09 · Email Lifecycle Planner

Build useful email sequences.
`;

describe("parseSkill", () => {
  it("reads name, description and body from a gd-style skill", () => {
    const s = parseSkill(GD, "folder-name");
    expect(s.name).toBe("gd-m09-email-lifecycle-planner");
    expect(s.description).toMatch(/^Build useful email sequences/);
    expect(s.body).toContain("# M09 · Email Lifecycle Planner");
    expect(s.problems).toEqual([]);
  });

  it("keeps unknown frontmatter keys and works with Windows line endings and a BOM", () => {
    const text = `﻿---\r\nname: a-skill\r\ndescription: Does a thing.\r\nallowed-tools: Read, Grep\r\npillars: [3, 4]\r\nweird: yes\r\n---\r\nBody\r\n`;
    const s = parseSkill(text, "x");
    expect(s.name).toBe("a-skill");
    expect(s.frontmatter["allowed-tools"]).toBe("Read, Grep");
    expect(s.frontmatter.pillars).toEqual([3, 4]);
    expect(s.frontmatter.weird).toBe("yes");
    expect(s.body.trim()).toBe("Body");
  });

  it("falls back to the folder name and says so when the name is missing or odd", () => {
    const s = parseSkill("---\ndescription: ok\n---\nbody", "my-folder");
    expect(s.name).toBe("my-folder");
    expect(s.problems.join()).toMatch(/name/);
    expect(parseSkill("---\nname: bad name!\ndescription: ok\n---\nb", "f").name).toBe("f");
  });

  it("flags a missing description, a missing frontmatter block and broken YAML", () => {
    expect(parseSkill("---\nname: x\n---\nbody", "x").problems.join()).toMatch(/description/);
    const bare = parseSkill("# Title\n\nFirst real line of the skill.\n", "bare");
    expect(bare.description).toBe("First real line of the skill.");
    expect(bare.problems.join()).toMatch(/frontmatter/);
    const broken = parseSkill("---\nname: [oops\n---\nbody", "b");
    expect(broken.problems.join()).toMatch(/YAML/);
    expect(broken.name).toBe("b");
  });

  it("cuts a very long description", () => {
    const s = parseSkill(`---\nname: n\ndescription: ${"x".repeat(2000)}\n---\nb`, "n");
    expect(s.description.length).toBeLessThanOrEqual(400);
  });
});
