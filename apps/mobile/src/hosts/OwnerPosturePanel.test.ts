// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerActionResult, OwnerSpoke } from "@octant/client-runtime";
import { ThemeProvider } from "../../design-system/theme";
import { OwnerPosturePanel } from "./OwnerPosturePanel";
vi.mock("react-native", () => vi.importActual("react-native-web"));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
const target = (suffix: string, title = "Current task") => ({
  title,
  posture: {
    subject: { kind: "code-thread", threadId: `50000000-0000-4000-8000-00000000000${suffix}` },
    posture: "approval-gated",
    persistence: "current-session",
    version: suffix.repeat(64),
  },
});
function fixture(memberId = "host", targets = [target("b")]) {
  const refused = async () => ({ status: "refused", kind: "unsupported" }) as const;
  const listPostures = vi.fn<() => Promise<OwnerActionResult>>(async () => ({
    status: "done",
    body: { status: "read", targets },
  }));
  const changePosture = vi.fn<() => Promise<OwnerActionResult>>(async () => ({
    status: "done",
    body: {},
  }));
  const spoke: OwnerSpoke = {
    memberId,
    name: "Home Mac",
    client: {
      alerts: refused,
      heldMembers: refused,
      dismissAlert: refused,
      removeFromAlert: refused,
      setConfirmNewMembers: refused,
      confirmNewMember: refused,
      listPostures,
      changePosture,
    },
  };
  return { spoke, listPostures, changePosture };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Promise not initialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function mount(spokes: ReadonlyArray<OwnerSpoke>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = (next: ReadonlyArray<OwnerSpoke>) =>
    act(() =>
      root.render(
        createElement(ThemeProvider, {
          preference: "light",
          children: createElement(OwnerPosturePanel, { spokes: next }),
        }),
      ),
    );
  render(spokes);
  return { render, container };
}
function buttons(label: string) {
  return [...document.querySelectorAll<HTMLElement>("[role=button]")].filter(
    (element) => element.textContent === label,
  );
}
async function press(label: string, index = 0) {
  const button = buttons(label)[index];
  if (button === undefined) throw new Error(`Missing button ${label}`);
  await act(async () => button.click());
}

describe("phone owner recovery across roster changes", () => {
  it("discards a pending read from a replaced client before using the new client's authoritative target", async () => {
    const old = fixture("host", [target("a", "Old task")]);
    const next = fixture();
    const pending = deferred<OwnerActionResult>();
    old.listPostures.mockReturnValueOnce(pending.promise);
    const view = mount([old.spoke]);
    await press("Refresh Code levels");
    view.render([next.spoke]);
    expect(buttons("Refresh Code levels")[0]?.getAttribute("aria-disabled")).not.toBe("true");
    await press("Refresh Code levels");
    await act(async () =>
      pending.resolve({
        status: "done",
        body: { status: "read", targets: [target("a", "Old task")] },
      }),
    );
    expect(buttons("Thread: Old task")).toHaveLength(0);
    await press("Thread: Current task");
    await press("Full access");
    await press("Apply Code level");
    expect(old.changePosture).not.toHaveBeenCalled();
    expect(next.changePosture).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: "b".repeat(64) }),
    );
  });

  it("drops a selected snapshot when its member disappears and another host takes its place", async () => {
    const old = fixture("old-host", [target("a", "Old task")]);
    const next = fixture("next-host");
    const view = mount([old.spoke]);
    await press("Refresh Code levels");
    await press("Thread: Old task");
    await press("Full access");
    view.render([next.spoke]);
    expect(buttons("Apply Code level")).toHaveLength(0);
    expect(view.container.textContent).not.toContain("Current level:");
    await press("Refresh Code levels");
    await press("Thread: Current task");
    await press("Full access");
    await press("Apply Code level");
    expect(old.changePosture).not.toHaveBeenCalled();
    expect(next.changePosture).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: "b".repeat(64) }),
    );
  });

  it("ignores a late apply completion after the same member receives a replacement client", async () => {
    const old = fixture();
    const next = fixture();
    const pending = deferred<OwnerActionResult>();
    old.changePosture.mockReturnValueOnce(pending.promise);
    const view = mount([old.spoke]);
    await press("Refresh Code levels");
    await press("Thread: Current task");
    await press("Full access");
    await press("Apply Code level");
    view.render([next.spoke]);
    await press("Refresh Code levels");
    await press("Thread: Current task");
    await press("Full access");
    await act(async () => pending.resolve({ status: "done", body: {} }));
    expect(buttons("Apply Code level")).toHaveLength(1);
    expect(view.container.textContent).not.toContain("Level changed.");
    await press("Apply Code level");
    expect(next.changePosture).toHaveBeenCalledTimes(1);
  });

  it("keeps duplicate display names and task titles attached to their member and subject identities", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const first = fixture("first");
    const second = fixture("second", [target("a", "Same task"), target("b", "Same task")]);
    const view = mount([first.spoke, second.spoke]);
    await press("Home Mac", 1);
    await press("Refresh Code levels");
    view.render([second.spoke, first.spoke]);
    await press("Thread: Same task", 1);
    await press("Full access");
    await press("Apply Code level");
    expect(first.listPostures).not.toHaveBeenCalled();
    expect(first.changePosture).not.toHaveBeenCalled();
    expect(second.changePosture).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: target("b").posture.subject,
        expectedVersion: "b".repeat(64),
      }),
    );
    expect(
      errors.mock.calls
        .flat()
        .map(String)
        .some((message) => /same key|unique.*key/i.test(message)),
    ).toBe(false);
  });
});
