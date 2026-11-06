import {
  MAX_BROWSER_ACCESSIBILITY_DEPTH,
  MAX_BROWSER_ACCESSIBILITY_NODES,
  MAX_BROWSER_ACCESSIBILITY_TEXT,
  decodeHumanBrowserResult,
} from "@octant/contracts/browser-presentation";
import { describe, expect, it } from "vitest";
import {
  actOnBrowserAccessibilityNode,
  BrowserAccessibilityWatch,
  browserAccessibilityUpdate,
  reduceBrowserAccessibility,
  type AccessibilityFrameTree,
  type AccessibilityTree,
  type ProtocolAccessibilityNode,
} from "./browserAccessibilityMirror";

let next = 1;
function ax(
  role: string,
  options: {
    readonly name?: string;
    readonly value?: unknown;
    readonly properties?: Record<string, unknown>;
    readonly children?: ReadonlyArray<ProtocolAccessibilityNode>;
    readonly ignored?: boolean;
    readonly backend?: number;
  } = {},
): ProtocolAccessibilityNode[] {
  const id = next++;
  const children = options.children ?? [];
  return [
    {
      nodeId: String(id),
      backendDOMNodeId: options.backend ?? id,
      ignored: options.ignored ?? false,
      role: { value: role },
      ...(options.name === undefined ? {} : { name: { value: options.name } }),
      ...(options.value === undefined ? {} : { value: { value: options.value } }),
      properties: Object.entries(options.properties ?? {}).map(([name, value]) => ({
        name,
        value: { value },
      })),
      childIds: children.filter((child) => child.parentId === String(id)).map((c) => c.nodeId),
    },
    ...children,
  ];
}
/** A node and its subtree, with each direct child's parent set. */
function tree(
  role: string,
  options: Parameters<typeof ax>[1] & {
    readonly kids?: ReadonlyArray<ProtocolAccessibilityNode[]>;
  },
): ProtocolAccessibilityNode[] {
  const id = next;
  const children = (options.kids ?? []).flatMap((kid) => {
    const [head, ...rest] = kid;
    return head === undefined ? [] : [{ ...head, parentId: String(id) }, ...rest];
  });
  return ax(role, { ...options, children });
}
function root(nodes: ProtocolAccessibilityNode[]): ProtocolAccessibilityNode[] {
  const [head, ...rest] = nodes;
  if (head === undefined) return [];
  const { parentId: _parent, ...top } = head;
  return [top, ...rest];
}
function frame(
  nodes: ReadonlyArray<ProtocolAccessibilityNode>,
  options: Partial<AccessibilityFrameTree> = {},
): AccessibilityFrameTree {
  return {
    ordinal: 0,
    nodes,
    secure: new Set(),
    bounds: new Map(),
    frames: new Map(),
    ...options,
  };
}
const asResult = (reduced: AccessibilityTree) =>
  decodeHumanBrowserResult({
    status: "accessibility",
    update: browserAccessibilityUpdate(undefined, reduced, 1),
  });

