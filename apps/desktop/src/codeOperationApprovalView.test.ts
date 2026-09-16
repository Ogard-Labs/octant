import { describe, expect, it, vi } from "vitest";
import {
  decodeCodeOperationApprovalChallenge,
  decodeCodeOperationApprovalRequest,
  type CodeApprovalId,
} from "@octant/contracts";
import {
  CODE_OPERATION_APPROVAL_VIEW_CHANNELS,
  approvalViewHtml,
  createCodeOperationApprovalViewController,
  type CodeOperationApprovalAnchor,
  type CodeOperationApprovalBounds,
  type CodeOperationApprovalViewPort,
} from "./codeOperationApprovalView";

const ids = {
  project: "70000000-0000-4000-8000-000000000001",
  thread: "10000000-0000-4000-8000-000000000001",
  checkout: "20000000-0000-4000-8000-000000000001",
  challenge: "50000000-0000-4000-8000-000000000001",
  approval: "40000000-0000-4000-8000-000000000001",
};

const request = decodeCodeOperationApprovalRequest({
  effect: {
    kind: "change-thread-full-access",
    threadId: ids.thread,
    expectedVersion: 1,
    permissionPersistence: "current-session",
  },
});

const challenge = decodeCodeOperationApprovalChallenge({
  challengeId: ids.challenge,
  effectDigest: "a".repeat(64),
  contextDigest: "b".repeat(64),
  projectId: ids.project,
  threadId: ids.thread,
  threadTitle: "Fix login",
  checkoutId: ids.checkout,
  repositoryId: `repo_${"c".repeat(64)}`,
  checkoutHead: { kind: "detached", oid: "d".repeat(40) },
  message: "Allow Full access?",
  detail: "Project: authoritative\nThread: Fix login",
});

function anchor(): Extract<CodeOperationApprovalAnchor, { readonly kind: "thread" }> {
  return {
    kind: "thread",
    projectId: ids.project,
    threadId: ids.thread,
    bounds: { x: 80, y: 600, width: 640, height: 96 },
  };
}

function makeFixture() {
  const sent: Array<[string, unknown]> = [];
  const view: CodeOperationApprovalViewPort = {
    webContents: {
      id: 41,
      loadURL: vi.fn(async () => undefined),
      send: vi.fn((channel: string, value: unknown) => sent.push([channel, value])),
      close: vi.fn(),
      isDestroyed: vi.fn(() => false),
    },
    setBounds: vi.fn(),
    setVisible: vi.fn(),
  };
  const host = {
    createView: vi.fn(() => view),
    attach: vi.fn(),
    detach: vi.fn(),
    boundsForAnchor: vi.fn((_window: object, value: CodeOperationApprovalAnchor) => value.bounds),
    fallbackBounds: vi.fn<() => CodeOperationApprovalBounds | undefined>(() => undefined),
    isWindowDestroyed: vi.fn(() => false),
  };
  const prepare = vi.fn(async () => challenge);
  const confirm = vi.fn(async () => ids.approval as CodeApprovalId);
  const cancel = vi.fn(async () => undefined);
  const controller = createCodeOperationApprovalViewController({
    host,
    prepare,
    confirm,
    cancel,
    token: () => "approval-view-token",
    anchorWaitMs: 25,
    expiryMs: 100,
  });
  return { cancel, controller, confirm, host, prepare, sent, view, window: {} };
}

