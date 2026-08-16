import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CanvasActionBlock, CanvasActionResult } from "@octant/contracts/canvas-actions";
import {
  evaluateCanvasActionAvailability,
  safeCanvasActionDenialReason,
  type CanvasActionAvailability,
} from "@octant/domain/canvas-action-availability-policy";
import { describe, expect, it, vi } from "vitest";
import { CanvasActionPanel } from "./CanvasActionPanel";
import {
  openSourceActionFixture,
  openThreadActionFixture,
  proposeThreadActionFixture,
  requestRefreshActionFixture,
} from "./test-fixtures";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const availableChat = (block: CanvasActionBlock): CanvasActionAvailability =>
  evaluateCanvasActionAvailability(block, { mode: "chat", canExecuteActions: true });

const acceptedReceipt = (outcome: "completed" | "requested" | "cancelled"): CanvasActionResult =>
  ({
    kind: "accepted",
    receipt: {
      schemaVersion: 1,
      kind: "canvas-action-receipt",
      requestId: "11111111-1111-4111-8111-111111111111",
      canvasId: "22222222-2222-4222-8222-222222222222",
      blockId: "action-open-source",
      capability: { command: "canvas.open-source", effect: "read", requiresApproval: false },
      outcome,
      completedAt: "2026-08-04T12:00:00.000Z",
    },
  }) as unknown as CanvasActionResult;

describe("CanvasActionPanel surfaces available actions", () => {
  it("renders an available read action as an operable button with a read-only label", () => {
    render(
      <CanvasActionPanel
        actions={[openSourceActionFixture]}
        availability={availableChat}
        onExecute={() => Promise.resolve(acceptedReceipt("completed"))}
      />,
    );
    const button = screen.getByRole("button", { name: "Open notes source" });
    expect(button).toBeVisible();
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(screen.getByText("Read-only")).toBeVisible();
  });

  it("labels a mutating action as changing the workspace, in words not color", () => {
    render(
      <CanvasActionPanel
        actions={[requestRefreshActionFixture]}
        availability={availableChat}
        onExecute={() => Promise.resolve(acceptedReceipt("requested"))}
      />,
    );
    expect(screen.getByText("Changes your workspace")).toBeVisible();
  });

  it("marks an approval-gated action as needing approval without disabling it", () => {
    render(
      <CanvasActionPanel
        actions={[proposeThreadActionFixture]}
        availability={availableChat}
        onExecute={() => Promise.resolve(acceptedReceipt("requested"))}
      />,
    );
    const button = screen.getByRole("button", { name: "Propose a new thread" });
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(screen.getByText("Needs approval")).toBeVisible();
  });
});

