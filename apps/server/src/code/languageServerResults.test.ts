import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { decodeCodeRelativePath } from "@octant/contracts";
import { MAX_CODE_LANGUAGE_DIAGNOSTICS } from "@octant/contracts/code-language";
import {
  OUTSIDE_CHECKOUT_TEXT,
  rewriteHostPaths,
  toDefinitionTargets,
  toDiagnostics,
} from "./languageServerResults";

const checkoutRoot = "/work/octant/checkout";
const range = { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("language server results", () => {
  it("rewrites host paths in a message: inside the checkout relative, anything else hidden", () => {
    expect(
      rewriteHostPaths(
        "Cannot read file '/Users/someone/shared/tsconfig.base.json'.",
        checkoutRoot,
      ),
    ).toBe(`Cannot read file '${OUTSIDE_CHECKOUT_TEXT}'.`);
    expect(
      rewriteHostPaths(
        `File '${checkoutRoot}/src/a.ts' is not listed within the file list of project '${checkoutRoot}/tsconfig.json'.`,
        checkoutRoot,
      ),
    ).toBe("File 'src/a.ts' is not listed within the file list of project 'tsconfig.json'.");
    expect(
      rewriteHostPaths(
        `See file://${checkoutRoot}/src/b%20c.ts and file:///etc/passwd, or ~/notes/x.ts at ${checkoutRoot}.`,
        checkoutRoot,
      ),
    ).toBe(`See src/b c.ts and ${OUTSIDE_CHECKOUT_TEXT}, or ${OUTSIDE_CHECKOUT_TEXT} at ..`);
    expect(
      rewriteHostPaths(`A sibling ${checkoutRoot}-other/a.ts is not inside.`, checkoutRoot),
    ).toBe(`A sibling ${OUTSIDE_CHECKOUT_TEXT} is not inside.`);
  });

  it("rewrites a quoted path with spaces whole, and paths after a colon or in any file: form", () => {
    const spaced = "/Users/someone/My Projects/repo";
    expect(
      rewriteHostPaths(
        `File '${spaced}/src/a.ts' extends '/Users/someone/Client Work/base.json'.`,
        spaced,
      ),
    ).toBe(`File 'src/a.ts' extends '${OUTSIDE_CHECKOUT_TEXT}'.`);
    expect(
      rewriteHostPaths(
        "error:/home/someone/a.ts FILE:///home/someone/b.ts file:/home/someone/c.ts",
        checkoutRoot,
      ),
    ).toBe(`error:${OUTSIDE_CHECKOUT_TEXT} ${OUTSIDE_CHECKOUT_TEXT} ${OUTSIDE_CHECKOUT_TEXT}`);
  });

  it("leaves relative paths, fractions, and ordinary words alone", () => {
    const text =
      "Cannot find module './a.js', '@/b', or 'pkg/sub'; '/' expected; see https://aka.ms/x; and/or 1/2 of Array<string>.";
    expect(rewriteHostPaths(text, checkoutRoot)).toBe(text);
  });

  it("bounds diagnostics, keeps usable source labels, and rewrites their messages", () => {
    const path = decodeCodeRelativePath("src/b.ts");
    const items = Array.from({ length: MAX_CODE_LANGUAGE_DIAGNOSTICS + 3 }, (_, index) => ({
      range,
      severity: (index % 4) + 1,
      message: index === 0 ? `Missing ${checkoutRoot}/src/x.ts and /opt/y.ts` : "x".repeat(5_000),
      source: index === 1 ? "../bin/evil" : "ts",
    }));
    const mapped = toDiagnostics({
      items: [{ message: "no range" }, ...items],
      path,
      checkoutRoot,
      defaultSource: "typescript",
    });
    expect(mapped.truncated).toBe(true);
    expect(mapped.diagnostics).toHaveLength(MAX_CODE_LANGUAGE_DIAGNOSTICS);
    expect(mapped.diagnostics[0]).toEqual({
      path,
      range,
      severity: "error",
      message: `Missing src/x.ts and ${OUTSIDE_CHECKOUT_TEXT}`,
      source: "ts",
    });
    expect(mapped.diagnostics[1]?.source).toBe("typescript");
    expect(mapped.diagnostics[1]?.severity).toBe("warning");
    expect(mapped.diagnostics[1]?.message.length).toBeLessThanOrEqual(2_048);
  });

  it("places definitions by their resolved path, so a link out of the checkout is elsewhere", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-language-results-")));
    roots.push(root);
    const checkout = join(root, "checkout");
    const install = join(root, "install");
    const outside = join(root, "outside");
    for (const directory of [checkout, install, outside]) mkdirSync(directory);
    writeFileSync(join(checkout, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(install, "lib.es5.d.ts"), "");
    writeFileSync(join(outside, "secret.ts"), "");
    symlinkSync(join(outside, "secret.ts"), join(checkout, "linked.ts"));

    const targets = await toDefinitionTargets({
      result: [
        { uri: pathToFileURL(join(checkout, "a.ts")).href, range },
        { targetUri: pathToFileURL(join(checkout, "a.ts")).href, targetSelectionRange: range },
        { uri: pathToFileURL(join(install, "lib.es5.d.ts")).href, range },
        { uri: pathToFileURL(join(checkout, "linked.ts")).href, range },
        { uri: "file:///etc/passwd", range },
        { uri: "untitled:Untitled-1", range },
        {
          uri: pathToFileURL(join(checkout, "a.ts")).href,
          range: { start: range.end, end: range.start },
        },
      ],
      roots: { checkoutRoot: checkout, installRoot: install },
      realpath: (path) => realpath(path),
    });
    expect(targets).toEqual([
      { kind: "checkout-location", path: "a.ts", range },
      { kind: "checkout-location", path: "a.ts", range },
      { kind: "outside-checkout", label: "bundled-library" },
      { kind: "outside-checkout", label: "elsewhere" },
      { kind: "outside-checkout", label: "elsewhere" },
      { kind: "outside-checkout", label: "elsewhere" },
    ]);
  });
});
