import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { build, type Rollup } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The local text input in real Chromium. jsdom lays out nothing, so it cannot
 * show the blur Chromium performs when a focused input is hidden or stops
 * being editable; the Browser group reads that blur as leaving the page.
 * Skipped where no Chromium is installed.
 */

const chrome = [
  process.env.OCTANT_BROWSER_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((candidate) => candidate !== undefined && existsSync(candidate));

const here = dirname(fileURLToPath(import.meta.url));
const component = resolve(here, "EmbeddedBrowserTextInput.tsx");

/** A Browser group holding the input, as the embedded surface does, driven from the test. */
const HARNESS = `
import { createElement, createRef, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { EmbeddedBrowserTextInput } from ${JSON.stringify(component)};
const text = {
  id: "00000000-0000-4000-8000-000000000921",
  selectionStart: 0,
  selectionEnd: 0,
  caret: { x: 10, y: 12, width: 0, height: 20 },
};
const secure = { id: "00000000-0000-4000-8000-000000000922", secure: true };
const group = createRef();
window.leftPage = 0;
window.atCommit = [];
// Runs after the input's own layout effects in the same commit: where focus
// is here is where it is before Chromium can render a frame or run a task.
function Probe(props) {
  useLayoutEffect(() => {
    window.atCommit.push(document.activeElement?.getAttribute("aria-label") ?? "body");
  }, [props.editor]);
  return null;
}
function Harness() {
  const [editor, setEditor] = useState(undefined);
  window.showEditor = (kind) => setEditor(kind === "text" ? text : kind === "secure" ? secure : undefined);
  return createElement(
    "div",
    {
      ref: group,
      tabIndex: 0,
      "aria-label": "Browser group",
      style: { position: "relative", width: 400, height: 300 },
      onBlur: (event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget))
          window.leftPage += 1;
      },
    },
    createElement(EmbeddedBrowserTextInput, {
      editor,
      group,
      scaleX: 1,
      scaleY: 1,
      pointerHeld: () => false,
      compose: async () => ({ status: "refused" }),
    }),
    createElement(Probe, { editor }),
  );
}
const root = document.createElement("div");
document.body.append(root);
createRoot(root).render(createElement(Harness));
`;

let browser: Browser | undefined;
let script = "";

beforeAll(async () => {
  if (chrome === undefined) return;
  const output = await build({
    configFile: false,
    logLevel: "silent",
    root: resolve(here, "../.."),
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
    plugins: [
      {
        name: "octant-text-input-harness",
        resolveId: (id) => (id === "octant-text-input-harness" ? "\0harness.tsx" : undefined),
        load: (id) => (id === "\0harness.tsx" ? HARNESS : undefined),
      },
    ],
    build: {
      write: false,
      minify: false,
      rollupOptions: {
        input: "octant-text-input-harness",
        output: { format: "iife", inlineDynamicImports: true },
      },
    },
  });
  const outputs = (Array.isArray(output) ? output : [output]) as ReadonlyArray<Rollup.RollupOutput>;
  const chunk = outputs.flatMap((result) => result.output).find((item) => item.type === "chunk");
  if (chunk === undefined || chunk.type !== "chunk") throw new Error("No harness bundle.");
  script = chunk.code;
  browser = await chromium.launch({ executablePath: chrome });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

describe.skipIf(chrome === undefined)("EmbeddedBrowserTextInput in Chromium", () => {
  it("hands focus between the text input and the local password field without leaving the page", async () => {
    if (browser === undefined) throw new Error("No Chromium.");
    const page = await browser.newPage();
    try {
      await page.setContent("<!doctype html><body></body>");
      await page.addScriptTag({ content: script });
      await page.getByLabel("Browser group").focus();
      const show = async (kind: "text" | "secure" | "none") => {
        await page.evaluate((next) => {
          (window as unknown as { showEditor: (kind: string) => void }).showEditor(next);
        }, kind);
        // Chromium blurs a hidden focused element on a task after style update.
        await page.evaluate(
          () => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 50))),
        );
      };
      const focused = () =>
        page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "body");
      const leftPage = () =>
        page.evaluate(() => (window as unknown as { leftPage: number }).leftPage);

      await show("text");
      expect(await focused()).toBe("Browser text input");
      await show("secure");
      expect(await focused()).toBe("Browser password field");
      expect(
        await page.evaluate(
          () => (document.activeElement as HTMLInputElement | null)?.type ?? "none",
        ),
      ).toBe("password");
      await show("text");
      expect(await focused()).toBe("Browser text input");
      await show("secure");
      await show("none");
      expect(await focused()).toBe("Browser group");
      expect(await leftPage()).toBe(0);
      // Each handoff completed inside the commit that hid the previous input.
      expect(
        await page.evaluate(() => (window as unknown as { atCommit: string[] }).atCommit),
      ).toEqual([
        // The first mount, before the group takes focus.
        "body",
        "Browser text input",
        "Browser password field",
        "Browser text input",
        "Browser password field",
        "Browser group",
      ]);
    } finally {
      await page.close();
    }
  }, 30_000);
});
