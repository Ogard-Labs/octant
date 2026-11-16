import type { StoredBrowserProfile, ToolActionAuthority, WindowId } from "@octant/contracts";
import type { BrowserAppManagedToolsOptions } from "./browserAppManagedTools";
import { askWhilePageLives } from "./browserToolOperations";

export type PageScriptPermission =
  | { readonly status: "approved" }
  | { readonly status: "refused"; readonly reason: string };

/**
 * The one-use, exact-source page-script permission below Full access. Code
 * and Work both ask through here, so the two tools cannot drift apart on who
 * may be asked, what the card shows, or what invalidates the answer
 * ([Browser for agents: Bounded page scripts]).
 *
 * The person is asked only when someone is at this computer to see the page
 * (no routine, subagent or paired device), only for an HTTPS page, and only
 * once the page's own site and profile approval already stands. The answer
 * covers this source on this page revision alone: the caller's authority, the
 * page and its revision are read again after the answer, and any change
 * refuses the script.
 */
export async function askOneUsePageScriptPermission(input: {
  readonly approvals: BrowserAppManagedToolsOptions["approvals"];
  readonly windowId: WindowId;
  readonly threadId: string;
  readonly authority: ToolActionAuthority;
  readonly profile: StoredBrowserProfile | undefined;
  /** The page's URL as the agent last read it. */
  readonly expectedUrl: string | undefined;
  readonly source: string;
  readonly expectedObservationRevision: number;
  /** The page's site and profile approval for this thread, model and authority. */
  readonly bindingIsCurrent: () => boolean;
  readonly callerIsCurrent: () => boolean;
  readonly observe: () =>
    | { readonly url?: string | undefined; readonly revision?: number | undefined }
    | undefined;
  readonly pageHold:
    | (() => { readonly release: () => void; readonly signal?: AbortSignal } | undefined)
    | undefined;
  readonly signal: AbortSignal | undefined;
}): Promise<PageScriptPermission> {
  const approvals = input.approvals;
  const origin = input.expectedUrl === undefined ? undefined : pageOrigin(input.expectedUrl);
  if (
    approvals === undefined ||
    origin === undefined ||
    !origin.startsWith("https://") ||
    approvals.isUnattendedScope?.(input.windowId) === true ||
    approvals.isPairedDevice?.(input.windowId) === true
  )
    return { status: "refused", reason: "script-needs-a-local-person" };
  if (!input.bindingIsCurrent()) return { status: "refused", reason: "browser-approval-required" };
  const decision = await askWhilePageLives(input.pageHold, input.signal, (askSignal) =>
    approvals.request({
      windowId: input.windowId,
      threadId: input.threadId,
      authority: input.authority,
      origin,
      ...(input.profile === undefined ? {} : { profile: input.profile }),
      script: { source: input.source },
      ...(askSignal === undefined ? {} : { signal: askSignal }),
    }),
  );
  if (decision !== "approved") return { status: "refused", reason: `browser-approval-${decision}` };
  const reviewed = input.observe();
  if (
    !input.callerIsCurrent() ||
    input.signal?.aborted === true ||
    reviewed?.url !== input.expectedUrl ||
    reviewed?.revision !== input.expectedObservationRevision
  )
    return { status: "refused", reason: "browser-authority-stale" };
  return { status: "approved" };
}

function pageOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
