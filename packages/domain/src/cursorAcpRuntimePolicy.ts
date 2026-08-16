import { CURSOR_ACP_NO_GO_RESIDUAL_ID } from "./cursorAcpPolicy";
export type CursorAcpRuntimeDenialCode =
  | "production-blocked"
  | "resume-unavailable"
  | "authority-mismatch"
  | "unsupported-root";

export class CursorAcpRuntimePolicyRejected extends Error {
  override readonly name = "CursorAcpRuntimePolicyRejected";
  constructor(
    readonly denialCode: CursorAcpRuntimeDenialCode,
    message: string,
  ) {
    super(message);
  }
}

export type CursorAcpRuntimeMode = "chat" | "work" | "code";
export type CursorAcpExecutionPolicy = "plan" | "approval-gated" | "full-access";

export interface CursorAcpRuntimeStartRequest {
  readonly mode: CursorAcpRuntimeMode;
  /** Plan is an execution policy, not a domain mode. */
  readonly executionPolicy: CursorAcpExecutionPolicy;
  readonly rootPath: string | null;
  /**
   * Server-owned expected root/identity for the thread. Runtime launch binds
   * `rootPath` to this value by normalized absolute equality.
   */
  readonly expectedRootPath: string | null;
  readonly resumeSessionId?: string;
  readonly productionEnabled: boolean;
}

function reject(code: CursorAcpRuntimeDenialCode, message: string): never {
  throw new CursorAcpRuntimePolicyRejected(code, message);
}

function normalizeAbsoluteRootPath(path: string): string | null {
  // Do not trim: trailing/leading whitespace is part of macOS path identity.
  if (path.length === 0 || !path.startsWith("/")) {
    return null;
  }
  // Reject non-canonical roots: no relative segments that change resolution.
  // Collapse repeated separators and drop a non-root trailing slash so host and
  // caller roots compare by exact absolute identity.
  const collapsed = path.replace(/\/+/g, "/");
  const parts = collapsed.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") {
      // empty from leading/trailing separators; "." is a no-op but non-canonical
      if (part === ".") return null;
      continue;
    }
    if (part === "..") {
      return null;
    }
    resolved.push(part);
  }
  if (resolved.length === 0) {
    return "/";
  }
  return `/${resolved.join("/")}`;
}

function assertRootMatchesExpected(input: {
  readonly rootPath: string | null;
  readonly expectedRootPath: string | null;
  readonly mode: CursorAcpRuntimeMode;
}): string {
  if (input.rootPath === null || input.rootPath === "") {
    if (input.mode === "chat") {
      reject("unsupported-root", "Chat Cursor ACP sessions require an isolated scratch root path.");
    }
    reject("authority-mismatch", "Work/Code Cursor ACP sessions require an exact confined root.");
  }
  if (input.expectedRootPath === null || input.expectedRootPath === "") {
    reject(
      "authority-mismatch",
      "Cursor ACP runtime requires a server-owned expected root identity.",
    );
  }

  const root = normalizeAbsoluteRootPath(input.rootPath);
  const expected = normalizeAbsoluteRootPath(input.expectedRootPath);
  if (root === null) {
    if (input.mode === "chat") {
      reject("unsupported-root", "Chat Cursor ACP scratch roots must be absolute paths.");
    }
    reject("authority-mismatch", "Cursor ACP runtime roots must be absolute paths.");
  }
  if (expected === null) {
    reject("authority-mismatch", "Cursor ACP expected roots must be absolute server-owned paths.");
  }
  if (root !== expected) {
    reject(
      "authority-mismatch",
      "Cursor ACP runtime root must match the server-owned expected root identity.",
    );
  }
  return root;
}

/**
 * Runtime lifecycle remains fail-closed under the compatibility-probe NO-GO
 * residual. Mode and
 * execution policy are separated so a future GO can unlock Plan-on-Code without
 * conflating authority roots. Root launch is bound to server-owned expected
 * root identity via normalized absolute equality.
 */
export function assertCursorAcpRuntimeStart(input: CursorAcpRuntimeStartRequest): never {
  if (input.productionEnabled !== false) {
    reject(
      "production-blocked",
      `Cursor ACP runtime is blocked by residual ${CURSOR_ACP_NO_GO_RESIDUAL_ID}.`,
    );
  }
  if (input.resumeSessionId) {
    reject(
      "resume-unavailable",
      "Cursor ACP exact-session resume is unavailable under the current NO-GO residual.",
    );
  }

  assertRootMatchesExpected({
    rootPath: input.rootPath,
    expectedRootPath: input.expectedRootPath,
    mode: input.mode,
  });

  if (input.executionPolicy === "plan" && input.mode === "chat") {
    reject("authority-mismatch", "Plan execution policy applies to Code/Work threads, not Chat.");
  }

  reject(
    "production-blocked",
    `Cursor ACP runtime start is fail-closed (${CURSOR_ACP_NO_GO_RESIDUAL_ID}).`,
  );
}

export function planCursorAcpShutdown(input: {
  readonly ownedProcessGroupId: number;
  readonly force: boolean;
}): { readonly terminateProcessGroupId: number; readonly force: boolean } {
  const pid = input.ownedProcessGroupId;
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    reject(
      "authority-mismatch",
      "Cursor ACP shutdown requires an owned process-group id greater than 1.",
    );
  }
  return {
    terminateProcessGroupId: pid,
    force: input.force,
  };
}
