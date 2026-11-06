import { describe, expect, it } from "vitest";
import {
  MAX_BROWSER_ACCESSIBILITY_DEPTH,
  MAX_BROWSER_ACCESSIBILITY_NODES,
  MAX_BROWSER_ACCESSIBILITY_TEXT,
  MAX_BROWSER_CHOSEN_FILES,
  browserAccessibilityTreeIsSound,
  MAX_BROWSER_DIALOG_TEXT,
  MAX_BROWSER_SELECT_MENU_ENTRIES,
  MAX_BROWSER_SELECT_OPTIONS,
  browserSelectMenuEntries,
  decodeHumanBrowserRequest,
  decodeHumanBrowserResult,
} from "./browserPresentation";

const owner = {
  contextId: "60000000-0000-4000-8000-000000000001",
  threadId: "10000000-0000-4000-8000-000000000001",
  presentationId: "70000000-0000-4000-8000-000000000001",
};
const popupId = "80000000-0000-4000-8000-000000000001";
const select = (count: number, selectedIndex = 0) => ({
  status: "popup",
  popup: {
    kind: "select",
    id: popupId,
    anchor: { x: 10, y: 20, width: 120, height: 24 },
    options: Array.from({ length: count }, (_, index) => ({
      label: `Option ${String(index)}`,
      disabled: false,
    })),
    selectedIndex,
  },
});

describe("page popups on the human Browser presentation", () => {
  it("accepts a bounded select list and refuses one past the option bound", () => {
    expect(decodeHumanBrowserResult(select(3, 2))).toMatchObject({ status: "popup" });
    expect(() => decodeHumanBrowserResult(select(MAX_BROWSER_SELECT_OPTIONS + 1))).toThrow();
    expect(() => decodeHumanBrowserResult(select(3, 3))).toThrow();
  });

  it("refuses a dialog message past its bound and a page prompt", () => {
    const dialog = (message: string, type = "confirm") => ({
      status: "popup",
      popup: { kind: "dialog", id: popupId, dialog: type, message },
    });
    expect(decodeHumanBrowserResult(dialog("Leave?"))).toMatchObject({ status: "popup" });
    expect(() =>
      decodeHumanBrowserResult(dialog("x".repeat(MAX_BROWSER_DIALOG_TEXT + 1))),
    ).toThrow();
    expect(() => decodeHumanBrowserResult(dialog("Name?", "prompt"))).toThrow();
  });

  it("refuses a link menu that names neither a link nor an image, and any page URL", () => {
    const context = (popup: Record<string, unknown>) => ({
      status: "popup",
      popup: { kind: "context", id: popupId, ...popup },
    });
    expect(decodeHumanBrowserResult(context({ link: true, image: false }))).toBeDefined();
    expect(() => decodeHumanBrowserResult(context({ link: false, image: false }))).toThrow();
    expect(() =>
      decodeHumanBrowserResult(context({ link: true, image: false, url: "https://a.test/" })),
    ).toThrow();
  });

  it("carries only bounded absolute chosen paths in a file answer", () => {
    const answer = (paths: ReadonlyArray<string>) => ({
      ...owner,
      kind: "popup-answer",
      popupId,
      answer: { kind: "file", paths },
    });
    expect(decodeHumanBrowserRequest(answer(["/Users/a/report.pdf"]))).toMatchObject({
      kind: "popup-answer",
    });
    expect(() => decodeHumanBrowserRequest(answer([]))).toThrow();
    expect(() => decodeHumanBrowserRequest(answer(["relative.txt"]))).toThrow();
    expect(() => decodeHumanBrowserRequest(answer(["/a\0b"]))).toThrow();
    expect(() =>
      decodeHumanBrowserRequest(
        answer(Array.from({ length: MAX_BROWSER_CHOSEN_FILES + 1 }, (_, i) => `/f${String(i)}`)),
      ),
    ).toThrow();
  });

  it("refuses an answer without a popup identity or with an extra field", () => {
    expect(() =>
      decodeHumanBrowserRequest({
        ...owner,
        kind: "popup-answer",
        answer: { kind: "dialog", accept: true },
      }),
    ).toThrow();
    expect(() =>
      decodeHumanBrowserRequest({
        ...owner,
        kind: "popup-answer",
        popupId,
        answer: { kind: "dialog", accept: true, text: "typed" },
      }),
    ).toThrow();
    expect(decodeHumanBrowserRequest({ ...owner, kind: "popup-dismiss", popupId })).toMatchObject({
      kind: "popup-dismiss",
    });
  });

  it("counts a select's group headings and separators against the native menu bound", () => {
    expect(
      browserSelectMenuEntries([{}, { group: "Big" }, { group: "Big" }, { group: "" }, {}]),
    ).toBe(9);
    const alternating = Array.from({ length: 400 }, (_, index) => ({
      label: "x",
      disabled: false,
      group: index % 2 === 0 ? "A" : "B",
    }));
    expect(browserSelectMenuEntries(alternating)).toBeGreaterThan(MAX_BROWSER_SELECT_MENU_ENTRIES);
    expect(() =>
      decodeHumanBrowserResult({
        status: "popup",
        popup: {
          kind: "select",
          id: popupId,
          anchor: { x: 0, y: 0, width: 1, height: 1 },
          options: alternating,
          selectedIndex: 0,
        },
      }),
    ).toThrow();
  });

  it("carries a burst notice and a watch with nothing the page wrote", () => {
    expect(
      decodeHumanBrowserResult({
        status: "popup",
        popup: { kind: "notice", id: popupId, notice: "dialogs-answered" },
      }),
    ).toMatchObject({ status: "popup" });
    expect(() =>
      decodeHumanBrowserResult({
        status: "popup",
        popup: { kind: "notice", id: popupId, notice: "dialogs-answered", message: "x" },
      }),
    ).toThrow();
    expect(decodeHumanBrowserRequest({ ...owner, kind: "popup-watch", popupId })).toMatchObject({
      kind: "popup-watch",
    });
  });
});