describe("the Browser accessibility mirror's tree", () => {
  it("maps roles, names, headings, states and bounds, and travels as a valid update", () => {
    const nodes = root(
      tree("RootWebArea", {
        name: "Fixture",
        kids: [
          ax("heading", { name: "Welcome", properties: { level: 2 } }),
          ax("button", { name: "Save", properties: { focusable: true, focused: true } }),
          ax("link", { name: "Help" }),
          ax("checkbox", { name: "Remember", properties: { checked: "mixed" } }),
          ax("textbox", {
            name: "Email",
            value: "ada@example.com",
            properties: { required: true },
          }),
          ax("StaticText", { name: "  Plain   words " }),
          ax("InlineTextBox", { name: "line box" }),
          ax("someFutureRole", { name: "Custom" }),
        ],
      }),
    );
    const save = nodes.find((node) => node.name?.value === "Save");
    const reduced = reduceBrowserAccessibility(
      frame(nodes, {
        bounds: new Map([
          [save?.backendDOMNodeId as number, { x: 10, y: 20, width: 80, height: 24 }],
        ]),
      }),
    );
    const by = (name: string) => reduced.nodes.find((node) => node.name === name);
    expect(reduced.nodes[0]).toMatchObject({ role: "document", name: "Fixture" });
    expect(by("Welcome")).toMatchObject({ role: "heading", level: 2 });
    expect(by("Save")).toMatchObject({
      role: "button",
      focusable: true,
      bounds: { x: 10, y: 20, width: 80, height: 24 },
    });
    expect(reduced.focusedId).toBe(by("Save")?.id);
    expect(by("Help")).toMatchObject({ role: "link" });
    expect(by("Remember")).toMatchObject({ role: "checkbox", checked: "mixed" });
    expect(by("Email")).toMatchObject({
      role: "textbox",
      value: "ada@example.com",
      required: true,
    });
    expect(by("Plain words")).toMatchObject({ role: "text" });
    expect(by("line box")).toBeUndefined();
    expect(by("Custom")).toMatchObject({ role: "generic" });
    expect(asResult(reduced)).toMatchObject({ status: "accessibility" });
  });

  it("names a password field without its value, whether the element or the mask says so", () => {
    const nodes = root(
      tree("RootWebArea", {
        kids: [
          ax("textbox", { name: "Password", value: "hunter2", backend: 900 }),
          ax("textbox", { name: "Code", value: "••••" }),
        ],
      }),
    );
    const reduced = reduceBrowserAccessibility(frame(nodes, { secure: new Set([900]) }));
    const fields = reduced.nodes.filter((node) => node.role === "textbox");
    expect(fields).toHaveLength(2);
    for (const field of fields) {
      expect(field.secure).toBe(true);
      expect(field.value).toBeUndefined();
    }
    expect(JSON.stringify(reduced.nodes)).not.toContain("hunter2");
    expect(reduced.addresses.get(fields[0]?.id ?? "")?.secure).toBe(true);
  });

  it("gives ignored and unnamed generic nodes' children to their parent and drops a control's descendants", () => {
    const nodes = root(
      tree("RootWebArea", {
        kids: [
          tree("generic", {
            kids: [tree("none", { ignored: true, kids: [ax("paragraph", { name: "Inside" })] })],
          }),
          tree("button", { name: "Go", kids: [ax("StaticText", { name: "Go" })] }),
        ],
      }),
    );
    const reduced = reduceBrowserAccessibility(frame(nodes));
    expect(reduced.nodes.map((node) => node.role)).toEqual(["document", "paragraph", "button"]);
    expect(reduced.nodes[0]?.children).toHaveLength(2);
    expect(reduced.nodes[2]?.children).toEqual([]);
  });

  it("cuts the tree at the node, depth and text bounds and marks it truncated", () => {
    const many = root(
      tree("RootWebArea", {
        kids: Array.from({ length: MAX_BROWSER_ACCESSIBILITY_NODES + 50 }, (_, index) =>
          ax("paragraph", { name: `Line ${String(index)}` }),
        ),
      }),
    );
    const wide = reduceBrowserAccessibility(frame(many));
    expect(wide.nodes.length).toBeLessThanOrEqual(MAX_BROWSER_ACCESSIBILITY_NODES);
    expect(wide.truncated).toBe(true);
    expect(asResult(wide)).toMatchObject({ status: "accessibility" });

    let deep: ProtocolAccessibilityNode[] = ax("paragraph", { name: "Bottom" });
    for (let level = 0; level < MAX_BROWSER_ACCESSIBILITY_DEPTH + 10; level += 1)
      deep = tree("group", { name: `Level ${String(level)}`, kids: [deep] });
    const nested = reduceBrowserAccessibility(frame(root(tree("RootWebArea", { kids: [deep] }))));
    expect(nested.truncated).toBe(true);
    expect(nested.nodes.some((node) => node.name === "Bottom")).toBe(false);
    expect(asResult(nested)).toMatchObject({ status: "accessibility" });

    const long = reduceBrowserAccessibility(
      frame(root(tree("RootWebArea", { kids: [ax("paragraph", { name: "x".repeat(5_000) })] }))),
    );
    expect(long.nodes[1]?.name).toHaveLength(MAX_BROWSER_ACCESSIBILITY_TEXT);
  });

  it("grafts a frame's document under its frame element with identities of its own", () => {
    const inner = root(
      tree("RootWebArea", { kids: [ax("button", { name: "Inner", backend: 5 })] }),
    );
    const outer = root(
      tree("RootWebArea", {
        kids: [
          ax("Iframe", { name: "Embedded", backend: 77 }),
          ax("button", { name: "Outer", backend: 5 }),
        ],
      }),
    );
    const reduced = reduceBrowserAccessibility(
      frame(outer, { frames: new Map([[77, frame(inner, { ordinal: 1 })]]) }),
    );
    const inside = reduced.nodes.find((node) => node.name === "Inner");
    const outside = reduced.nodes.find((node) => node.name === "Outer");
    expect(inside?.id).toBe("1-5");
    expect(outside?.id).toBe("0-5");
    const group = reduced.nodes.find((node) => node.name === "Embedded");
    expect(group?.role).toBe("group");
    expect(reduced.nodes.find((node) => group?.children.includes(node.id))?.role).toBe("document");
    expect(reduced.addresses.get("1-5")).toMatchObject({ ordinal: 1, backendNodeId: 5 });
  });

  it("sends nothing for an unchanged tree, a patch for a small change and the full tree for a large one", () => {
    const base = root(
      tree("RootWebArea", {
        kids: Array.from({ length: 10 }, (_, index) =>
          ax("paragraph", { name: `P${String(index)}`, backend: 100 + index }),
        ),
      }),
    );
    const first = reduceBrowserAccessibility(frame(base));
    expect(browserAccessibilityUpdate({ revision: 1, tree: first }, first, 2)).toBeUndefined();
    const renamed = base.map((node) =>
      node.backendDOMNodeId === 103 ? { ...node, name: { value: "Changed" } } : node,
    );
    const patch = browserAccessibilityUpdate(
      { revision: 1, tree: first },
      reduceBrowserAccessibility(frame(renamed)),
      2,
    );
    expect(patch).toMatchObject({ kind: "patch", base: 1, revision: 2, removed: [] });
    expect(patch?.nodes).toHaveLength(1);
    const replaced = reduceBrowserAccessibility(
      frame(root(tree("RootWebArea", { kids: [ax("heading", { name: "New" })] }))),
    );
    expect(browserAccessibilityUpdate({ revision: 2, tree: first }, replaced, 3)).toMatchObject({
      kind: "full",
      revision: 3,
    });
  });
});

