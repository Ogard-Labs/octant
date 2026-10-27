import {
  decodeCodeDebugConfiguration,
  type CodeDebugAdapterSummary,
  type CodeDebugConfiguration,
  type CodeDebugImportUnmappableReason,
  type CodeDebugRefusalReason,
  type CodeDebugSessionEndReason,
  type CodeDebugStartResult,
} from "@octant/contracts/code-debug";
import { canonicalDebugConfigurationText } from "@octant/domain/debug-session-start-policy";

/**
 * Words for every answer the host gives the Run and debug panel. The host
 * decides each one; the panel only says what it decided.
 */
export function refusalText(reason: CodeDebugRefusalReason): string {
  switch (reason) {
    case "no-reach":
      return "This window cannot reach this thread.";
    case "thread-inactive":
      return "Only an active thread can debug a program. This one is archived, waiting, or done.";
    case "checkout-mismatch":
      return "This window holds the thread on another checkout. Reopen the thread and try again.";
    case "checkout-unavailable":
      return "The thread's checkout is unavailable.";
    case "no-debug-adapter":
      return "No debug adapter for this configuration is installed and switched on for Code. Add one in Settings › Skills & Extensions.";
    case "unsupported-platform":
      return "This host cannot debug this program. Debugging runs on macOS and Linux, and native programs are not debugged on macOS yet.";
    case "mode-prohibited":
      return "Debugging is available in Code threads only.";
    case "plan-read-only":
      return "Plan is read-only, so nothing can be started from it. Leave Plan to debug.";
    case "local-host-required":
      return LOCAL_ONLY_TEXT;
    case "approval-required":
      return "This configuration needs your confirmation. If you confirmed it before, it or its adapter has changed since.";
    case "configuration-invalid":
      return "The program or folder is missing, is not the right kind of file, or leads outside the checkout.";
    case "confinement-unavailable":
      return "This host cannot confine the program, so nothing was started.";
    case "no-session":
      return "That debug session is no longer running.";
  }
}

/** A paired device, or any caller that is not one of this host's own windows. */
export const LOCAL_ONLY_TEXT =
  "Only a window on this computer can debug a program. A paired device cannot start, control, or watch a session.";

export function startAnswerText(
  answer: Exclude<CodeDebugStartResult, { readonly status: "started" }>,
): string {
  switch (answer.status) {
    case "refused":
      return refusalText(answer.reason);
    case "busy":
      return answer.reason === "thread-has-session"
        ? "This thread already has a debug session that this panel does not hold. Stop it in the window that shows it, or wait for it to end, then press Start again."
        : "This host is already running as many debug sessions as it allows. Stop one first.";
    case "failed":
      switch (answer.reason) {
        case "adapter-unverified":
          return "The adapter no longer matches the one you reviewed, so it did not run.";
        case "launch-failed":
          return "Octant could not start the session. Nothing ran.";
        case "adapter-refused":
          return "The debug adapter would not start the program, or did not answer in time.";
      }
  }
}

export function endReasonText(reason: CodeDebugSessionEndReason, exitCode?: number): string {
  switch (reason) {
    case "stopped":
      return "You stopped the session.";
    case "program-exited":
      return exitCode === undefined
        ? "The program exited."
        : `The program exited with code ${exitCode}.`;
    case "adapter-exited":
      return "The debug adapter ended on its own.";
    case "protocol-violation":
      return "The debug adapter sent something Octant does not accept, so the session ended.";
    case "start-failed":
      return "The session ended before it reached the program.";
    case "thread-inactive":
      return "The session ended because the thread is no longer active.";
    case "plan-read-only":
      return "The session ended because the thread moved to Plan.";
    case "network-changed":
      return "The session ended because the thread's access moved across Full access, which changes what the program may reach.";
    case "checkout-unavailable":
      return "The session ended because the checkout became unavailable.";
    case "approval-ended":
      return "The session ended because your confirmation no longer covers this configuration and its adapter as they stand.";
    case "project-erased":
      return "The session ended because the Project was erased.";
    case "host-shutdown":
      return "The session ended because the host shut down.";
    case "host-restarted":
      return "The session ended because the host restarted.";
  }
}

