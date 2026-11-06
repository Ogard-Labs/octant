import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserAccessibilityNode,
  BrowserAccessibilityUpdate,
  HumanBrowserResult,
} from "@octant/contracts/browser-presentation";
import {
  applyBrowserAccessibilityUpdate,
  EmbeddedBrowserAccessibility,
} from "./EmbeddedBrowserAccessibility";

const presentationId = "00000000-0000-4000-8000-000000000703";
const nodes: ReadonlyArray<BrowserAccessibilityNode> = [
  {
    id: "0-1",
    role: "document",
    name: "Fixture",
    children: ["0-2", "0-3", "0-4", "0-5", "0-6", "0-7"],
  },
  { id: "0-2", role: "heading", name: "Welcome", level: 1, children: [] },
  {
    id: "0-3",
    role: "button",
    name: "Save",
    focusable: true,
    bounds: { x: 10, y: 20, width: 80, height: 24 },
    children: [],
  },
  {
    id: "0-4",
    role: "textbox",
    name: "Email",
    value: "ada@example.com",
    focusable: true,
    children: [],
  },
  { id: "0-5", role: "textbox", name: "Password", secure: true, focusable: true, children: [] },
  {
    id: "0-6",
    role: "slider",
    name: "Level",
    valueNow: 4,
    valueMin: 0,
    valueMax: 10,
    children: [],
  },
  { id: "0-7", role: "status", live: "polite", children: ["0-8"] },
  { id: "0-8", role: "text", name: "Ready", children: [] },
];
const full: BrowserAccessibilityUpdate = {
  kind: "full",
  revision: 1,
  rootId: "0-1",
  truncated: false,
  nodes,
};

afterEach(() => vi.restoreAllMocks());

function mirrored(updates: ReadonlyArray<HumanBrowserResult>) {
  const asked: Array<Readonly<Record<string, unknown>>> = [];
  let index = 0;
  let release: () => void = () => {};
  const execute = vi.fn(
    async (request: Readonly<Record<string, unknown>>): Promise<HumanBrowserResult> => {
      asked.push(request);
      if (request.kind === "accessibility-action") return { status: "accepted" };
      const next = updates[index++];
      if (next !== undefined) return next;
      // Stable holds an ask open while the page stays the same.
      await new Promise<void>((done) => {
        release = done;
      });
      return { status: "idle" };
    },
  );
  const view = render(
    <div tabIndex={0} data-testid="group">
      <EmbeddedBrowserAccessibility
        presentationId={presentationId}
        execute={execute}
        scaleX={1}
        scaleY={1}
        secureText={() => undefined}
      />
    </div>,
  );
  return { view, execute, asked, release: () => release() };
}

describe("Nightly's Browser accessibility mirror", () => {
  it("mirrors roles, names, values and states as a screen reader reads them", async () => {
    const { view } = mirrored([{ status: "accessibility", update: full }]);
    expect(await screen.findByRole("heading", { name: "Welcome", level: 1 })).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.style.left).toBe("10px");
    expect(save.style.width).toBe("80px");
    expect((screen.getByRole("textbox", { name: "Email" }) as HTMLInputElement).value).toBe(
      "ada@example.com",
    );
    const password = screen.getByLabelText("Password") as HTMLInputElement;
    expect(password.type).toBe("password");
    expect(password.value).toBe("");
    const level = screen.getByRole("slider", { name: "Level" });
    expect(level.getAttribute("aria-valuenow")).toBe("4");
    expect(screen.getByTestId("browser-accessibility-mirror").style.pointerEvents).toBe("none");
    view.unmount();
  });

  it("sends a press and a step back to Stable as the person's actions on the node", async () => {
    const { view, asked } = mirrored([{ status: "accessibility", update: full }]);
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    // A key an assistive technology made up for a step becomes the step itself.
    fireEvent.keyDown(screen.getByRole("slider", { name: "Level" }), { key: "ArrowUp" });
    await waitFor(() =>
      expect(asked.filter((request) => request.kind === "accessibility-action")).toEqual([
        {
          kind: "accessibility-action",
          presentationId,
          revision: 1,
          nodeId: "0-3",
          action: { action: "press" },
        },
        {
          kind: "accessibility-action",
          presentationId,
          revision: 1,
          nodeId: "0-6",
          action: { action: "increment" },
        },
      ]),
    );
    view.unmount();
  });

  it("moves focus to the page's focused node while the person is in the Browser", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const { view } = mirrored([
      { status: "accessibility", update: full },
      {
        status: "accessibility",
        update: {
          kind: "patch",
          base: 1,
          revision: 2,
          rootId: "0-1",
          focusedId: "0-3",
          truncated: false,
          nodes: [],
          removed: [],
        },
      },
    ]);
    screen.getByTestId("group").focus();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Save" })),
    );
    view.unmount();
  });

  it("announces a changed live region through its own live region, not on the first read", async () => {
    const { view } = mirrored([
      { status: "accessibility", update: full },
      {
        status: "accessibility",
        update: {
          kind: "patch",
          base: 1,
          revision: 2,
          rootId: "0-1",
          truncated: false,
          nodes: [{ id: "0-8", role: "text", name: "Saved", children: [] }],
          removed: [],
        },
      },
    ]);
    const polite = await screen.findByText("Saved", { selector: "[aria-live=polite]" });
    expect(polite.getAttribute("role")).toBe("status");
    // The mirrored status itself stays quiet, so nothing is said twice.
    expect(document.querySelector('[data-mirror-id="0-7"]')?.getAttribute("aria-live")).toBe("off");
    view.unmount();
  });

  it("drops the mirror when Stable refuses it and asks again for the full tree", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { view, asked } = mirrored([
        { status: "accessibility", update: full },
        { status: "refused" },
        { status: "accessibility", update: full },
      ]);
      await waitFor(() => expect(asked.length).toBeGreaterThanOrEqual(2));
      await vi.advanceTimersByTimeAsync(1_100);
      await waitFor(() => expect(asked.length).toBeGreaterThanOrEqual(3));
      expect(asked[2]).toMatchObject({ kind: "accessibility", revision: 0 });
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a patch against another revision and one that breaks the tree", () => {
    const held = applyBrowserAccessibilityUpdate(undefined, full);
    expect(held?.revision).toBe(1);
    expect(
      applyBrowserAccessibilityUpdate(held, {
        kind: "patch",
        base: 2,
        revision: 3,
        rootId: "0-1",
        truncated: false,
        nodes: [],
        removed: [],
      }),
    ).toBeUndefined();
    expect(
      applyBrowserAccessibilityUpdate(held, {
        kind: "patch",
        base: 1,
        revision: 2,
        rootId: "0-1",
        truncated: false,
        nodes: [],
        removed: ["0-2"],
      }),
    ).toBeUndefined();
  });
});