describe("the accessibility mirror on the human Browser presentation", () => {
  const tree = (nodes: ReadonlyArray<Record<string, unknown>>, extra = {}) => ({
    status: "accessibility",
    update: { kind: "full", revision: 1, rootId: "0-1", truncated: false, nodes, ...extra },
  });
  const root = { id: "0-1", role: "document", children: ["0-2"] };

  it("carries a sound tree of described nodes", () => {
    expect(
      decodeHumanBrowserResult(
        tree([root, { id: "0-2", role: "button", name: "Save", focusable: true, children: [] }], {
          focusedId: "0-2",
        }),
      ),
    ).toMatchObject({ status: "accessibility" });
  });

  it("refuses a password field that carries a value", () => {
    expect(() =>
      decodeHumanBrowserResult(
        tree([root, { id: "0-2", role: "textbox", secure: true, value: "x", children: [] }]),
      ),
    ).toThrow();
  });

  it("refuses names past their bound, unknown roles and a page address", () => {
    const long = "a".repeat(MAX_BROWSER_ACCESSIBILITY_TEXT + 1);
    for (const node of [
      { id: "0-2", role: "button", name: long, children: [] },
      { id: "0-2", role: "RootWebArea", children: [] },
      { id: "0-2", role: "link", url: "https://example.test", children: [] },
    ])
      expect(() => decodeHumanBrowserResult(tree([root, node]))).toThrow();
  });

  it("refuses a dangling child, a second parent, a cycle, a missing focus and too many nodes", () => {
    expect(() => decodeHumanBrowserResult(tree([root]))).toThrow();
    expect(() =>
      decodeHumanBrowserResult(
        tree([root, { id: "0-2", role: "group", children: [] }], { focusedId: "0-9" }),
      ),
    ).toThrow();
    expect(
      browserAccessibilityTreeIsSound(
        [
          { id: "0-1", children: ["0-2", "0-3"] },
          { id: "0-2", children: ["0-3"] },
          { id: "0-3", children: [] },
        ],
        "0-1",
      ),
    ).toBe(false);
    expect(
      browserAccessibilityTreeIsSound(
        [
          { id: "0-1", children: [] },
          { id: "0-2", children: ["0-3"] },
          { id: "0-3", children: ["0-2"] },
        ],
        "0-1",
      ),
    ).toBe(false);
    const many = Array.from({ length: MAX_BROWSER_ACCESSIBILITY_NODES + 1 }, (_, index) => ({
      id: `0-${String(index + 1)}`,
      role: "text",
      children: index === 0 ? [] : [],
    }));
    expect(() => decodeHumanBrowserResult(tree(many))).toThrow();
  });

  it("refuses a tree deeper than the mirror's bound", () => {
    const chain = (length: number) =>
      Array.from({ length }, (_, index) => ({
        id: `0-${String(index + 1)}`,
        children: index + 1 < length ? [`0-${String(index + 2)}`] : [],
      }));
    expect(browserAccessibilityTreeIsSound(chain(MAX_BROWSER_ACCESSIBILITY_DEPTH), "0-1")).toBe(
      true,
    );
    expect(browserAccessibilityTreeIsSound(chain(MAX_BROWSER_ACCESSIBILITY_DEPTH + 1), "0-1")).toBe(
      false,
    );
  });

  it("asks for the mirror and acts on one node, with a value only for set-value", () => {
    expect(
      decodeHumanBrowserRequest({ ...owner, kind: "accessibility", revision: 0 }),
    ).toMatchObject({ kind: "accessibility" });
    const act = (action: Record<string, unknown>) => ({
      ...owner,
      kind: "accessibility-action",
      revision: 3,
      nodeId: "0-2",
      action,
    });
    expect(decodeHumanBrowserRequest(act({ action: "press" }))).toMatchObject({
      kind: "accessibility-action",
    });
    expect(decodeHumanBrowserRequest(act({ action: "set-value", value: "Ada" }))).toMatchObject({
      kind: "accessibility-action",
    });
    expect(() => decodeHumanBrowserRequest(act({ action: "press", value: "Ada" }))).toThrow();
    expect(() => decodeHumanBrowserRequest(act({ action: "evaluate" }))).toThrow();
    expect(() =>
      decodeHumanBrowserRequest({ ...act({ action: "press" }), nodeId: "button#save" }),
    ).toThrow();
  });
});