describe("Code operation approval view controller", () => {
  it("keeps the approval surface static, neutral, bounded, and explicit", () => {
    const html = approvalViewHtml();
    expect(html).toContain("default-src 'none'");
    expect(html).toContain('id="cancel"');
    expect(html).toContain('id="approve"');
    expect(html).toContain("Show authority details");
    expect(html).toContain("prefers-reduced-motion");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });

  it("accepts a decision only from the exact approval WebContentsView", async () => {
    const fixture = makeFixture();
    fixture.controller.updateAnchor({
      window: fixture.window,
      windowId: "window-1",
      anchor: anchor(),
    });
    const result = fixture.controller.request({
      window: fixture.window,
      windowId: "window-1",
      windowCapability: "window-capability",
      request,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fixture.sent[0]).toEqual([CODE_OPERATION_APPROVAL_VIEW_CHANNELS.challenge, challenge]);
    await expect(
      fixture.controller.decision({
        senderId: 999,
        token: "approval-view-token",
        challengeId: ids.challenge,
        decision: "approve",
      }),
    ).resolves.toBeUndefined();
    expect(fixture.confirm).not.toHaveBeenCalled();
    await expect(
      fixture.controller.decision({
        senderId: 41,
        token: "wrong-token",
        challengeId: ids.challenge,
        decision: "approve",
      }),
    ).resolves.toBeUndefined();
    expect(fixture.confirm).not.toHaveBeenCalled();
    await expect(
      fixture.controller.decision({
        senderId: 41,
        token: "approval-view-token",
        challengeId: ids.challenge,
        decision: "approve",
      }),
    ).resolves.toBe(ids.approval);
    await expect(result).resolves.toBe(ids.approval);
    expect(fixture.host.detach).toHaveBeenCalledWith(fixture.window, fixture.view);
    expect(fixture.view.webContents.close).toHaveBeenCalledOnce();
  });

  it("expires a request even while the host is still preparing its challenge", async () => {
    vi.useFakeTimers();
    try {
      const fixture = makeFixture();
      fixture.prepare.mockImplementation(() => new Promise(() => undefined));
      fixture.controller.updateAnchor({
        window: fixture.window,
        windowId: "window-1",
        anchor: anchor(),
      });
      const settled = vi.fn();
      void fixture.controller
        .request({
          window: fixture.window,
          windowId: "window-1",
          windowCapability: "window-capability",
          request,
        })
        .then(settled);
      await vi.advanceTimersByTimeAsync(101);
      expect(settled).toHaveBeenCalledWith(undefined);
      expect(fixture.host.createView).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not extend request expiry when navigating between approvals", async () => {
    vi.useFakeTimers();
    try {
      const fixture = makeFixture();
      fixture.controller.updateAnchor({
        window: fixture.window,
        windowId: "window-1",
        anchor: anchor(),
      });
      const input = {
        window: fixture.window,
        windowId: "window-1",
        windowCapability: "window-capability",
        request,
      };
      const settled = vi.fn();
      const first = fixture.controller.request(input).then(settled);
      const second = fixture.controller.request(input).then(settled);
      await vi.advanceTimersByTimeAsync(60);
      await fixture.controller.decision({
        senderId: 41,
        token: "approval-view-token",
        challengeId: ids.challenge,
        decision: "next",
      });
      await vi.advanceTimersByTimeAsync(41);
      expect(settled).toHaveBeenCalledTimes(2);
      await Promise.all([first, second]);
      expect(fixture.confirm).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps another request from the same composer queued until the first is decided", async () => {
    const fixture = makeFixture();
    fixture.controller.updateAnchor({
      window: fixture.window,
      windowId: "window-1",
      anchor: anchor(),
    });
    const input = {
      window: fixture.window,
      windowId: "window-1",
      windowCapability: "window-capability",
      request,
    };
    const firstSettled = vi.fn();
    const first = fixture.controller.request(input).then(firstSettled);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = fixture.controller.request(input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(firstSettled).not.toHaveBeenCalled();
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
    await fixture.controller.decision({
      senderId: 41,
      token: "approval-view-token",
      challengeId: ids.challenge,
      decision: "cancel",
    });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.prepare).toHaveBeenCalledTimes(2);
    fixture.controller.closeWindow("window-1");
    await expect(second).resolves.toBeUndefined();
  });

  it("navigates pending requests without granting and refuses a decision from the retired view", async () => {
    const fixture = makeFixture();
    fixture.host.createView.mockReturnValueOnce(fixture.view).mockReturnValue({
      ...fixture.view,
      webContents: { ...fixture.view.webContents, id: 42 },
    });
    fixture.controller.updateAnchor({
      window: fixture.window,
      windowId: "window-1",
      anchor: anchor(),
    });
    const input = {
      window: fixture.window,
      windowId: "window-1",
      windowCapability: "window-capability",
      request,
    };
    const first = fixture.controller.request(input);
    const second = fixture.controller.request(input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.controller.decision({
      senderId: 41,
      token: "approval-view-token",
      challengeId: ids.challenge,
      decision: "next",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.prepare).toHaveBeenCalledTimes(2);
    expect(fixture.confirm).not.toHaveBeenCalled();
    await expect(
      fixture.controller.decision({
        senderId: 41,
        token: "approval-view-token",
        challengeId: ids.challenge,
        decision: "approve",
      }),
    ).resolves.toBeUndefined();
    expect(fixture.confirm).not.toHaveBeenCalled();
    fixture.controller.closeWindow("window-1");
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("cancels queued approvals if the owner tears down while navigating", async () => {
    const fixture = makeFixture();
    fixture.controller.updateAnchor({
      window: fixture.window,
      windowId: "window-1",
      anchor: anchor(),
    });
    const input = {
      window: fixture.window,
      windowId: "window-1",
      windowCapability: "window-capability",
      request,
    };
    const first = fixture.controller.request(input);
    const second = fixture.controller.request(input);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.host.detach.mockImplementation(() => {
      throw new Error("Window is destroyed");
    });
    await expect(
      fixture.controller.decision({
        senderId: 41,
        token: "approval-view-token",
        challengeId: ids.challenge,
        decision: "next",
      }),
    ).resolves.toBeUndefined();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
    expect(fixture.cancel).toHaveBeenCalled();
    expect(fixture.confirm).not.toHaveBeenCalled();
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
  });

  it("bounds the approval queue and cancels every retained request when its owner changes", async () => {
    const fixture = makeFixture();
    fixture.controller.updateAnchor({
      window: fixture.window,
      windowId: "window-1",
      anchor: anchor(),
    });
    const input = {
      window: fixture.window,
      windowId: "window-1",
      windowCapability: "window-capability",
      request,
    };
    const retained = Array.from({ length: 8 }, () => fixture.controller.request(input));
    await expect(fixture.controller.request(input)).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
    fixture.controller.updateAnchor({
      window: fixture.window,
      windowId: "window-1",
      anchor: { ...anchor(), threadId: "another-thread" },
    });
    expect(await Promise.all(retained)).toEqual(Array(8).fill(undefined));
    expect(fixture.prepare).toHaveBeenCalledTimes(1);
    expect(fixture.confirm).not.toHaveBeenCalled();
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
  });

  it("returns no approval after the owner changes during confirmation", async () => {
    const fixture = makeFixture();
    let release: ((value: CodeApprovalId) => void) | undefined;
    fixture.confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    fixture.controller.updateAnchor({
      window: fixture.window,
      windowId: "window-1",
      anchor: anchor(),
    });
    const result = fixture.controller.request({
      window: fixture.window,
      windowId: "window-1",
      windowCapability: "window-capability",
      request,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    const decision = fixture.controller.decision({
      senderId: 41,
      token: "approval-view-token",
      challengeId: ids.challenge,
      decision: "approve",
    });
    fixture.controller.updateAnchor({
      window: fixture.window,
      windowId: "window-1",
      anchor: { ...anchor(), threadId: "another-thread" },
    });
    if (release === undefined) throw new Error("Expected confirmation to start.");
    release(ids.approval as CodeApprovalId);
    await expect(decision).resolves.toBeUndefined();
    await expect(result).resolves.toBeUndefined();
    expect(fixture.cancel).toHaveBeenCalled();
  });

  it("cancels a server challenge that arrives after the owner closes during preparation", async () => {
    const fixture = makeFixture();
    let release: ((value: typeof challenge) => void) | undefined;
    fixture.prepare.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    fixture.controller.updateAnchor({
      window: fixture.window,
      windowId: "window-1",
      anchor: anchor(),
    });
    const result = fixture.controller.request({
      window: fixture.window,
      windowId: "window-1",
      windowCapability: "window-capability",
      request,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.controller.closeWindow("window-1");
    release?.(challenge);
    await expect(result).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.cancel).toHaveBeenCalledWith({
      challengeId: ids.challenge,
      windowId: "window-1",
      windowCapability: "window-capability",
    });
    expect(fixture.host.createView).not.toHaveBeenCalled();
  });

  it("cancels a late challenge when the composer changes threads during preparation", async () => {
    const fixture = makeFixture();
    let release: ((value: typeof challenge) => void) | undefined;
    fixture.prepare.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    fixture.controller.updateAnchor({
      window: fixture.window,
      windowId: "window-1",
      anchor: anchor(),
    });
    const result = fixture.controller.request({
      window: fixture.window,
      windowId: "window-1",
      windowCapability: "window-capability",
      request,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.controller.updateAnchor({
      window: fixture.window,
      windowId: "window-1",
      anchor: { ...anchor(), threadId: "10000000-0000-4000-8000-000000000002" },
    });
    release?.(challenge);
    await expect(result).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fixture.cancel).toHaveBeenCalledWith({
      challengeId: ids.challenge,
      windowId: "window-1",
      windowCapability: "window-capability",
    });
    expect(fixture.host.createView).not.toHaveBeenCalled();
  });

  it("cancels by default without calling the confirmation endpoint", async () => {
    const fixture = makeFixture();
    fixture.controller.updateAnchor({
      window: fixture.window,
      windowId: "window-1",
      anchor: anchor(),
    });
    const result = fixture.controller.request({
      window: fixture.window,
      windowId: "window-1",
      windowCapability: "window-capability",
      request,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      fixture.controller.decision({
        senderId: 41,
        token: "approval-view-token",
        challengeId: ids.challenge,
        decision: "cancel",
      }),
    ).resolves.toBeUndefined();
    await expect(result).resolves.toBeUndefined();
    expect(fixture.confirm).not.toHaveBeenCalled();
    expect(fixture.cancel).toHaveBeenCalledWith({
      challengeId: ids.challenge,
      windowId: "window-1",
      windowCapability: "window-capability",
    });
  });

  it("expires a request that has no matching live composer anchor", async () => {
    const fixture = makeFixture();
    const result = fixture.controller.request({
      window: fixture.window,
      windowId: "window-1",
      windowCapability: "window-capability",
      request,
    });
    await expect(result).resolves.toBeUndefined();
    expect(fixture.prepare).not.toHaveBeenCalled();
    expect(fixture.host.createView).not.toHaveBeenCalled();
  });

  it("uses an owner-window fallback for dock operations when the composer is unmounted", async () => {
    const fixture = makeFixture();
    fixture.host.fallbackBounds.mockReturnValue({ x: 300, y: 500, width: 500, height: 200 });
    const result = fixture.controller.request({
      window: fixture.window,
      windowId: "window-1",
      windowCapability: "window-capability",
      request,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(
      fixture.controller.decision({
        senderId: 41,
        token: "approval-view-token",
        challengeId: ids.challenge,
        decision: "approve",
      }),
    ).resolves.toBe(ids.approval);
    await expect(result).resolves.toBe(ids.approval);
    expect(fixture.host.createView).toHaveBeenCalledOnce();
  });

  it("revokes a visible approval when the composer moves to another thread", async () => {
    const fixture = makeFixture();
    fixture.controller.updateAnchor({
      window: fixture.window,
      windowId: "window-1",
      anchor: anchor(),
    });
    const result = fixture.controller.request({
      window: fixture.window,
      windowId: "window-1",
      windowCapability: "window-capability",
      request,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.controller.updateAnchor({
      window: fixture.window,
      windowId: "window-1",
      anchor: { ...anchor(), threadId: "10000000-0000-4000-8000-000000000002" },
    });
    await expect(
      fixture.controller.decision({
        senderId: 41,
        token: "approval-view-token",
        challengeId: ids.challenge,
        decision: "approve",
      }),
    ).resolves.toBeUndefined();
    expect(fixture.confirm).not.toHaveBeenCalled();
    await expect(result).resolves.toBeUndefined();
    expect(fixture.view.webContents.close).toHaveBeenCalledOnce();
  });

  it("cancels a pending challenge when its owning window closes", async () => {
    const fixture = makeFixture();
    fixture.controller.updateAnchor({
      window: fixture.window,
      windowId: "window-1",
      anchor: anchor(),
    });
    const result = fixture.controller.request({
      window: fixture.window,
      windowId: "window-1",
      windowCapability: "window-capability",
      request,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.controller.closeWindow("window-1");
    await expect(result).resolves.toBeUndefined();
    expect(fixture.confirm).not.toHaveBeenCalled();
    expect(fixture.view.webContents.close).toHaveBeenCalledOnce();
  });
});
