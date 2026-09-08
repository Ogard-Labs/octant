import { randomBytes } from "node:crypto";
import type {
  CodeOperationApprovalChallenge,
  CodeOperationApprovalRequest,
  CodeApprovalId,
} from "@octant/contracts";
import { CODE_OPERATION_APPROVAL_VIEW_CHANNELS } from "./codeOperationApprovalViewProtocol";
export { CODE_OPERATION_APPROVAL_VIEW_CHANNELS } from "./codeOperationApprovalViewProtocol";

export interface CodeOperationApprovalBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CodeOperationApprovalAnchor {
  readonly projectId: string;
  readonly threadId: string;
  readonly bounds: CodeOperationApprovalBounds;
}

export interface CodeOperationApprovalViewPort {
  readonly webContents: {
    readonly id: number;
    readonly loadURL: (url: string) => Promise<unknown>;
    readonly send: (channel: string, value: unknown) => void;
    readonly close: () => void;
    readonly isDestroyed: () => boolean;
  };
  readonly setBounds: (bounds: CodeOperationApprovalBounds) => void;
  readonly setVisible: (visible: boolean) => void;
}

export interface CodeOperationApprovalViewHost<TWindow> {
  readonly createView: (token: string) => CodeOperationApprovalViewPort;
  readonly attach: (window: TWindow, view: CodeOperationApprovalViewPort) => void;
  readonly detach: (window: TWindow, view: CodeOperationApprovalViewPort) => void;
  readonly boundsForAnchor: (
    window: TWindow,
    anchor: CodeOperationApprovalAnchor,
  ) => CodeOperationApprovalBounds | undefined;
  /** Safe owner-window fallback for dock actions whose composer is unmounted. */
  readonly fallbackBounds?: (window: TWindow) => CodeOperationApprovalBounds | undefined;
  readonly isWindowDestroyed: (window: TWindow) => boolean;
}

export interface CodeOperationApprovalViewOptions<TWindow> {
  readonly host: CodeOperationApprovalViewHost<TWindow>;
  readonly prepare: (input: {
    readonly request: CodeOperationApprovalRequest;
    readonly windowId: string;
    readonly windowCapability: string;
  }) => Promise<CodeOperationApprovalChallenge>;
  readonly confirm: (input: {
    readonly challengeId: string;
    readonly windowId: string;
    readonly windowCapability: string;
  }) => Promise<CodeApprovalId | undefined>;
  readonly cancel?: (input: {
    readonly challengeId: string;
    readonly windowId: string;
    readonly windowCapability: string;
  }) => Promise<void>;
  readonly expiryMs?: number;
  readonly anchorWaitMs?: number;
  readonly token?: () => string;
}

interface PendingApproval<TWindow> {
  readonly window: TWindow;
  readonly windowId: string;
  readonly windowCapability: string;
  readonly request: CodeOperationApprovalRequest;
  readonly projectId: string;
  readonly threadId: string;
  token: string;
  readonly resolve: (approvalId: CodeApprovalId | undefined) => void;
  anchorTimer: ReturnType<typeof setTimeout> | undefined;
  expiryTimer: ReturnType<typeof setTimeout> | undefined;
  anchor: CodeOperationApprovalAnchor | undefined;
  challenge: CodeOperationApprovalChallenge | undefined;
  view: CodeOperationApprovalViewPort | undefined;
  decisionStarted: boolean;
  beginInFlight: boolean;
  generation: number;
  finished: boolean;
}

const DEFAULT_EXPIRY_MS = 5 * 60_000;
const DEFAULT_ANCHOR_WAIT_MS = 1_000;

