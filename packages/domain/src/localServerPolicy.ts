import type {
  LocalServerAttribution,
  LocalServerStartSource,
  ProviderExecutionPolicy,
} from "@octant/contracts";

/**
 * Pure classification and authority for Code Environment "Local servers" (#936).
 *
 * Two rules drive every decision here and both fail closed:
 *
 * 1. A listener is *listed* only when the host can positively classify it as a
 *    current-user application or development server. Everything else — system
 *    daemons, root or other-user processes, and interpreters with no project
 *    and no editor lineage — is omitted from the observation entirely rather
 *    than shown as a disabled row, so the list can never be used as a host
 *    process inventory.
 * 2. Stop is offered only for a listener that survived (1) and is not on the
 *    system denylist. Holding a port is never on its own a reason to signal a
 *    process.
 */

/**
 * Processes that must never be signalled even if they somehow reached
 * classification. These are the OS and infrastructure helpers whose loss would
 * break the user's session or machine; Docker Desktop is included because
 * stopping it takes every container with it.
 */
export const LOCAL_SERVER_SYSTEM_DENYLIST: ReadonlySet<string> = new Set([
  "launchd",
  "kernel_task",
  "WindowServer",
  "loginwindow",
  "sshd",
  "mDNSResponder",
  "configd",
  "syslogd",
  "securityd",
  "coreaudiod",
  "Docker Desktop",
  "com.docker.backend",
  "systemd",
  "dbus-daemon",
  "NetworkManager",
]);

/** Frameworks whose presence alone establishes a user/dev server. */
const KNOWN_FRAMEWORK_COMMANDS: ReadonlyMap<string, string> = new Map([
  ["vite", "vite"],
  ["next", "next"],
  ["next-server", "next"],
  ["astro", "astro"],
  ["expo", "expo"],
  ["nuxt", "nuxt"],
  ["remix", "remix"],
  ["webpack-dev-server", "webpack"],
  ["uvicorn", "uvicorn"],
  ["gunicorn", "gunicorn"],
  ["fastapi", "fastapi"],
  ["flask", "flask"],
  ["rails", "rails"],
  ["puma", "rails"],
  ["django", "django"],
  ["manage.py", "django"],
  ["storybook", "storybook"],
  ["vitest", "vitest"],
]);

/**
 * Interpreters that only qualify with corroboration: a project or worktree cwd,
 * or an editor/agent lineage. A bare `node` holding a port proves nothing.
 */
const RECOGNIZED_INTERPRETERS: ReadonlySet<string> = new Set([
  "node",
  "bun",
  "deno",
  "python",
  "python3",
  "ruby",
  "php",
  "dotnet",
  "go",
]);

/** Command/lineage names that identify the editor or agent that started a server. */
const START_SOURCE_LINEAGE: ReadonlyArray<readonly [string, LocalServerStartSource]> = [
  ["octant", "octant"],
  ["code helper", "vscode"],
  ["visual studio code", "vscode"],
  ["vscode", "vscode"],
  ["cursor", "other-editor"],
  ["windsurf", "other-editor"],
  ["zed", "other-editor"],
  ["jetbrains", "other-editor"],
  ["webstorm", "other-editor"],
  ["claude", "claude"],
  ["codex", "codex"],
];

/** Ownership of the process holding the port, as observed by the host. */
export type LocalListenerOwnership = "current-user" | "other-user" | "root";

export interface LocalListenerObservation {
  /** Process or app name only. Never a full command line. */
  readonly processName: string;
  /** Argv[1]-style command hint when the host could read one, e.g. `vite`. */
  readonly commandName?: string | undefined;
  readonly ownership: LocalListenerOwnership;
  readonly workingDirectory?: string | undefined;
  /** Ancestor process names, nearest first. */
  readonly lineage?: ReadonlyArray<string> | undefined;
}

export interface LocalListenerClassificationContext {
  /** Canonical root of the checkout bound to the requesting Code thread. */
  readonly currentCheckoutRoot: string;
  /** Canonical roots the host recognizes as user project/worktree locations. */
  readonly userProjectRoots: ReadonlyArray<string>;
}

export type LocalListenerClassification =
  | {
      readonly status: "listed";
      readonly startSource: LocalServerStartSource;
      readonly attribution: LocalServerAttribution;
      readonly framework?: string;
      readonly stoppable: boolean;
    }
  | {
      readonly status: "omitted";
      readonly reason: "not-current-user" | "system-denylisted" | "unclassified";
    };

/**
 * Classify one observed listener. Returning `omitted` means the listener never
 * reaches the renderer at all; the caller must not render a placeholder row for
 * it, because a hidden row is the whole point of not publishing a host process
 * inventory.
 */
export function classifyLocalListener(
  observation: LocalListenerObservation,
  context: LocalListenerClassificationContext,
): LocalListenerClassification {
  if (observation.ownership !== "current-user") return omitted("not-current-user");
  if (isDenylisted(observation.processName) || isDenylisted(observation.commandName)) {
    return omitted("system-denylisted");
  }

  const startSource = classifyStartSource(observation);
  const framework = classifyFramework(observation);
  const containment = classifyWorkspace(observation.workingDirectory, context);

  // A known framework is self-evidence. An interpreter needs a user project cwd
  // or an editor/agent lineage; anything else stays unclassified and hidden.
  const qualified =
    framework !== undefined ||
    (isRecognizedInterpreter(observation.processName) &&
      (containment !== "unknown" || startSource !== "unknown"));
  if (!qualified) return omitted("unclassified");

  return {
    status: "listed",
    startSource,
    attribution: containment === "current-checkout" ? "current-checkout" : "other",
    ...(framework === undefined ? {} : { framework }),
    stoppable: true,
  };
}

