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

  it("never tints a panel's notice, and centres only a pane's whole state", () => {
    expect(panels).not.toMatch(/-soft/);
    // The one centred thing is the pane's state (nothing to show, unavailable,
    // failed): a mark, one line, one muted line, in the pane's middle. A notice
    // inside a pane's content stays on the content's own edge.
    const from = panels.indexOf("a tool's state: a mark, one line, one muted line");
    const to = panels.indexOf("header rows with a title and controls wrap");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const state = panels.slice(from, to);
    expect(state).toMatch(/text-align:\s*center/);
    expect(state).toMatch(/margin:\s*auto/);
    const rest = panels.slice(0, from) + panels.slice(to);
    expect(rest).not.toMatch(/text-align:\s*center|justify-items:\s*center/);
  });
});
