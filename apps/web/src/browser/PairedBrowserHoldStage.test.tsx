import type { PairedBrowserControlClient } from "@octant/client-runtime";
import {
  decodePairedBrowserLeaseId,
  decodePairedBrowserTarget,
  type PairedBrowserStreamEvent,
} from "@octant/contracts/paired-browser-control";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PairedBrowserHoldStage } from "./PairedBrowserHoldStage";

const lease = {
  leaseId: decodePairedBrowserLeaseId("11111111-1111-4111-8111-111111111111"),
  expiresAt: "2026-11-20T12:00:00.000Z",
  target: decodePairedBrowserTarget({
    threadId: "22222222-2222-4222-8222-222222222222",
    contextId: "33333333-3333-4333-8333-333333333333",
    tabId: "tab-1",
    documentVersion: "a".repeat(64),
    profileKind: "personal",
    originPolicyVersion: "policy-v1",
  }),
};

describe("PairedBrowserHoldStage", () => {
  it("streams frames, dispatches touch tap and keyboard text without mouse events, and shows Finish this on the computer for right-click", async () => {
    let emit: ((event: PairedBrowserStreamEvent) => void) | undefined;
    const sendInput = vi.fn(async () => ({
      status: "input" as const,
      lastAcceptedSequence: 1,
      effect: "completed" as const,
    }));
    const client: PairedBrowserControlClient = {
      send: vi.fn(),
      sendInput,
      release: vi.fn(async () => ({ status: "released" as const })),
      handBack: vi.fn(async () => ({ status: "released" as const })),
      uploadFile: vi.fn(async () => ({ status: "released" as const })),
      stream: vi.fn(async ({ onEvent }) => {
        emit = onEvent;
        return new Promise<{ readonly status: "ended" }>(() => undefined);
      }),
    };
    const onEnded = vi.fn();
    render(
      <PairedBrowserHoldStage
        client={client}
        lease={lease}
        onEnded={onEnded}
        onHandBack={vi.fn()}
      />,
    );

    emit?.({
      kind: "frame",
      frameId: 5,
      documentVersion: lease.target.documentVersion,
      viewport: { width: 800, height: 600 },
      devicePixelRatio: 2,
      jpegBase64: "AAAA",
    });

    const img = await screen.findByAltText("Live person-only Browser frame");
    vi.spyOn(img, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 400,
      height: 300,
      right: 400,
      bottom: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(img, { button: 0, clientX: 200, clientY: 150 });
    fireEvent.pointerUp(img, { button: 0, clientX: 200, clientY: 150 });
    expect(sendInput).toHaveBeenCalledWith(lease.leaseId, 1, [
      { kind: "tap", frameId: 5, x: 0.5, y: 0.5 },
    ]);

    const stage = screen.getByLabelText("Paired remote Browser control");
    fireEvent.keyDown(stage, { key: "a", code: "KeyA" });
    expect(sendInput).toHaveBeenCalledWith(lease.leaseId, 2, [{ kind: "text", text: "a" }]);

    fireEvent.contextMenu(stage);
    expect(await screen.findByText(/Finish this on the computer/i)).toBeInTheDocument();

    emit?.({ kind: "withheld", reason: "private-custody" });
    expect(await screen.findByText(/login fill/i)).toBeInTheDocument();
    expect(screen.queryByAltText("Live person-only Browser frame")).toBeNull();

    emit?.({ kind: "reclaimed-locally" });
    expect(onEnded).toHaveBeenCalledWith("Reclaimed on the computer.");
  });

  it("lets Ctrl+V and Cmd+V reach native paste handling so device clipboard text is sent instead of a remote key", () => {
    const sendInput = vi.fn(async () => ({
      status: "input" as const,
      lastAcceptedSequence: 1,
      effect: "completed" as const,
    }));
    const client: PairedBrowserControlClient = {
      send: vi.fn(),
      sendInput,
      release: vi.fn(async () => ({ status: "released" as const })),
      handBack: vi.fn(async () => ({ status: "released" as const })),
      uploadFile: vi.fn(async () => ({ status: "released" as const })),
      stream: vi.fn(async () => new Promise<{ readonly status: "ended" }>(() => undefined)),
    };
    render(
      <PairedBrowserHoldStage
        client={client}
        lease={lease}
        onEnded={vi.fn()}
        onHandBack={vi.fn()}
      />,
    );

    const stage = screen.getByLabelText("Paired remote Browser control");

    const cmdVNotCancelled = fireEvent.keyDown(stage, { key: "v", code: "KeyV", metaKey: true });
    expect(cmdVNotCancelled).toBe(true);
    fireEvent.keyUp(stage, { key: "v", code: "KeyV", metaKey: true });

    const ctrlVNotCancelled = fireEvent.keyDown(stage, { key: "v", code: "KeyV", ctrlKey: true });
    expect(ctrlVNotCancelled).toBe(true);
    fireEvent.keyUp(stage, { key: "v", code: "KeyV", ctrlKey: true });

    expect(sendInput).not.toHaveBeenCalled();

    fireEvent.paste(stage, {
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "pasted-from-device" : ""),
      },
    });
    expect(sendInput).toHaveBeenCalledWith(lease.leaseId, 1, [
      { kind: "text", text: "pasted-from-device" },
    ]);

    const enterNotCancelled = fireEvent.keyDown(stage, { key: "Enter", code: "Enter" });
    expect(enterNotCancelled).toBe(false);
    expect(sendInput).toHaveBeenCalledWith(lease.leaseId, 2, [
      {
        kind: "key",
        phase: "down",
        key: "Enter",
        code: "Enter",
        modifiers: { alt: false, control: false, meta: false, shift: false },
      },
    ]);
  });
});
