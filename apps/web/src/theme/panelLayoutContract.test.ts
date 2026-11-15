import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const panels = readFileSync(resolve(import.meta.dirname, "../styles/panels.css"), "utf8");
const app = readFileSync(resolve(import.meta.dirname, "../App.tsx"), "utf8");

function rule(selector: string): string {
  const from = panels.indexOf(`\n${selector} {`);
  expect(from, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
  return panels.slice(from, panels.indexOf("}", from));
}

describe("dock panel layout", () => {
  it("loads after the dock's own rules so it wins their ties", () => {
    expect(app.indexOf('"./styles/panels.css"')).toBeGreaterThan(
      app.indexOf('"./styles/dock.css"'),
    );
  });

  it("keeps a diff header's title, count and controls wrapping instead of overlapping", () => {
    expect(rule(".code-diff-pane__toolbar")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".code-diff-pane__toolbar > div")).toMatch(/min-width:\s*0/);
  });

  it("puts a delivery head's status sentence on its own full-width line", () => {
    expect(rule(".code-delivery-pane .code-delivery-pane__toolbar")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".code-delivery-pane .code-delivery-pane__toolbar > p")).toMatch(
      /flex:\s*1 1 100%/,
    );
  });

  it("lets the hunk selector scroll inside itself rather than draw over the diff", () => {
    const selector = rule(".code-diff-pane > .code-diff-pane__hunk-selection");
    expect(selector).toMatch(/overflow:\s*auto/);
    expect(selector).toMatch(/min-height:\s*0/);
  });

  it("never tints or centres a panel's own notice", () => {
    expect(panels).not.toMatch(/-soft|text-align:\s*center|justify-items:\s*center/);
  });
});