describe("the Browser accessibility mirror's revisions", () => {
  const reduced = (name: string) =>
    reduceBrowserAccessibility(
      frame(
        root(
          tree("RootWebArea", {
            kids: [
              ax("button", { name, backend: 9 }),
              ...Array.from({ length: 6 }, (_, index) =>
                ax("paragraph", { name: `Still ${String(index)}`, backend: 20 + index }),
              ),
            ],
          }),
        ),
      ),
    );
  const documents = new Map([[0, { ordinal: 0, sessionId: undefined, offset: { x: 0, y: 0 } }]]);

  it("answers a fresh ask with the full tree, then a patch after a change, and idle when the page holds still", async () => {
    let name = "First";
    let reads = 0;
    const watch = new BrowserAccessibilityWatch({
      read: async () => {
        reads += 1;
        return { tree: reduced(name), documents };
      },
      idle: () => undefined,
    });
    try {
      const first = await watch.next(0, undefined, () => true);
      expect(first).toMatchObject({ kind: "full", revision: 1 });
      name = "Second";
      watch.changed();
      const second = await watch.next(1, undefined, () => true);
      expect(second).toMatchObject({ kind: "patch", base: 1, revision: 2 });
      const started = Date.now();
      expect(await watch.next(2, undefined, () => true)).toBe("idle");
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      expect(reads).toBeLessThanOrEqual(4);
      // An unknown revision gets the current tree in full.
      expect(await watch.next(1, undefined, () => true)).toMatchObject({
        kind: "full",
        revision: 2,
      });
    } finally {
      watch.close();
    }
  });

  it("finds a node only for a revision of the current document", async () => {
    const watch = new BrowserAccessibilityWatch({
      read: async () => ({ tree: reduced("Go"), documents }),
      idle: () => undefined,
    });
    try {
      await watch.next(0, undefined, () => true);
      expect(watch.address(1, "0-9")?.address).toMatchObject({ backendNodeId: 9, role: "button" });
      expect(watch.address(2, "0-9")).toBeUndefined();
      expect(watch.address(1, "0-8")).toBeUndefined();
      watch.replaced();
      expect(watch.address(1, "0-9")).toBeUndefined();
    } finally {
      watch.close();
    }
  });

  it("refuses an ask once its presentation is no longer current", async () => {
    const watch = new BrowserAccessibilityWatch({
      read: async () => ({ tree: reduced("Go"), documents }),
      idle: () => undefined,
    });
    try {
      expect(await watch.next(0, undefined, () => false)).toBe("refused");
    } finally {
      watch.close();
    }
  });
});

