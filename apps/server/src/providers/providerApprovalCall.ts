import {
  decodeOwnerApprovalAction,
  MAX_PROVIDER_APPROVAL_CALL_INPUT_LENGTH,
  type ProviderApprovalCall,
} from "@octant/contracts";

/** Only these complete native file shapes are recoverable; no inferred tool categories. */
export function completeOwnerFileAction(input: {
  readonly tool: string;
  readonly arguments?: unknown;
  readonly workingDirectory?: string | undefined;
}) {
  try {
    const args = input.arguments;
    if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
    const record = args as Readonly<Record<string, unknown>>;
    const allowed =
      input.tool === "Read"
        ? ["file_path", "offset", "limit", "pages"]
        : input.tool === "Write"
          ? ["file_path", "content"]
          : input.tool === "Edit"
            ? ["file_path", "old_string", "new_string", "replace_all"]
            : undefined;
    if (allowed === undefined || Object.keys(record).some((key) => !allowed.includes(key)))
      return undefined;
    if (
      typeof record.file_path !== "string" ||
      record.file_path.length === 0 ||
      record.file_path.includes("\0")
    )
      return undefined;
    if (input.tool === "Write" && typeof record.content !== "string") return undefined;
    if (
      input.tool === "Edit" &&
      (typeof record.old_string !== "string" ||
        typeof record.new_string !== "string" ||
        (record.replace_all !== undefined && typeof record.replace_all !== "boolean"))
    )
      return undefined;
    if (
      input.tool === "Read" &&
      ((record.offset !== undefined &&
        (!Number.isSafeInteger(record.offset) || Number(record.offset) < 0)) ||
        (record.limit !== undefined &&
          (!Number.isSafeInteger(record.limit) || Number(record.limit) < 0)) ||
        (record.pages !== undefined && typeof record.pages !== "string"))
    )
      return undefined;
    const action = {
      kind:
        input.tool === "Read" ? "file-read" : input.tool === "Write" ? "file-write" : "file-edit",
      tool: input.tool,
      input: JSON.stringify(args),
      ...(input.workingDirectory === undefined ? {} : { workingDirectory: input.workingDirectory }),
    };
    const text = JSON.stringify(action);
    if (redactSecretShaped(text) !== text) return undefined;
    return decodeOwnerApprovalAction(action);
  } catch {
    return undefined;
  }
}

/**
 * Text shaped like a credential: a bearer header, a key or token assignment,
 * or a provider's own key prefix. It is replaced before provider-composed text
 * crosses into anything Octant shows, keeps, or sends on, as the
 * provider-neutral floor under each runtime's own redaction.
 */
export const SECRET_SHAPED =
  /(?:bearer\s+[A-Za-z0-9._-]{20,}|(?:refresh_token|access_token|api[_-]?key|token)\s*[=:]\s*\S+|authorization\s*:\s*[^\r\n]+|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|lin_api_[A-Za-z0-9_]+|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b)/gi;

/** Replaces every credential-shaped run in `text`, repeating until none is left. */
export function redactSecretShaped(text: string): string {
  let redacted = text;
  for (let pass = 0; pass < 5; pass += 1) {
    SECRET_SHAPED.lastIndex = 0;
    if (!SECRET_SHAPED.test(redacted)) break;
    redacted = redacted.replaceAll(SECRET_SHAPED, "[redacted]");
  }
  return redacted;
}

/**
 * The argument fields a reviewer judges a call by: what runs, where, and what
 * it touches or reaches. Everything else a runtime attaches to a request (an
 * output, an account, a key, a transcript path, an SDK object, the contents of
 * a write) stays out.
 */
const JUDGED_FIELDS: ReadonlySet<string> = new Set([
  "command",
  "cmd",
  "cwd",
  "workdir",
  "file_path",
  "filePath",
  "filepath",
  "path",
  "paths",
  "notebook_path",
  "url",
  "uri",
  "pattern",
  "patterns",
  "glob",
  "include",
  "locations",
  "grantRoot",
  "permissions",
  "networkApprovalContext",
]);

function judged(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactSecretShaped(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth > 4) return undefined;
  if (Array.isArray(value)) return value.slice(0, 64).map((entry) => judged(entry, depth + 1));
  if (typeof value !== "object") return undefined;
  const picked: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    // Inside a judged field every structure is kept (a location's path, a
    // permission's entries); at the top only the judged fields are.
    if (depth === 0 && !JUDGED_FIELDS.has(key)) continue;
    const kept = judged(child, depth + 1);
    if (kept !== undefined) picked[key] = kept;
  }
  return picked;
}

/**
 * The pending call an approval request names, for an automatic reviewer: the
 * runtime's tool name, the judged argument fields as JSON with credentials
 * redacted and cut to the bound, and where it runs. Never the call's output.
 */
export function providerApprovalCall(input: {
  readonly tool: string;
  readonly arguments?: unknown;
  readonly workingDirectory?: string | undefined;
}): ProviderApprovalCall | undefined {
  const tool = input.tool.trim().slice(0, 255);
  if (tool.length === 0) return undefined;
  let text: string | undefined;
  try {
    const picked =
      typeof input.arguments === "object" && input.arguments !== null
        ? judged(input.arguments)
        : undefined;
    text = picked === undefined ? undefined : JSON.stringify(picked);
  } catch {
    text = undefined;
  }
  const workingDirectory = input.workingDirectory?.trim();
  const ownerAction = completeOwnerFileAction(input);
  return {
    tool,
    ...(ownerAction === undefined ? {} : { ownerAction }),
    ...(text === undefined || text === "{}"
      ? {}
      : { input: text.slice(0, MAX_PROVIDER_APPROVAL_CALL_INPUT_LENGTH) }),
    ...(workingDirectory === undefined || workingDirectory.length === 0
      ? {}
      : { workingDirectory: redactSecretShaped(workingDirectory).slice(0, 4_096) }),
  };
}
