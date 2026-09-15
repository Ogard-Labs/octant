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

export type CodeOperationApprovalAnchor =
  | {
      readonly kind: "thread";
      readonly projectId: string;
      readonly threadId: string;
      readonly bounds: CodeOperationApprovalBounds;
    }
  | {
      readonly kind: "draft";
      readonly projectId: string;
      readonly composerId: string;
      readonly bounds: CodeOperationApprovalBounds;
    };

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
  readonly presentation?: { readonly projectId: string; readonly composerId: string };
  readonly projectId: string;
  readonly threadId: string;
  readonly composerId: string | undefined;
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

function threadAndProject(
  request: CodeOperationApprovalRequest,
  presentation: { readonly projectId: string; readonly composerId: string } | undefined,
): {
  readonly projectId: string | undefined;
  readonly threadId: string;
  readonly composerId: string | undefined;
} {
  if (
    (request.effect.kind === "create-thread-full-access" ||
      request.effect.kind === "create-managed-code-thread-full-access") &&
    presentation !== undefined
  ) {
    return {
      projectId: presentation.projectId,
      threadId: String(
        request.effect.kind === "create-thread-full-access"
          ? request.effect.thread.id
          : request.effect.command.threadId,
      ),
      composerId: presentation.composerId,
    };
  }
  switch (request.effect.kind) {
    case "operation":
      return {
        projectId: undefined,
        threadId: String(request.effect.command.threadId),
        composerId: undefined,
      };
    case "apple-action":
      return {
        projectId: undefined,
        threadId: String(request.effect.request.threadId),
        composerId: undefined,
      };
    case "change-thread-full-access":
      return {
        projectId: undefined,
        threadId: String(request.effect.threadId),
        composerId: undefined,
      };
    case "create-thread-full-access":
      return {
        projectId: String(request.effect.thread.projectId),
        threadId: String(request.effect.thread.id),
        composerId: undefined,
      };
    case "create-managed-code-thread-full-access":
      return {
        projectId: String(request.effect.command.projectId),
        threadId: String(request.effect.command.threadId),
        composerId: undefined,
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
      const stale =
        pending.finished ||
        pendingByWindow.get(pending.windowId) !== pending ||
        pending.generation !== generation ||
        (pending.anchor !== undefined &&
          pending.anchor.projectId !== String(challenge.projectId)) ||
        options.host.isWindowDestroyed(pending.window);
      if (stale) {
        if (options.cancel !== undefined) {
          void options
            .cancel({
              challengeId: String(challenge.challengeId),
              windowId: pending.windowId,
              windowCapability: pending.windowCapability,
            })
            .catch(() => undefined);
        }
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
      readonly presentation?: { readonly projectId: string; readonly composerId: string };
    }): Promise<CodeApprovalId | undefined> => {
      cancel(input.windowId);
      const identity = threadAndProject(input.request, input.presentation);
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
          composerId: identity.composerId,
          projectId: identity.projectId ?? "",
          threadId: identity.threadId,
          token: "",
          resolve,
          anchorTimer,
          expiryTimer: undefined,
          anchor:
            anchor === undefined ||
            (identity.projectId !== undefined && anchor.projectId !== identity.projectId) ||
            (identity.composerId !== undefined
              ? anchor.kind !== "draft" || anchor.composerId !== identity.composerId
              : anchor.kind !== "thread" || anchor.threadId !== identity.threadId)
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
        (pending.projectId !== "" && pending.projectId !== input.anchor.projectId) ||
        (pending.composerId !== undefined
          ? input.anchor.kind !== "draft" || input.anchor.composerId !== pending.composerId
          : input.anchor.kind !== "thread" || input.anchor.threadId !== pending.threadId)
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
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><title>Code approval</title><style>
:root{color-scheme:light dark;--approval-bg:#fdfdfc;--approval-fg:#1b1b1b;--approval-muted:#4f4f4f;--approval-border:#e0e0de;--approval-control:#f0f0ef;--approval-hover:#e8e8e6;--approval-primary:#1b1b1b;--approval-primary-fg:#ffffff}
@media(prefers-color-scheme:dark){:root{--approval-bg:#232323;--approval-fg:#f0f0f0;--approval-muted:#a9a9a9;--approval-border:#303030;--approval-control:#2b2b2b;--approval-hover:#333333;--approval-primary:#f0f0f0;--approval-primary-fg:#1b1b1b}}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
*{box-sizing:border-box}html,body{height:100%;margin:0;background:transparent}
body{color:var(--approval-fg);font:13px/1.45 'Inter Variable',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{height:100%;display:flex;flex-direction:column;gap:12px;padding:20px;border:1px solid var(--approval-border);border-radius:20px;background:var(--approval-bg)}
h1{margin:0;font-size:14px;line-height:1.35;font-weight:500}p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
#detail{color:var(--approval-muted);overflow:auto;min-height:0;flex:1}
details{color:var(--approval-muted);overflow:auto;max-height:45%;flex-shrink:0}summary{cursor:pointer;font-size:12px}
#identity,#digests{padding-top:8px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.actions{display:flex;justify-content:flex-end;gap:8px;flex-shrink:0;margin-top:auto}
button{border:1px solid var(--approval-border);border-radius:8px;padding:6px 12px;min-height:32px;background:var(--approval-control);color:inherit;font:inherit;cursor:pointer}button:hover{background:var(--approval-hover)}:focus-visible{outline:none}button:focus-visible{filter:brightness(.9)}button:disabled{opacity:.5;cursor:default}#approve{border-color:transparent;background:var(--approval-primary);color:var(--approval-primary-fg)}
</style></head><body><main id="approval" aria-live="polite"><h1 id="message">Preparing approval…</h1><p id="detail">Waiting for the host to describe this action.</p><details><summary>Show authority details</summary><p id="identity"></p><p id="digests"></p></details><div class="actions"><button id="cancel" type="button">Cancel</button><button id="approve" type="button" disabled>Approve once</button></div></main></body></html>`;
}
