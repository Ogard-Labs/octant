import type {
  BrowserDownloadSource,
  StoredBrowserProfile,
  ToolActionAuthority,
  WindowId,
} from "@octant/contracts";
import type { BrowserToolApprovalService } from "./browserToolApprovalService";

/** The part of the Browser approval service an upload or a download save asks through. */
export type BrowserTransferApprovals = Pick<BrowserToolApprovalService, "request"> &
  Partial<Pick<BrowserToolApprovalService, "isTransferRemembered">>;

type BrowserTransferAnswer = "approved" | "denied" | "cancelled" | "expired";

/**
 * Puts an ordinary upload or download save to the person, below Full access,
 * unless they already answered "Always allow" for it.
 *
 * Work and Code both ask through here and nowhere else, so the remembered
 * answer is read with one key in both modes (direction, site, workspace and
 * Browser profile): a mode that asked on its own
 * would keep asking after the person said always, or read a narrower key
 * than the one their answer was stored under. The answer is stored by the
 * approval service when the person gives it.
 */
export function askBrowserTransfer(
  approvals: BrowserTransferApprovals | undefined,
  input: {
    readonly windowId: WindowId;
    readonly threadId: string;
    readonly authority: ToolActionAuthority;
    readonly origin: string;
    readonly profile: StoredBrowserProfile | undefined;
    /** The thread's workspace; without one nothing can be remembered. */
    readonly workspaceRoot: string | undefined;
    readonly signal: AbortSignal | undefined;
  } & (
    | {
        readonly direction: "upload";
        readonly files: ReadonlyArray<{ readonly name: string; readonly sizeBytes: number }>;
      }
    | {
        readonly direction: "download";
        readonly file: {
          readonly name: string;
          readonly sizeBytes: number;
          readonly mediaType: string;
          readonly source?: BrowserDownloadSource;
        };
      }
  ),
): Promise<BrowserTransferAnswer> {
  if (
    input.workspaceRoot !== undefined &&
    approvals?.isTransferRemembered?.({
      direction: input.direction,
      origin: input.origin,
      workspaceRoot: input.workspaceRoot,
      ...(input.profile === undefined ? {} : { profile: input.profile }),
    }) === true
  ) {
    return Promise.resolve("approved");
  }
  if (approvals === undefined) return Promise.resolve("denied");
  return approvals.request({
    windowId: input.windowId,
    threadId: input.threadId,
    authority: input.authority,
    origin: input.origin,
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    ...(input.direction === "upload" ? { upload: input.files } : { download: input.file }),
    ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}