describe("CanvasActionPanel disables unavailable and unauthorized actions safely", () => {
  it("shows a safe reason for an unavailable action and never dispatches it", async () => {
    const onExecute = vi.fn(() => Promise.resolve(acceptedReceipt("completed")));
    render(
      <CanvasActionPanel
        actions={[openSourceActionFixture]}
        availability={(block) =>
          evaluateCanvasActionAvailability(block, {
            mode: "chat",
            canExecuteActions: true,
            available: false,
          })
        }
        onExecute={onExecute}
      />,
    );
    const button = screen.getByRole("button", { name: "Open notes source" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    // The reason is discoverable to assistive tech via aria-describedby.
    const describedBy = button.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    const reason = document.getElementById(describedBy!.split(" ").at(-1)!);
    expect(reason).toHaveTextContent(safeCanvasActionDenialReason("unavailable"));

    await userEvent.click(button);
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("shows an unauthorized reason distinct from unavailable", () => {
    render(
      <CanvasActionPanel
        actions={[openSourceActionFixture]}
        availability={(block) =>
          evaluateCanvasActionAvailability(block, {
            mode: "chat",
            canExecuteActions: true,
            authorized: false,
          })
        }
        onExecute={() => Promise.resolve(acceptedReceipt("completed"))}
      />,
    );
    const item = screen.getByRole("group", { name: "Open notes source" });
    expect(item).toHaveAttribute("data-availability", "unauthorized");
    expect(within(item).getByText(safeCanvasActionDenialReason("unauthorized"))).toBeVisible();
  });
});

describe("CanvasActionPanel keyboard operation", () => {
  it("executes an available action from the keyboard with Enter", async () => {
    const onExecute = vi.fn(() => Promise.resolve(acceptedReceipt("completed")));
    render(
      <CanvasActionPanel
        actions={[openSourceActionFixture]}
        availability={availableChat}
        onExecute={onExecute}
      />,
    );
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Open notes source" })).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Done.")).toBeVisible();
  });

  it("does not execute a disabled action from the keyboard", async () => {
    const onExecute = vi.fn(() => Promise.resolve(acceptedReceipt("completed")));
    render(
      <CanvasActionPanel
        actions={[openSourceActionFixture]}
        availability={(block) =>
          evaluateCanvasActionAvailability(block, {
            mode: "chat",
            canExecuteActions: false,
          })
        }
        onExecute={onExecute}
      />,
    );
    const button = screen.getByRole("button", { name: "Open notes source" });
    button.focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");
    expect(onExecute).not.toHaveBeenCalled();
  });
});

describe("CanvasActionPanel run lifecycle", () => {
  it("announces a running state and then the completion through a live region", async () => {
    const gate = deferred<CanvasActionResult>();
    render(
      <CanvasActionPanel
        actions={[openThreadActionFixture]}
        availability={availableChat}
        onExecute={() => gate.promise}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open related thread" }));
    expect(await screen.findByText("Running…")).toBeVisible();
    gate.resolve(acceptedReceipt("completed"));
    expect(await screen.findByText("Done.")).toBeVisible();
  });

  it("reports what the server did with the cancellation, not what was asked", async () => {
    // Cancel lost the race: the authoritative receipt says the action
    // completed, so the panel must not claim it was cancelled.
    const lost = deferred<CanvasActionResult>();
    const { unmount } = render(
      <CanvasActionPanel
        actions={[openThreadActionFixture]}
        availability={availableChat}
        onExecute={() => lost.promise}
        onCancel={() => Promise.resolve(acceptedReceipt("completed"))}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open related thread" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Done.")).toBeVisible();
    expect(screen.queryByText("Cancelled.")).toBeNull();
    unmount();

    // A denied cancellation renders the mapped denial, never "Cancelled."
    const denied = deferred<CanvasActionResult>();
    const deniedRender = render(
      <CanvasActionPanel
        actions={[openThreadActionFixture]}
        availability={availableChat}
        onExecute={() => denied.promise}
        onCancel={() =>
          Promise.resolve({
            kind: "denied",
            denialCode: "unauthorized",
            message: "nope",
          } as CanvasActionResult)
        }
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open related thread" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByText("You do not have access to run this action here."),
    ).toBeVisible();
    expect(screen.queryByText("Cancelled.")).toBeNull();
    deniedRender.unmount();

    // A cancel that never answers is an unknown outcome, not a success.
    const thrown = deferred<CanvasActionResult>();
    render(
      <CanvasActionPanel
        actions={[openThreadActionFixture]}
        availability={availableChat}
        onExecute={() => thrown.promise}
        onCancel={() => Promise.reject(new Error("offline"))}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open related thread" }));
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("The cancellation could not be confirmed.")).toBeVisible();
    expect(screen.queryByText("Cancelled.")).toBeNull();
  });

  it("offers Cancel while running and reports a cancelled outcome", async () => {
    const gate = deferred<CanvasActionResult>();
    // The shape the host returns for an accepted cancellation.
    const onCancel = vi.fn(() => Promise.resolve(acceptedReceipt("cancelled")));
    render(
      <CanvasActionPanel
        actions={[openThreadActionFixture]}
        availability={availableChat}
        onExecute={() => gate.promise}
        onCancel={onCancel}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open related thread" }));
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await userEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Cancelled.")).toBeVisible();
    // A late resolution of the superseded execute must not clobber the outcome.
    gate.resolve(acceptedReceipt("completed"));
    await waitFor(() => expect(screen.queryByText("Done.")).not.toBeInTheDocument());
  });
});

describe("CanvasActionPanel denial copy never leaks metadata", () => {
  it("renders mapped safe copy for a denial, never the raw server message", async () => {
    const hostileMessage = "Denied for host /Users/secret provider prov-123 thread opaque:thread-9";
    render(
      <CanvasActionPanel
        actions={[openSourceActionFixture]}
        availability={availableChat}
        onExecute={() =>
          Promise.resolve({
            kind: "denied",
            denialCode: "unauthorized",
            message: hostileMessage,
          } as CanvasActionResult)
        }
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open notes source" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(safeCanvasActionDenialReason("unauthorized"));
    expect(screen.queryByText(/Users\/secret/)).not.toBeInTheDocument();
    expect(screen.queryByText(/prov-123/)).not.toBeInTheDocument();
    expect(screen.queryByText(/opaque:thread-9/)).not.toBeInTheDocument();
  });

  it("renders a generic failure when the transport throws", async () => {
    render(
      <CanvasActionPanel
        actions={[openSourceActionFixture]}
        availability={availableChat}
        onExecute={() => Promise.reject(new Error("ECONNREFUSED 127.0.0.1:8137"))}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open notes source" }));
    expect(await screen.findByText("The action could not be completed.")).toBeVisible();
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
  });
});
