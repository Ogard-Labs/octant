import { afterEach, describe, expect, it } from "vitest";
import { canvasAreaOfDrag, canvasCommentPickAt } from "./canvasTools";

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function at(root: HTMLElement, selector: string): Element {
  const element = root.querySelector(selector);
  if (element === null) throw new Error(`Nothing matches ${selector}`);
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("canvasCommentPickAt", () => {
  const board = `
    <section class="canvas-block" data-block-id="group-1">
      <section class="canvas-block" data-block-id="board-1">
        <svg><g data-node-id="api"><text>API</text></g><g data-node-id="cell"><text>Cell</text></g></svg>
        <p>Caption</p>
      </section>
    </section>`;

  it("picks the node a person pointed inside when the Canvas takes comments on it", () => {
    const root = mount(board);
    const found = canvasCommentPickAt(at(root, '[data-node-id="api"] text'), () => true);
    expect(found?.pick).toEqual({ blockId: "board-1", part: { kind: "node", id: "api" } });
    expect(found?.element).toBe(at(root, '[data-node-id="api"]'));
  });

  it("falls back to the block for a part the Canvas has no comment anchor for", () => {
    const root = mount(board);
    const anchors = new Set(["block:board-1", "node:board-1:api"]);
    const found = canvasCommentPickAt(at(root, '[data-node-id="cell"] text'), (id) =>
      anchors.has(id),
    );
    expect(found?.pick).toEqual({ blockId: "board-1" });
    expect(found?.element).toBe(at(root, '[data-block-id="board-1"]'));
  });

  it("picks a callout pinned to a container from a part inside it", () => {
    const root = mount(`
      <section class="canvas-block" data-block-id="mockup-1">
        <ul><li data-node-id="sidebar"><ul><li data-node-id="row"><span>Inbox</span></li></ul></li></ul>
      </section>`);
    const anchors = new Set(["block:mockup-1", "node:mockup-1:sidebar"]);
    const found = canvasCommentPickAt(at(root, "span"), (id) => anchors.has(id));
    expect(found?.pick).toEqual({ blockId: "mockup-1", part: { kind: "node", id: "sidebar" } });
  });

  it("picks the block around one the Canvas takes no comments on", () => {
    const root = mount(board);
    const found = canvasCommentPickAt(at(root, "p"), (id) => id === "block:group-1");
    expect(found?.pick).toEqual({ blockId: "group-1" });
  });

  it("picks nothing outside every block", () => {
    const root = mount("<header><h1>Title</h1></header>");
    expect(canvasCommentPickAt(at(root, "h1"), () => true)).toBeUndefined();
  });
});

describe("canvasAreaOfDrag", () => {
  const block = { left: 100, top: 200, width: 400, height: 200 };

  it("reads a drag as percent of the block, whichever corner it started from", () => {
    const area = { x: 25, y: 25, width: 25, height: 50 };
    expect(canvasAreaOfDrag(block, { x: 200, y: 250 }, { x: 300, y: 350 })).toEqual(area);
    expect(canvasAreaOfDrag(block, { x: 300, y: 350 }, { x: 200, y: 250 })).toEqual(area);
  });

  it("keeps an area that ran past the block inside it", () => {
    expect(canvasAreaOfDrag(block, { x: 300, y: 300 }, { x: 900, y: 900 })).toEqual({
      x: 50,
      y: 50,
      width: 50,
      height: 50,
    });
  });

  it("reads a drag too small to mean an area as none", () => {
    expect(canvasAreaOfDrag(block, { x: 200, y: 250 }, { x: 204, y: 350 })).toBeUndefined();
  });
});