/** Who is asking for the action, in the terms the design's authority matrix uses. */
export type LocalServerActor = "local-user" | "agent" | "remote-client";

/** The requesting Code thread's execution posture. */
export type LocalServerPosture = ProviderExecutionPolicy;

export type LocalServerAction = "list" | "open" | "stop";

/** Whether the target is a server Octant started itself or somebody else's leftover. */
export type LocalServerOwnershipClass = "octant-owned" | "leftover";

export type LocalServerAuthorityDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "confirm" }
  | { readonly kind: "prompt" }
  | {
      readonly kind: "deny";
      readonly reason: "plan-read-only" | "local-host-required" | "unclassified";
    };

/**
 * Decide one Local servers action. The renderer never runs this: the server
 * answers with the decision already applied so a compromised or stale renderer
 * cannot promote a hidden row into a stoppable one.
 *
 * `confirm` means a local user must acknowledge process, cwd, and port before
 * the signal. `prompt` means an agent needs a fresh user approval that a
 * remembered Full-access grant does not satisfy.
 */
export function authorizeLocalServerAction(input: {
  readonly action: LocalServerAction;
  readonly actor: LocalServerActor;
  readonly posture: LocalServerPosture;
  readonly ownership?: LocalServerOwnershipClass | undefined;
  /** False when the host could not positively classify the target listener. */
  readonly classified?: boolean | undefined;
}): LocalServerAuthorityDecision {
  if (input.action === "list") return { kind: "allow" };
  if (input.classified === false) return { kind: "deny", reason: "unclassified" };
  if (input.action === "open") return { kind: "allow" };

  // Stop from here down.
  if (input.posture === "plan") return { kind: "deny", reason: "plan-read-only" };
  const ownership = input.ownership ?? "leftover";
  if (input.actor === "remote-client") {
    return ownership === "octant-owned"
      ? { kind: "allow" }
      : { kind: "deny", reason: "local-host-required" };
  }
  // An Octant-owned server stops under the ordinary thread/process authority the
  // thread already holds; only somebody else's leftover needs a fresh decision.
  if (ownership === "octant-owned") return { kind: "allow" };
  return input.actor === "agent" ? { kind: "prompt" } : { kind: "confirm" };
}

/**
 * Reason text for a Stop the host will not offer. Kept beside the policy so the
 * renderer states the same reason the server decided, in words rather than by a
 * missing control alone.
 */
export function describeLocalServerStopDenial(
  decision: Extract<LocalServerAuthorityDecision, { readonly kind: "deny" }>,
): string {
  switch (decision.reason) {
    case "plan-read-only":
      return "Plan threads can list and open local servers but never stop them.";
    case "local-host-required":
      return "Stopping a leftover server must happen on the host, not from a paired device.";
    case "unclassified":
      return "Octant could not classify this process and will not signal it.";
  }
}

function omitted(
  reason: Extract<LocalListenerClassification, { readonly status: "omitted" }>["reason"],
): LocalListenerClassification {
  return { status: "omitted", reason };
}

function isDenylisted(name: string | undefined): boolean {
  if (name === undefined) return false;
  const normalized = name.trim();
  if (LOCAL_SERVER_SYSTEM_DENYLIST.has(normalized)) return true;
  const lowered = normalized.toLowerCase();
  for (const entry of LOCAL_SERVER_SYSTEM_DENYLIST) {
    if (entry.toLowerCase() === lowered) return true;
  }
  return false;
}

function isRecognizedInterpreter(processName: string): boolean {
  return RECOGNIZED_INTERPRETERS.has(basename(processName).toLowerCase());
}

function classifyFramework(observation: LocalListenerObservation): string | undefined {
  for (const candidate of [observation.commandName, observation.processName]) {
    if (candidate === undefined) continue;
    const framework = KNOWN_FRAMEWORK_COMMANDS.get(basename(candidate).toLowerCase());
    if (framework !== undefined) return framework;
  }
  return undefined;
}

function classifyStartSource(observation: LocalListenerObservation): LocalServerStartSource {
  const haystack = [...(observation.lineage ?? []), observation.commandName ?? ""]
    .join(" ")
    .toLowerCase();
  for (const [needle, source] of START_SOURCE_LINEAGE) {
    if (haystack.includes(needle)) return source;
  }
  return "unknown";
}

type WorkspaceContainment = "current-checkout" | "other-project" | "unknown";

function classifyWorkspace(
  workingDirectory: string | undefined,
  context: LocalListenerClassificationContext,
): WorkspaceContainment {
  if (workingDirectory === undefined || workingDirectory === "") return "unknown";
  if (isWithin(context.currentCheckoutRoot, workingDirectory)) return "current-checkout";
  for (const root of context.userProjectRoots) {
    if (isWithin(root, workingDirectory)) return "other-project";
  }
  return "unknown";
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = root.replace(/\/+$/, "");
  if (normalizedRoot === "" || normalizedRoot === "/") return false;
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

function basename(value: string): string {
  return (
    value
      .split("/")
      .filter((segment) => segment !== "")
      .at(-1) ?? value
  );
}