function threadAndProject(request: CodeOperationApprovalRequest): {
  readonly projectId: string | undefined;
  readonly threadId: string;
} {
  switch (request.effect.kind) {
    case "operation":
      return { projectId: undefined, threadId: String(request.effect.command.threadId) };
    case "apple-action":
      return { projectId: undefined, threadId: String(request.effect.request.threadId) };
    case "change-thread-full-access":
      return { projectId: undefined, threadId: String(request.effect.threadId) };
    case "create-thread-full-access":
      return {
        projectId: String(request.effect.thread.projectId),
        threadId: String(request.effect.thread.id),
      };
  }
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function createCodeOperationApprovalViewController<TWindow>(
  options: CodeOperationApprovalViewOptions<TWindow>,
) {
  const pendingByWindow = new Map<string, PendingApproval<TWindow>>();
  const anchorByWindow = new Map<string, CodeOperationApprovalAnchor>();
  const token = options.token ?? randomToken;
  const expiryMs = options.expiryMs ?? DEFAULT_EXPIRY_MS;
  const anchorWaitMs = options.anchorWaitMs ?? DEFAULT_ANCHOR_WAIT_MS;

  const place = (pending: PendingApproval<TWindow>): void => {
    if (pending.view === undefined || pending.anchor === undefined) return;
    const bounds = options.host.boundsForAnchor(pending.window, pending.anchor);
    if (bounds === undefined) return;
    pending.view.setBounds(bounds);
  };

  const finish = (pending: PendingApproval<TWindow>, approvalId: CodeApprovalId | undefined) => {
    if (pending.finished) return;
    pending.finished = true;
    if (pending.anchorTimer !== undefined) clearTimeout(pending.anchorTimer);
    if (pending.expiryTimer !== undefined) clearTimeout(pending.expiryTimer);
    if (pendingByWindow.get(pending.windowId) === pending) pendingByWindow.delete(pending.windowId);
    if (pending.view !== undefined) {
      try {
        pending.view.setVisible(false);
        options.host.detach(pending.window, pending.view);
      } catch {
        // The owning BrowserWindow may already be tearing down.
      } finally {
        if (!pending.view.webContents.isDestroyed()) pending.view.webContents.close();
      }
    }
    if (
      approvalId === undefined &&
      pending.challenge !== undefined &&
      options.cancel !== undefined
    ) {
      void options
        .cancel({
          challengeId: String(pending.challenge.challengeId),
          windowId: pending.windowId,
          windowCapability: pending.windowCapability,
        })
        .catch(() => undefined);
    }
    pending.resolve(approvalId);
  };

  const begin = async (pending: PendingApproval<TWindow>): Promise<void> => {
    if (pending.finished || pending.beginInFlight) return;
    pending.beginInFlight = true;
    const generation = ++pending.generation;
    if (options.host.isWindowDestroyed(pending.window)) {
      finish(pending, undefined);
      pending.beginInFlight = false;
      return;
    }
    const initialBounds =
      pending.anchor === undefined
        ? options.host.fallbackBounds?.(pending.window)
        : options.host.boundsForAnchor(pending.window, pending.anchor);
    if (initialBounds === undefined) {
      pending.beginInFlight = false;
      return;
    }
    if (pending.anchorTimer !== undefined) {
      clearTimeout(pending.anchorTimer);
      pending.anchorTimer = undefined;
    }
    try {
      const challenge = await options.prepare({
        request: pending.request,
        windowId: pending.windowId,
        windowCapability: pending.windowCapability,
      });
      if (
        pending.finished ||
        pendingByWindow.get(pending.windowId) !== pending ||
        pending.generation !== generation ||
        (pending.anchor !== undefined &&
          pending.anchor.projectId !== String(challenge.projectId)) ||
        options.host.isWindowDestroyed(pending.window)
      ) {
        return;
      }
      const bounds =
        pending.anchor === undefined
          ? options.host.fallbackBounds?.(pending.window)
          : options.host.boundsForAnchor(pending.window, pending.anchor);
      if (bounds === undefined) return;
      const viewToken = token();
      const view = options.host.createView(viewToken);
      pending.token = viewToken;
      pending.challenge = challenge;
      pending.view = view;
      options.host.attach(pending.window, view);
      view.setBounds(bounds);
      view.setVisible(true);
      pending.expiryTimer = setTimeout(() => finish(pending, undefined), expiryMs);
      await view.webContents.loadURL(
        "data:text/html;charset=utf-8," + encodeURIComponent(approvalViewHtml()),
      );
      if (pending.finished) return;
      view.webContents.send(CODE_OPERATION_APPROVAL_VIEW_CHANNELS.challenge, challenge);
    } catch {
      finish(pending, undefined);
    } finally {
      pending.beginInFlight = false;
    }
  };

  const cancel = (windowId: string): void => {
    const pending = pendingByWindow.get(windowId);
    if (pending !== undefined) finish(pending, undefined);
  };

  return Object.freeze({
    request: (input: {
      readonly window: TWindow;
      readonly windowId: string;
      readonly windowCapability: string;
      readonly request: CodeOperationApprovalRequest;
    }): Promise<CodeApprovalId | undefined> => {
      cancel(input.windowId);
      const identity = threadAndProject(input.request);
      const anchor = anchorByWindow.get(input.windowId);
      let pending: PendingApproval<TWindow> | undefined;
      const promise = new Promise<CodeApprovalId | undefined>((resolve) => {
        const anchorTimer = setTimeout(() => {
          if (pending !== undefined) finish(pending, undefined);
        }, anchorWaitMs);
        const next: PendingApproval<TWindow> = {
          window: input.window,
          windowId: input.windowId,
          windowCapability: input.windowCapability,
          request: input.request,
          projectId: identity.projectId ?? "",
          threadId: identity.threadId,
          token: "",
          resolve,
          anchorTimer,
          expiryTimer: undefined,
          anchor:
            anchor === undefined ||
            anchor.threadId !== identity.threadId ||
            (identity.projectId !== undefined && anchor.projectId !== identity.projectId)
              ? undefined
              : anchor,
          challenge: undefined,
          view: undefined,
          decisionStarted: false,
          beginInFlight: false,
          generation: 0,
          finished: false,
        };
        pending = next;
        pendingByWindow.set(input.windowId, next);
        if (next.anchor !== undefined || options.host.fallbackBounds !== undefined) {
          void begin(next);
        }
      });
      return promise;
    },
    updateAnchor: (input: {
      readonly window: TWindow;
      readonly windowId: string;
      readonly anchor: CodeOperationApprovalAnchor;
    }): void => {
      anchorByWindow.set(input.windowId, input.anchor);
      const pending = pendingByWindow.get(input.windowId);
      if (
        pending === undefined ||
        pending.threadId !== input.anchor.threadId ||
        (pending.projectId !== "" && pending.projectId !== input.anchor.projectId)
      ) {
        if (pending !== undefined) {
          pending.anchor = undefined;
          pending.generation += 1;
        }
        return;
      }
      pending.anchor = input.anchor;
      if (pending.view === undefined) void begin(pending);
      else place(pending);
    },
    decision: async (input: {
      readonly senderId: number;
      readonly token: string;
      readonly challengeId: string;
      readonly decision: "approve" | "cancel";
    }): Promise<CodeApprovalId | undefined> => {
      const pending = [...pendingByWindow.values()].find(
        (candidate) => candidate.view?.webContents.id === input.senderId,
      );
      if (
        pending === undefined ||
        pending.view === undefined ||
        pending.token !== input.token ||
        pending.challenge?.challengeId !== input.challengeId ||
        pending.decisionStarted ||
        pending.finished
      ) {
        return undefined;
      }
      if (input.decision === "cancel") {
        pending.decisionStarted = true;
        finish(pending, undefined);
        return undefined;
      }
      pending.decisionStarted = true;
      try {
        const approval = await options.confirm({
          challengeId: pending.challenge.challengeId,
          windowId: pending.windowId,
          windowCapability: pending.windowCapability,
        });
        finish(pending, approval);
        return approval;
      } catch {
        finish(pending, undefined);
        return undefined;
      }
    },
    cancel,
    closeWindow: (windowId: string): void => {
      anchorByWindow.delete(windowId);
      cancel(windowId);
    },
    viewDestroyed: (senderId: number): void => {
      const pending = [...pendingByWindow.values()].find(
        (candidate) => candidate.view?.webContents.id === senderId,
      );
      if (pending !== undefined) finish(pending, undefined);
    },
  });
}

export function approvalViewHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><title>Code approval</title><style>:root{color-scheme:light dark;--approval-bg:#f7f8f9;--approval-fg:#20262d;--approval-muted:#58636e;--approval-border:#c7cdd3;--approval-button:#eef0f2;--approval-button-border:#9da6ae;--approval-primary:#303840;--approval-primary-fg:#fff} @media(prefers-color-scheme:dark){:root{--approval-bg:#24282d;--approval-fg:#f0f2f4;--approval-muted:#b8c0c8;--approval-border:#4f5861;--approval-button:#30363c;--approval-button-border:#707b85;--approval-primary:#d9dde1;--approval-primary-fg:#20262d}} @media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}body{margin:0;background:transparent;color:var(--approval-fg);font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{box-sizing:border-box;padding:18px 20px;border:1px solid var(--approval-border);border-radius:14px;background:var(--approval-bg);box-shadow:0 14px 34px rgb(0 0 0 / 18%)}h1{margin:0 0 8px;font-size:15px}p{margin:6px 0;white-space:pre-wrap}#detail{color:var(--approval-muted);max-height:96px;overflow:auto}details{margin:10px 0;color:var(--approval-muted);max-height:116px;overflow:auto}summary{cursor:pointer}#identity,#digests{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;color:var(--approval-muted)}div{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}button{border:1px solid var(--approval-button-border);border-radius:8px;padding:7px 12px;background:var(--approval-button);color:inherit;font:inherit}button:last-child{border-color:var(--approval-primary);background:var(--approval-primary);color:var(--approval-primary-fg)}</style></head><body><main id="approval" aria-live="polite"><h1 id="message"></h1><p id="detail"></p><details><summary>Show authority details</summary><p id="identity"></p><p id="digests"></p></details><div><button id="cancel" type="button">Cancel</button><button id="approve" type="button">Approve once</button></div></main></body></html>`;
}