describe("actions from the Browser accessibility mirror", () => {
  const document = { ordinal: 1, sessionId: "frame-1", offset: { x: 30, y: 40 } };
  const address = (role: string, extra: Record<string, boolean> = {}) => ({
    ordinal: 1,
    backendNodeId: 12,
    role: role as "button",
    secure: false,
    disabled: false,
    editable: false,
    readonly: false,
    ...extra,
  });
  const input = () => {
    const sent: Array<[string, unknown, string | undefined]> = [];
    const pressed: Array<{ x: number; y: number }> = [];
    const keys: string[] = [];
    const typed: string[] = [];
    return {
      sent,
      pressed,
      keys,
      typed,
      port: {
        send: async (method: string, parameters?: Record<string, unknown>, sessionId?: string) => {
          sent.push([method, parameters, sessionId]);
          if (method === "DOM.getBoxModel")
            return { model: { border: [10, 10, 50, 10, 50, 30, 10, 30] } };
          if (method === "DOM.resolveNode") return { object: { objectId: "field" } };
          return {};
        },
        press: (point: { x: number; y: number }) => {
          pressed.push(point);
          return true;
        },
        key: (keyCode: string) => {
          keys.push(keyCode);
          return true;
        },
        insertText: async (text: string) => {
          typed.push(text);
          return true;
        },
      },
    };
  };

  it("presses a node at its centre in the top page, through the person's input", async () => {
    const seen = input();
    expect(
      await actOnBrowserAccessibilityNode(
        seen.port,
        { address: address("button"), document },
        { action: "press" },
        () => true,
      ),
    ).toBe(true);
    expect(seen.pressed).toEqual([{ x: 60, y: 60 }]);
    expect(seen.sent.map(([method, , session]) => [method, session])).toEqual([
      ["DOM.scrollIntoViewIfNeeded", "frame-1"],
      ["DOM.getBoxModel", "frame-1"],
    ]);
  });

  it("never sets a password field's value and leaves a disabled control alone", async () => {
    const seen = input();
    expect(
      await actOnBrowserAccessibilityNode(
        seen.port,
        { address: address("textbox", { secure: true }), document },
        { action: "set-value", value: "hunter2" },
        () => true,
      ),
    ).toBe(false);
    expect(
      await actOnBrowserAccessibilityNode(
        seen.port,
        { address: address("button", { disabled: true }), document },
        { action: "press" },
        () => true,
      ),
    ).toBe(false);
    expect(seen.sent).toEqual([]);
    expect(seen.typed).toEqual([]);
    expect(
      await actOnBrowserAccessibilityNode(
        seen.port,
        { address: address("button", { disabled: true }), document },
        { action: "focus" },
        () => true,
      ),
    ).toBe(true);
  });

  it("replaces a text field's text and steps a slider with arrow keys after focusing it", async () => {
    const seen = input();
    expect(
      await actOnBrowserAccessibilityNode(
        seen.port,
        { address: address("textbox"), document },
        { action: "set-value", value: "Ada" },
        () => true,
      ),
    ).toBe(true);
    expect(seen.typed).toEqual(["Ada"]);
    expect(seen.sent[0]?.[0]).toBe("DOM.focus");
    expect(
      await actOnBrowserAccessibilityNode(
        seen.port,
        { address: address("slider"), document },
        { action: "increment" },
        () => true,
      ),
    ).toBe(true);
    expect(
      await actOnBrowserAccessibilityNode(
        seen.port,
        { address: address("button"), document },
        { action: "increment" },
        () => true,
      ),
    ).toBe(false);
    expect(seen.keys).toEqual(["Up"]);
  });

  it("stops before pressing once the page is no longer the person's", async () => {
    const seen = input();
    let live = true;
    const port = {
      ...seen.port,
      send: async (method: string, parameters?: Record<string, unknown>, sessionId?: string) => {
        // An agent action takes the page while the node scrolls into view.
        live = false;
        return seen.port.send(method, parameters, sessionId);
      },
    };
    expect(
      await actOnBrowserAccessibilityNode(
        port,
        { address: address("button"), document },
        { action: "press" },
        () => live,
      ),
    ).toBe(false);
    expect(seen.pressed).toEqual([]);
  });
});
