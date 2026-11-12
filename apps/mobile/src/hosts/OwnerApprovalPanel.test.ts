// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnerActionResult, OwnerSpoke } from "@octant/client-runtime";
import { ThemeProvider } from "../../design-system/theme";
import { OwnerApprovalPanel } from "./OwnerApprovalPanel";
vi.mock("react-native", () => vi.importActual("react-native-web"));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
const target = {
  ownerMemberId: "50000000-0000-4000-8000-000000000005",
  hostMemberId: "50000000-0000-4000-8000-000000000001",
  mode: "code",
  threadId: "50000000-0000-4000-8000-000000000002",
  projectId: "50000000-0000-4000-8000-000000000003",
  requestId: "50000000-0000-4000-8000-000000000004",
  targetVersion: "a".repeat(64),
  actionDigest: "b".repeat(64),
  title: "Current task",
  projectName: "My Project",
  action: {
    kind: "file-write",
    tool: "Write",
    input: JSON.stringify({
      file_path: "/fixture/a.txt",
      content: "all content through final line",
    }),
  },
};
function fixture(shell = false) {
  const refused = async () => ({ status: "refused", kind: "unsupported" }) as const;
  const readApprovals = vi.fn<() => Promise<OwnerActionResult>>(async () => ({
    status: "done",
    body: {
      targets: [
        {
          ...target,
          action: shell
            ? {
                kind: "shell",
                tool: "Bash",
                input: JSON.stringify({ command: "printf full-command-through-final-line" }),
                workingDirectory: "/fixture",
              }
            : target.action,
        },
      ],
      unavailable: 1,
    },
  }));
  const answerApproval = vi.fn<() => Promise<OwnerActionResult>>(async () => ({
    status: "done",
    body: { status: "uncertain" },
  }));
  const spoke: OwnerSpoke = {
    memberId: target.hostMemberId,
    name: "Home Mac",
    client: {
      alerts: refused,
      heldMembers: refused,
      dismissAlert: refused,
      removeFromAlert: refused,
      setConfirmNewMembers: refused,
      confirmNewMember: refused,
      readApprovals,
      answerApproval,
    },
  };
  return { spoke, readApprovals, answerApproval };
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
          children: createElement(OwnerApprovalPanel, { spokes: next }),
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

describe("phone owner file approval recovery", () => {
  it.each([false, true])(
    "shows complete file or Shell facts and clears uncertain answers without retry: %s",
    async (shell) => {
      const f = fixture(shell);
      mount([f.spoke]);
      await press("Unlock and read approvals");
      await press(shell ? "Code: Current task — Bash" : "Code: Current task — Write");
      expect(document.body.textContent).toContain(
        shell ? "full-command-through-final-line" : "all content through final line",
      );
      if (shell) expect(document.body.textContent).toContain("Working folder: /fixture");
      expect(document.body.textContent).toContain("Runs on Home Mac");
      await press("Deny");
      expect(f.answerApproval).toHaveBeenCalledWith(
        expect.objectContaining({ approved: false, actionDigest: target.actionDigest }),
      );
      expect(buttons("Deny")).toHaveLength(0);
      expect(document.body.textContent).not.toContain(
        shell ? "full-command-through-final-line" : "all content through final line",
      );
      expect(document.body.textContent).toContain("will not be retried");
      expect(f.answerApproval).toHaveBeenCalledOnce();
    },
  );
  it("discards private facts from a replaced owner client", async () => {
    const old = fixture(),
      next = fixture(),
      pending = deferred<OwnerActionResult>();
    old.readApprovals.mockReturnValue(pending.promise);
    const view = mount([old.spoke]);
    await press("Unlock and read approvals");
    view.render([next.spoke]);
    await act(async () =>
      pending.resolve({ status: "done", body: { targets: [target], unavailable: 0 } }),
    );
    expect(buttons("Code: Current task — Write")).toHaveLength(0);
  });
});
