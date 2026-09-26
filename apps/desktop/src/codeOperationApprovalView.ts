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

/**
 * The palette a window's resolved theme is showing, as that window's renderer
 * reports it. The approval document stays desktop-owned: this is read as data
 * — eight hex colors and the mode — and anything else falls back to the
 * system palette the view has always drawn.
 */
export interface CodeOperationApprovalPalette {
  readonly mode: "light" | "dark";
  readonly surface: string;
  readonly text: string;
  readonly muted: string;
  readonly border: string;
  readonly control: string;
  readonly controlHover: string;
  readonly accent: string;
  readonly accentForeground: string;
}

const APPROVAL_PALETTE_COLOR_KEYS = [
  "accent",
  "accentForeground",
  "border",
  "control",
  "controlHover",
  "muted",
  "surface",
  "text",
] as const;
const APPROVAL_PALETTE_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function paletteColor(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && APPROVAL_PALETTE_COLOR_PATTERN.test(value)
    ? value
    : undefined;
}

export function decodeCodeOperationApprovalPalette(
  value: unknown,
): CodeOperationApprovalPalette | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\0") !==
    ["mode", ...APPROVAL_PALETTE_COLOR_KEYS].sort().join("\0")
  ) {
    return undefined;
  }
  const mode = record.mode === "light" ? "light" : record.mode === "dark" ? "dark" : undefined;
  if (mode === undefined) return undefined;
  const accent = paletteColor(record, "accent");
  const accentForeground = paletteColor(record, "accentForeground");
  const border = paletteColor(record, "border");
  const control = paletteColor(record, "control");
  const controlHover = paletteColor(record, "controlHover");
  const muted = paletteColor(record, "muted");
  const surface = paletteColor(record, "surface");
  const text = paletteColor(record, "text");
  if (
    accent === undefined ||
    accentForeground === undefined ||
    border === undefined ||
    control === undefined ||
    controlHover === undefined ||
    muted === undefined ||
    surface === undefined ||
    text === undefined
  ) {
    return undefined;
  }
  return {
    mode,
    accent,
    accentForeground,
    border,
    control,
    controlHover,
    muted,
    surface,
    text,
  };
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
    pendingCount: number,
  ) => CodeOperationApprovalBounds | undefined;
  /** Safe owner-window fallback for dock actions whose composer is unmounted. */
  readonly fallbackBounds?: (
    window: TWindow,
    pendingCount: number,
  ) => CodeOperationApprovalBounds | undefined;
  /**
   * The resolved palette the owning window's theme is showing, if it has
   * reported one. Absent, the view draws the system palette it always has.
   */
  readonly approvalPalette?: (windowId: string) => CodeOperationApprovalPalette | undefined;
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
  readonly expiresAt: number;
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
const MAX_PENDING_APPROVALS_PER_WINDOW = 8;

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
    case "android-action":
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
  const queuedByWindow = new Map<string, Array<PendingApproval<TWindow>>>();
  const token = options.token ?? randomToken;
  const expiryMs = options.expiryMs ?? DEFAULT_EXPIRY_MS;
  const anchorWaitMs = options.anchorWaitMs ?? DEFAULT_ANCHOR_WAIT_MS;

  const pendingCount = (windowId: string): number =>
    1 + (queuedByWindow.get(windowId)?.length ?? 0);

  const place = (pending: PendingApproval<TWindow>): void => {
    if (pending.view === undefined || pending.anchor === undefined) return;
    const bounds = options.host.boundsForAnchor(
      pending.window,
      pending.anchor,
      pendingCount(pending.windowId),
    );
    if (bounds === undefined) return;
    pending.view.setBounds(bounds);
  };

  const showQueueCount = (windowId: string) => {
    const active = pendingByWindow.get(windowId);
    if (active === undefined) return;
    active.view?.webContents.send(CODE_OPERATION_APPROVAL_VIEW_CHANNELS.queue, {
      count: pendingCount(windowId),
    });
    // The queue nav needs room the single-request bounds do not have.
    place(active);
  };

  const finish = (pending: PendingApproval<TWindow>, approvalId: CodeApprovalId | undefined) => {
    if (pending.finished) return;
    pending.finished = true;
    if (pending.anchorTimer !== undefined) clearTimeout(pending.anchorTimer);
    if (pending.expiryTimer !== undefined) clearTimeout(pending.expiryTimer);
    const wasActive = pendingByWindow.get(pending.windowId) === pending;
    if (wasActive) pendingByWindow.delete(pending.windowId);
    const queued = queuedByWindow.get(pending.windowId);
    const queuedIndex = queued?.indexOf(pending) ?? -1;
    if (queued !== undefined && queuedIndex >= 0) queued.splice(queuedIndex, 1);
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
    if (!wasActive) showQueueCount(pending.windowId);
    if (wasActive) {
      const next = queued?.shift();
      if (queued?.length === 0) queuedByWindow.delete(pending.windowId);
      if (next !== undefined) {
        next.anchor = anchorByWindow.get(next.windowId);
        pendingByWindow.set(next.windowId, next);
        void begin(next);
      }
    }
  };

  const begin = async (pending: PendingApproval<TWindow>): Promise<void> => {
    if (pending.finished || pending.beginInFlight) return;
    if (Date.now() >= pending.expiresAt) {
      finish(pending, undefined);
      return;
    }
    pending.beginInFlight = true;
    const generation = ++pending.generation;
    if (options.host.isWindowDestroyed(pending.window)) {
      finish(pending, undefined);
      pending.beginInFlight = false;
      return;
    }
    const initialBounds =
      pending.anchor === undefined
        ? options.host.fallbackBounds?.(pending.window, pendingCount(pending.windowId))
        : options.host.boundsForAnchor(
            pending.window,
            pending.anchor,
            pendingCount(pending.windowId),
          );
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
          ? options.host.fallbackBounds?.(pending.window, pendingCount(pending.windowId))
          : options.host.boundsForAnchor(
              pending.window,
              pending.anchor,
              pendingCount(pending.windowId),
            );
      if (bounds === undefined) return;
      const viewToken = token();
      const view = options.host.createView(viewToken);
      pending.token = viewToken;
      pending.challenge = challenge;
      pending.view = view;
      options.host.attach(pending.window, view);
      view.setBounds(bounds);
      view.setVisible(true);
      await view.webContents.loadURL(
        "data:text/html;charset=utf-8," +
          encodeURIComponent(approvalViewHtml(options.host.approvalPalette?.(pending.windowId))),
      );
      if (pending.finished) return;
      view.webContents.send(CODE_OPERATION_APPROVAL_VIEW_CHANNELS.challenge, challenge);
      showQueueCount(pending.windowId);
    } catch {
      finish(pending, undefined);
    } finally {
      pending.beginInFlight = false;
    }
  };

  const cancel = (windowId: string): void => {
    const queued = queuedByWindow.get(windowId) ?? [];
    queuedByWindow.delete(windowId);
    for (const pending of queued) finish(pending, undefined);
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
      const identity = threadAndProject(input.request, input.presentation);
      const active = pendingByWindow.get(input.windowId);
      const queued = queuedByWindow.get(input.windowId) ?? [];
      if (
        active !== undefined &&
        (active.window !== input.window ||
          active.windowCapability !== input.windowCapability ||
          active.threadId !== identity.threadId ||
          active.composerId !== identity.composerId ||
          (identity.projectId !== undefined &&
            active.projectId !== "" &&
            active.projectId !== identity.projectId) ||
          queued.length + 1 >= MAX_PENDING_APPROVALS_PER_WINDOW)
      )
        return Promise.resolve(undefined);
      const anchor = anchorByWindow.get(input.windowId);
      let pending: PendingApproval<TWindow> | undefined;
      const promise = new Promise<CodeApprovalId | undefined>((resolve) => {
        const anchorTimer = setTimeout(
          () => {
            if (pending !== undefined) finish(pending, undefined);
          },
          active === undefined ? anchorWaitMs : expiryMs,
        );
        const next: PendingApproval<TWindow> = {
          window: input.window,
          windowId: input.windowId,
          windowCapability: input.windowCapability,
          request: input.request,
          composerId: identity.composerId,
          projectId: identity.projectId ?? "",
          threadId: identity.threadId,
          expiresAt: Date.now() + expiryMs,
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
        next.expiryTimer = setTimeout(() => finish(next, undefined), expiryMs);
        if (active !== undefined) {
          queued.push(next);
          queuedByWindow.set(input.windowId, queued);
          showQueueCount(input.windowId);
        } else {
          pendingByWindow.set(input.windowId, next);
          if (next.anchor !== undefined || options.host.fallbackBounds !== undefined) {
            void begin(next);
          }
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
          // An already visible trusted view must not outlive its composer owner.
          // Clearing geometry alone still allowed that view to confirm a receipt.
          cancel(input.windowId);
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
      readonly decision: "approve" | "cancel" | "next" | "previous";
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
      if (input.decision === "next" || input.decision === "previous") {
        const queued = queuedByWindow.get(pending.windowId);
        const next = input.decision === "next" ? queued?.shift() : queued?.pop();
        if (next === undefined || queued === undefined) return undefined;
        if (input.decision === "next") queued.push(pending);
        else queued.unshift(pending);
        pendingByWindow.set(pending.windowId, next);
        const view = pending.view;
        const challenge = pending.challenge;
        pending.view = undefined;
        pending.challenge = undefined;
        pending.token = "";
        pending.generation += 1;
        if (options.cancel !== undefined) {
          void options
            .cancel({
              challengeId: String(challenge.challengeId),
              windowId: pending.windowId,
              windowCapability: pending.windowCapability,
            })
            .catch(() => undefined);
        }
        try {
          try {
            view.setVisible(false);
            options.host.detach(pending.window, view);
          } finally {
            if (!view.webContents.isDestroyed()) view.webContents.close();
          }
        } catch {
          // Teardown can race navigation; none of this owner's requests survive it.
          cancel(pending.windowId);
          return undefined;
        }
        next.anchor = anchorByWindow.get(next.windowId);
        void begin(next);
        return undefined;
      }
      if (input.decision === "cancel") {
        pending.decisionStarted = true;
        finish(pending, undefined);
        return undefined;
      }
      pending.decisionStarted = true;
      const generation = pending.generation;
      try {
        const approval = await options.confirm({
          challengeId: pending.challenge.challengeId,
          windowId: pending.windowId,
          windowCapability: pending.windowCapability,
        });
        if (pending.finished || pending.generation !== generation) return undefined;
        finish(pending, approval);
        return approval;
      } catch {
        if (!pending.finished) finish(pending, undefined);
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

function approvalPaletteCss(palette: CodeOperationApprovalPalette | undefined): string {
  // The window draws the system palette until the owning window reports the
  // theme it resolved; a reported palette is absolute, so no media query.
  if (palette === undefined) {
    return (
      ":root{color-scheme:light dark;--approval-bg:#fdfdfc;--approval-fg:#1b1b1b;--approval-muted:#4f4f4f;--approval-border:#e0e0de;--approval-control:#f0f0ef;--approval-hover:#e8e8e6;--approval-primary:#1b1b1b;--approval-primary-fg:#ffffff}\n" +
      "@media(prefers-color-scheme:dark){:root{--approval-bg:#232323;--approval-fg:#f0f0f0;--approval-muted:#a9a9a9;--approval-border:#303030;--approval-control:#2b2b2b;--approval-hover:#333333;--approval-primary:#f0f0f0;--approval-primary-fg:#1b1b1b}}"
    );
  }
  return `:root{color-scheme:${palette.mode};--approval-bg:${palette.surface};--approval-fg:${palette.text};--approval-muted:${palette.muted};--approval-border:${palette.border};--approval-control:${palette.control};--approval-hover:${palette.controlHover};--approval-primary:${palette.accent};--approval-primary-fg:${palette.accentForeground}}`;
}

export function approvalViewHtml(palette?: CodeOperationApprovalPalette): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><title>Code approval</title><style>
${approvalPaletteCss(palette)}
@media(prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}
*{box-sizing:border-box}html,body{height:100%;margin:0;background:transparent}
body{color:var(--approval-fg);font:13px/1.45 'Inter Variable',-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;-webkit-font-smoothing:antialiased}
main{height:100%;display:flex;flex-direction:column;gap:10px;padding:16px;border:1px solid var(--approval-border);border-radius:12px;background:var(--approval-bg)}
.content{display:flex;flex-direction:column;gap:8px;min-height:0;overflow:auto;flex:1}
h1{margin:0;font-size:14px;line-height:1.35;font-weight:500}p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
#detail{color:var(--approval-muted)}
details{color:var(--approval-muted)}summary{cursor:pointer;font-size:12px}
#identity,#digests{padding-top:8px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
#queue:not([hidden]){display:flex;align-items:center;justify-content:space-between;gap:8px;flex-shrink:0}#queue-count{color:var(--approval-muted)}
.actions{display:flex;justify-content:flex-end;gap:8px;flex-shrink:0;margin-top:auto}
button{border:1px solid var(--approval-border);border-radius:8px;padding:6px 12px;min-height:32px;background:var(--approval-control);color:inherit;font:inherit;cursor:pointer}button:hover{background:var(--approval-hover)}:focus-visible{outline:2px solid var(--approval-primary);outline-offset:2px}button:disabled{opacity:.5;cursor:default}#approve{border-color:transparent;background:var(--approval-primary);color:var(--approval-primary-fg)}
</style></head><body><main id="approval" role="alertdialog" aria-labelledby="message" aria-describedby="detail" aria-live="polite"><div class="content"><h1 id="message">Preparing approval…</h1><p id="detail">Waiting for the host to describe this action.</p><details><summary>Show authority details</summary><p id="identity"></p><p id="digests"></p></details></div><nav id="queue" aria-label="Pending approvals" hidden><button id="previous" type="button">Previous</button><span id="queue-count" role="status"></span><button id="next" type="button">Next</button></nav><div class="actions"><button id="cancel" type="button">Cancel</button><button id="approve" type="button" disabled>Allow</button></div></main></body></html>`;
}
