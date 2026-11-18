import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const styles = readFileSync(resolve(process.cwd(), "src/styles/environment.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function rule(selector: string): string {
  const at = styles.indexOf(`${selector} {`);
  if (at < 0) return "";
  return styles.slice(at, styles.indexOf("}", at));
}

describe("the Environment list's edges", () => {
  it("ends every row's value on one edge, whether or not the row opens anything", () => {
    // A row with nothing to open keeps the slot a chevron takes on the others.
    const slot = rule(
      ".environment-row:not(:has(> .environment-row__trailing, > .environment-row__action))::after",
    );
    expect(slot).toMatch(/width:\s*var\(--oct-icon-sm\)/);
    expect(slot).toMatch(/flex:\s*none/);
    expect(rule(".environment-group__chevron,\n.environment-row__trailing")).toMatch(
      /width:\s*var\(--oct-icon-sm\)/,
    );
  });

  it("stands an action that drops under its head on the rows' own height", () => {
    const action = rule(".environment-group__head-action");
    expect(action).toMatch(/min-height:\s*var\(--environment-row-h\)/);
    expect(action).toMatch(/align-items:\s*center/);
  });

  it("draws the outside-content line as a row of the list", () => {
    expect(rule(".thread-environment-dock__body > .outside-content-row")).toMatch(
      /min-height:\s*var\(--environment-row-h\)/,
    );
  });
});