export function unmappableText(reason: CodeDebugImportUnmappableReason): string {
  switch (reason) {
    case "not-launch":
      return "Not a launch entry.";
    case "no-adapter":
      return "No installed debug adapter takes this type.";
    case "adapter-ambiguous":
      return "More than one debug adapter takes this type.";
    case "unsupported-variable":
      return "Uses a variable Octant does not fill.";
    case "needs-open-file":
      return "Uses the current file. Open a file in the editor, then refresh.";
    case "outside-checkout":
      return "Its program or folder is outside the checkout.";
    case "invalid":
      return "A value is missing, of the wrong kind, or too long.";
  }
}

/**
 * An adapter's name where configurations are listed. Two installed adapters
 * may share a name, so a shared one also names its package and version, and
 * its id when even those match.
 */
export function adapterName(
  adapters: ReadonlyArray<CodeDebugAdapterSummary>,
  adapter: string,
): string {
  const summary = adapters.find((candidate) => String(candidate.adapter) === adapter);
  if (summary === undefined) return adapter;
  const sharing = adapters.filter((candidate) => candidate.displayName === summary.displayName);
  return sharing.length === 1
    ? summary.displayName
    : `${summary.displayName} (${distinctPackageText(sharing, summary)})`;
}

/**
 * Which adapter the confirmation card allows: its name and the package it
 * came from, since the confirmation covers that package as it stands.
 */
export function adapterIdentity(
  adapters: ReadonlyArray<CodeDebugAdapterSummary>,
  adapter: string,
): string {
  const summary = adapters.find((candidate) => String(candidate.adapter) === adapter);
  if (summary === undefined) return adapter;
  const sharing = adapters.filter((candidate) => candidate.displayName === summary.displayName);
  return `${summary.displayName}, from ${distinctPackageText(sharing, summary)}`;
}

function distinctPackageText(
  sharing: ReadonlyArray<CodeDebugAdapterSummary>,
  summary: CodeDebugAdapterSummary,
): string {
  const text = (candidate: CodeDebugAdapterSummary) =>
    `${candidate.packageName} ${candidate.packageVersion}`;
  const own = text(summary);
  return sharing.filter((candidate) => text(candidate) === own).length === 1
    ? own
    : `${own}, ${String(summary.adapter)}`;
}

/** The configuration a person writes in the panel, as typed. */
export interface ConfigurationDraft {
  readonly name: string;
  readonly adapter: string;
  readonly program: string;
  /** One argument per line. */
  readonly args: string;
  readonly cwd: string;
  /** One `NAME=value` per line. */
  readonly env: string;
  readonly stopOnEntry: boolean;
}

export function emptyDraft(adapter: string | undefined): ConfigurationDraft {
  return {
    name: "",
    adapter: adapter ?? "",
    program: "",
    args: "",
    cwd: "",
    env: "",
    stopOnEntry: false,
  };
}

export type DraftReading =
  | { readonly status: "ready"; readonly configuration: CodeDebugConfiguration }
  | { readonly status: "invalid"; readonly message: string };

/**
 * Reads a draft into a configuration's shape. This checks only the shape, so
 * the person hears about a typo before confirming; the host checks the paths
 * and everything else again when they confirm and at every start.
 */
export function readDraft(draft: ConfigurationDraft): DraftReading {
  const lines = (text: string) => text.split("\n").filter((line) => line.trim().length > 0);
  const env: Array<{ readonly key: string; readonly value: string }> = [];
  for (const line of lines(draft.env)) {
    const split = line.indexOf("=");
    if (split <= 0) {
      return { status: "invalid", message: "Write each environment entry as NAME=value." };
    }
    env.push({ key: line.slice(0, split).trim(), value: line.slice(split + 1) });
  }
  const cwd = draft.cwd.trim();
  try {
    return {
      status: "ready",
      configuration: decodeCodeDebugConfiguration({
        name: draft.name.trim(),
        adapter: draft.adapter,
        program: draft.program.trim(),
        args: lines(draft.args),
        ...(cwd.length === 0 || cwd === "." ? {} : { cwd }),
        env,
        stopOnEntry: draft.stopOnEntry,
      }),
    };
  } catch {
    return {
      status: "invalid",
      message:
        "Check the configuration: it needs a name and an adapter; the program and folder are paths inside the checkout; environment names are letters, digits, and underscores, and cannot be Octant's own or a credential's.",
    };
  }
}

/**
 * Two configurations are the same record when the host would digest them the
 * same, so a proposal reads as confirmed only when its approval covers it.
 */
export function sameConfiguration(
  left: CodeDebugConfiguration,
  right: CodeDebugConfiguration,
): boolean {
  return canonicalDebugConfigurationText(left) === canonicalDebugConfigurationText(right);
}
