import { browserToolImage } from "../browser/browserToolImage";
import {
  browserToolAction,
  browserToolResult,
  browserToolWantsScreenshot,
  parseBrowserToolInput,
  type BrowserToolInput,
} from "../browser/browserToolOperations";
import { BROWSER_TOOL_DEFINITION, BROWSER_TOOL_HELP } from "../browser/browserToolDefinition";
import type {
  BrowserActionRequest,
  BrowserAutomationSnapshot,
  BrowserThreadId,
  CodeApprovalId,
  CodeBoardView,
  CodeMergeStandingSource,
  CodeOperationCommand,
  CodeOperationResult,
  CodePlannerWorkProposal,
  CodeTerminalId,
  CodeThread,
  EventActor,
  ToolActionApproval,
  ToolActionAuthority,
  ToolActionRequest,
  ToolApprovalId,
  WindowId,
} from "@octant/contracts";
import { MAX_BROWSER_TABS_PER_CONTEXT } from "@octant/contracts";
import {
  decodeAppleSimulatorId,
  decodeAndroidEmulatorId,
  type AppleActionRequest,
  type AppleBuildEvidence,
  type AppleDiscoveryRequest,
  type AppleRuntimeSnapshot,
  type ApplePlatform,
  type AppleSimulatorId,
  type AndroidDiscoveryRequest,
  type AndroidEmulatorEvidence,
  type AndroidEmulatorId,
  type AndroidEmulatorRequest,
  type AndroidRuntimeSnapshot,
} from "@octant/contracts";
import {
  clampTurnAccessPosture,
  decideProfileToolConstraint,
  decidesCodeEffectsByApproval,
  isAndroidEmulatorInputKind,
  isAppleSimulatorInputKind,
  isToolAllowedByAllowlist,
} from "@octant/domain";
import type { AppleDiscoveryResult } from "../apple/appleToolchainService";
import type { AndroidDiscoveryResult } from "../android/androidToolchainService";
import type {
  ExternalContentIngestionResult,
  RecordExternalContentIngestionInput,
} from "../context/externalContentIngestionStore";
import { withToolFamilyHelp, type AppManagedToolSet } from "../providers/appManagedToolSet";
import { taintAppManagedToolResults } from "../providers/appManagedToolTaint";
import { pullRequestChangeNeedsPerActApproval } from "@octant/domain/code-pull-request-action-policy";
import type { CodeOperationTerminalSnapshot } from "./codeOperationService";

const MAX_TOOL_INPUT_BYTES = 16 * 1024;
// A pull-request body is often longer than any other tool input.
const MAX_PULL_REQUEST_TOOL_INPUT_BYTES = 128 * 1024;
const MAX_TERMINAL_RESULT_BYTES = 32 * 1024;
const MAX_TERMINAL_SCAN_BYTES = 64 * 1024;
const TERMINAL_COMMAND_TIMEOUT_MS = 30_000;
const TERMINAL_COMPLETION_POLL_MS = 50;

export const CODE_BROWSER_TOOL_NAME = BROWSER_TOOL_DEFINITION.name;
export const CODE_TERMINAL_TOOL_NAME = "octant_terminal";
export const CODE_APPLE_TOOL_NAME = "octant_apple";
export const CODE_ANDROID_TOOL_NAME = "octant_android";
export const CODE_BOARD_TOOL_NAME = "octant_board";
export const CODE_PROPOSE_THREAD_TOOL_NAME = "octant_propose_thread";
export const CODE_PULL_REQUEST_TOOL_NAME = "octant_pull_request";

/**
 * Ceiling on cards one board read hands the provider. The board is ordered by
 * most recent meaningful activity, so the planner always sees the live end of
 * a Project that has outgrown the bound.
 */
const MAX_BOARD_TOOL_CARDS = 100;

/** How long one agent-driven Apple action may run before it is given up on. */
const APPLE_BUILD_TIMEOUT_MS = 15 * 60_000;
const APPLE_BOOT_TIMEOUT_MS = 120_000;
const APPLE_SIMULATOR_TIMEOUT_MS = 30_000;
const MAX_APPLE_RESULT_DIAGNOSTICS = 16;

const boardDefinition = {
  name: CODE_BOARD_TOOL_NAME,
  description:
    "Read the current Project's server-authoritative task board as its designated planner. Use the returned task states, delivery evidence, checks, and child-agent activity to decide what needs attention. The result is a bounded recent list; check truncation before claiming it covers every task. This tool does not change task status or create work.",
  inputSchema: {
    type: "object",
    properties: { operation: { type: "string", enum: ["read"] } },
    required: ["operation"],
  },
} as const;

const proposeThreadDefinition = {
  name: CODE_PROPOSE_THREAD_TOOL_NAME,
  description:
    "Propose a new Code task to the user from the current Project's designated planner. Supply a clear title, the intended outcome in intent, and an optional rationale. The proposal waits for user acceptance; it does not create or start a task, checkout, or pull request. Report proposed work as proposed, not running or completed.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string" },
      intent: { type: "string" },
      rationale: { type: "string" },
    },
    required: ["title", "intent"],
  },
} as const;

const pullRequestDefinition = {
  name: CODE_PULL_REQUEST_TOOL_NAME,
  description:
    "Open or change the pull request for this thread's own branch, only when the person asks for it. create opens it with a title and body, as a draft when draft is true, and stacked on another open branch when base names a branch that has an open pull request of its own; without base it targets the thread's delivery base. update changes the open pull request's title, body, or draft state (draft false marks it ready for review), adds or removes labels the repository already has, or closes it (state closed) or reopens it (state open). comment posts a comment, or a reply in one review thread when reviewThreadId is given, and merge merges it with the method and the head commit the person saw; comment always asks the person first, at every access level, because it acts under their name; merge asks unless a stored choice allows it. Push the branch first. An approval-gated thread asks the person before GitHub is touched, and refuses a title and body too long to show whole in that approval (about 1.5 KB together); Plan mode refuses. This tool cannot create labels, approve or request changes, delete a branch, or change any other branch's pull request.",
  inputSchema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["create", "update", "comment", "merge"] },
      title: { type: "string" },
      body: { type: "string" },
      draft: { type: "boolean" },
      base: { type: "string" },
      addLabels: { type: "array", items: { type: "string" } },
      removeLabels: { type: "array", items: { type: "string" } },
      state: { type: "string", enum: ["closed", "open"] },
      reviewThreadId: { type: "string" },
      method: { type: "string", enum: ["merge", "squash", "rebase"] },
      headSha: { type: "string" },
    },
    required: ["operation"],
  },
} as const;

const terminalDefinition = {
  name: CODE_TERMINAL_TOOL_NAME,
  description:
    "Use Octant's terminal for this Code task: run starts a command, write sends input, read checks output, and stop terminates it. Check commandCompleted and commandExitCode; a running terminal is not proof that its command succeeded. Ordinary terminal permissions still apply. Call operation help for full usage.",
  inputSchema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["run", "write", "read", "stop", "help"] },
      command: { type: "string" },
    },
    required: ["operation"],
  },
} as const;

const appleDefinition = {
  name: CODE_APPLE_TOOL_NAME,
  description:
    "Build, test, run, and drive Apple apps through Octant's in-app iOS Simulator pane and Apple workbench. Begin with discover or status and reuse the returned identifiers. Show a Simulator only in that pane: never launch Simulator.app, run open -a Simulator, or start serve-sim. discover, status, screenshot, and open of a running Simulator are reads under any posture; every other operation is an effect that Plan mode refuses and an approval-gated thread runs only after the person allows it. Inspect returned evidence before claiming success. Call operation help for full usage.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: [
          "discover",
          "status",
          "build",
          "test",
          "run",
          "boot",
          "open",
          "shutdown",
          "screenshot",
          "tap",
          "swipe",
          "type-text",
          "key-press",
          "help",
        ],
      },
      projectPath: { type: "string" },
      scheme: { type: "string" },
      platform: { type: "string", enum: ["ios", "macos", "watchos", "tvos", "visionos"] },
      simulatorId: { type: "string" },
      bundleIdentifier: { type: "string" },
      target: { type: "string" },
      x: { type: "number" },
      y: { type: "number" },
      toX: { type: "number" },
      toY: { type: "number" },
      durationMs: { type: "number" },
      text: { type: "string" },
      key: { type: "string" },
    },
    required: ["operation"],
  },
} as const;

const androidDefinition = {
  name: CODE_ANDROID_TOOL_NAME,
  description:
    "Boot, inspect, and drive Android emulators through Octant's in-app Android emulator pane. Begin with discover or status and reuse the returned AVD names; never start an external emulator window as the place to look. discover, status, screenshot, and open of a running emulator are reads under any posture; every other operation is an effect that Plan mode refuses and an approval-gated thread runs only after the person allows it. Inspect returned evidence before claiming success. Call operation help for full usage.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: [
          "discover",
          "status",
          "open",
          "boot",
          "shutdown",
          "screenshot",
          "tap",
          "swipe",
          "type-text",
          "key-press",
          "install",
          "launch",
          "help",
        ],
      },
      emulatorId: { type: "string" },
      x: { type: "number" },
      y: { type: "number" },
      toX: { type: "number" },
      toY: { type: "number" },
      durationMs: { type: "number" },
      text: { type: "string" },
      key: { type: "string" },
      apkPath: { type: "string" },
      packageName: { type: "string" },
    },
    required: ["operation"],
  },
} as const;

/**
 * Full usage for each Code family, returned by its `help` operation. The
 * always-visible descriptions above keep only what an agent must know before
 * its first call.
 */
const CODE_TOOL_HELP: Readonly<Record<string, string>> = {
  ...BROWSER_TOOL_HELP,
  [CODE_PULL_REQUEST_TOOL_NAME]:
    "Open or change the pull request for this thread's own branch, only when the person asks. create needs title and takes body, draft (true opens a draft), and base (another branch with an open pull request, to stack on it). update takes title, body, or draft (false marks the pull request ready for review, true turns it back into a draft). Push the branch before create. The result names the pull request's number, url, base, and draft state; report exactly that. An approval-gated thread shows the person the whole title and body, so keep them short enough to read there (about 1.5 KB together). update also takes addLabels and removeLabels (labels the repository already has; none are created) and state: closed closes the pull request and open reopens a closed one, and neither deletes the branch; state stands alone. comment takes body, and reviewThreadId to reply in one review thread. merge takes method (merge, squash, or rebase) and headSha, the head commit the person saw; the host refuses it when the head moved, the pull request is not open and mergeable, or its required checks have not passed. comment asks the person for each act at every access level. merge asks too, unless the person stored a choice that lets agents merge in this Project or this routine; use it only when the person asked for it or that stored choice covers it. Approving, requesting changes, creating labels, and deleting the branch are not available.",
  [CODE_TERMINAL_TOOL_NAME]:
    "Use Octant's terminal for this Code task: run starts a command, write supplies input to the running terminal, read checks its output, and stop terminates it. command is required for run or write. Check commandCompleted and commandExitCode; a running terminal is not proof that its command succeeded. For document artifacts, create files within the bound checkout and report their real relative paths. Octant's Files and Document tools provide host-authorized previews; never invent an artifact URL or claim a preview opened based on a write alone. Ordinary terminal permissions still apply.",
  [CODE_APPLE_TOOL_NAME]:
    "Build, test, run, and inspect Apple apps through Octant's in-app Simulator pane and Apple workbench. Begin with discover or status and use the returned project, scheme, and destination identifiers for later operations. discover, build, test, and run take projectPath: an .xcodeproj or .xcworkspace inside this thread's checkout, either relative to the checkout root (App/App.xcodeproj) or absolute under it; a path outside the checkout is refused. boot, run, and open show the selected Simulator in Octant's iOS Simulator pane — never launch Simulator.app, never run open -a Simulator, and never start serve-sim or another out-of-app simulator. open boots the destination if it is shut down, otherwise only opens the pane. shutdown stops it; screenshot returns its current screen as an image when it fits the provider image limit. tap takes a point (x, y) in the pixels of the latest screenshot; swipe goes from (x, y) to (toX, toY) in the same pixels, over durationMs when given — a short one flings a list, a long one drags. Use only supported operations and inspect returned build, test, or runtime evidence before claiming success. discover, status, screenshot, and open of a destination that is already running are reads; every other operation is an effect, which Plan mode refuses and an approval-gated thread runs only after the person allows it. An unavailable operation is not a successful action or permission to bypass the host's validation and approval policy.",
  [CODE_ANDROID_TOOL_NAME]:
    "Boot, inspect, and drive Android emulators through Octant's in-app Android emulator pane. Begin with discover or status and use the returned AVD names for later operations. boot, open, install, and launch show the selected emulator in Octant's Android emulator pane — never start an external emulator window as the place to look. open boots the destination if it is shut down, otherwise only opens the pane. shutdown stops it; screenshot returns its current screen as an image when it fits the provider image limit. tap takes a point (x, y) in the pixels of the live screen; swipe goes from (x, y) to (toX, toY) over durationMs when given. install takes a checkout-relative APK; launch takes a package name. Use only supported operations and inspect returned evidence before claiming success. discover, status, screenshot, and open of a destination that is already running are reads; every other operation is an effect, which Plan mode refuses and an approval-gated thread runs only after the person allows it. An unavailable operation is not a successful action or permission to bypass the host's validation and approval policy.",
};

/**
 * What the Apple capability lends one Code thread's agent.
 *
 * Deliberately the same requests the workbench sends: the host resolves the
 * thread's checkout, root, and posture for both, and the same Apple policy
 * decides. The tool takes no shortcut a person operating the workbench could
 * not take, and mints no destination of its own.
 */
interface CodeDeviceScreenshotPort {
  readonly readScreenshot: (
    windowId: WindowId,
    scope: {
      readonly authority: ToolActionAuthority;
      readonly threadId: CodeThread["id"];
      readonly checkoutId: CodeThread["checkoutId"];
    },
    reference: string,
  ) => Promise<Uint8Array | undefined>;
}

export interface CodeAppleToolPort extends CodeDeviceScreenshotPort {
  readonly resolveAuthority: (
    windowId: WindowId,
    thread: CodeThread,
  ) => ToolActionAuthority | undefined;
  readonly discover: (
    windowId: WindowId,
    request: AppleDiscoveryRequest,
  ) => Promise<AppleDiscoveryResult | undefined>;
  readonly execute: (
    windowId: WindowId,
    request: AppleActionRequest,
  ) => Promise<AppleBuildEvidence | undefined>;
  readonly snapshot: (
    windowId: WindowId,
    scope: {
      readonly authority: ToolActionAuthority;
      readonly threadId: CodeThread["id"];
      readonly checkoutId: CodeThread["checkoutId"];
    },
  ) => Promise<AppleRuntimeSnapshot | undefined>;
  readonly requestPaneOpen: (
    windowId: WindowId,
    scope: {
      readonly authority: ToolActionAuthority;
      readonly threadId: CodeThread["id"];
      readonly checkoutId: CodeThread["checkoutId"];
    },
    simulatorId: AppleSimulatorId,
  ) => Promise<AppleRuntimeSnapshot | undefined>;
  /**
   * Whether this window already holds the Simulator open to input on this
   * thread. The host still decides every input; this only spares the person a
   * second question for input their Allow input already covers.
   */
  readonly inputGrantIsOpen: (
    windowId: WindowId,
    threadId: CodeThread["id"],
    simulatorId: AppleSimulatorId,
  ) => boolean;
}

export interface CodeAndroidToolPort extends CodeDeviceScreenshotPort {
  readonly resolveAuthority: (
    windowId: WindowId,
    thread: CodeThread,
  ) => ToolActionAuthority | undefined;
  readonly discover: (
    windowId: WindowId,
    request: AndroidDiscoveryRequest,
  ) => Promise<AndroidDiscoveryResult | undefined>;
  readonly execute: (
    windowId: WindowId,
    request: AndroidEmulatorRequest,
  ) => Promise<AndroidEmulatorEvidence | undefined>;
  readonly snapshot: (
    windowId: WindowId,
    scope: {
      readonly authority: ToolActionAuthority;
      readonly threadId: CodeThread["id"];
      readonly checkoutId: CodeThread["checkoutId"];
    },
  ) => Promise<AndroidRuntimeSnapshot | undefined>;
  readonly requestPaneOpen: (
    windowId: WindowId,
    scope: {
      readonly authority: ToolActionAuthority;
      readonly threadId: CodeThread["id"];
      readonly checkoutId: CodeThread["checkoutId"];
    },
    emulatorId: AndroidEmulatorId,
  ) => Promise<AndroidRuntimeSnapshot | undefined>;
  /** The Android counterpart of {@link CodeAppleToolPort.inputGrantIsOpen}. */
  readonly inputGrantIsOpen: (
    windowId: WindowId,
    threadId: CodeThread["id"],
    emulatorId: AndroidEmulatorId,
  ) => boolean;
}

/** A device effect the thread's agent asks for, exactly as it will reach the host. */
export type CodeDeviceApprovalEffect =
  | { readonly kind: "apple-action"; readonly request: AppleActionRequest }
  | { readonly kind: "android-action"; readonly request: AndroidEmulatorRequest };

export interface CodeAppManagedToolsOptions {
  readonly windowId: WindowId;
  readonly thread: CodeThread;
  readonly readThread: (windowId: WindowId, threadId: CodeThread["id"]) => CodeThread | undefined;
  readonly uuid: () => string;
  readonly browserApproval?: {
    readonly isApproved: (contextId: string) => boolean;
    readonly request: (
      origin: string,
      signal?: AbortSignal,
    ) => Promise<"approved" | "denied" | "cancelled" | "expired">;
    /** A grant the person remembered with "always allow"; a new context for
     * that origin opens without asking. */
    readonly isOriginRemembered?: (origin: string) => boolean;
    readonly remember: (contextId: string) => void;
    readonly forget: (contextId: string) => void;
  };
  /**
   * Asks the person, in the thread, to allow one device effect, and on approval
   * returns the host's one-use approval for exactly that request. The host's
   * Apple and Android policy validates it like a workbench click's.
   */
  readonly deviceApproval?: {
    readonly request: (
      effect: CodeDeviceApprovalEffect,
      signal?: AbortSignal,
    ) => Promise<
      | { readonly status: "approved"; readonly approvalId: ToolApprovalId }
      | { readonly status: "denied" | "cancelled" | "expired" | "unavailable" }
    >;
  };
  /**
   * Asks the person, in the thread, to allow one pull-request change, and on
   * approval returns the host's one-use approval for exactly that command.
   * Absent on a host that cannot ask; the pull-request tool is then omitted.
   */
  /**
   * Asks the person, in the thread, to let the agent type one command into its
   * terminal, naming it; on approval of a command that starts the terminal,
   * the host also holds the one-use approval the start needs. Absent on a host
   * that cannot ask, where the terminal then runs only at Full access.
   */
  readonly terminalApproval?: {
    readonly request: (
      input: { readonly text: string; readonly start?: CodeOperationCommand },
      signal?: AbortSignal,
    ) => Promise<"approved" | "denied" | "cancelled" | "expired" | "unavailable">;
  };
  readonly pullRequestApproval?: {
    readonly request: (
      command: PullRequestToolCommand,
      signal?: AbortSignal,
    ) => Promise<
      | { readonly status: "approved"; readonly approvalId: CodeApprovalId }
      | {
          readonly status: "denied" | "cancelled" | "expired" | "unavailable" | "too-large";
        }
    >;
  };
  /**
   * The stored choice, if any, that lets this thread merge without asking for
   * each act. The tool only names it; the host checks it again before merging.
   */
  readonly standingMerge?: () => CodeMergeStandingSource | undefined;
  readonly executeOperation: (
    windowId: WindowId,
    command: CodeOperationCommand,
  ) => Promise<CodeOperationResult>;
  readonly terminal: {
    readonly read: (
      windowId: WindowId,
      input: {
        readonly threadId: CodeThread["id"];
        readonly checkoutId: CodeThread["checkoutId"];
        readonly terminalId: CodeTerminalId;
      },
    ) => Promise<CodeOperationTerminalSnapshot>;
    readonly interrupt?: (
      windowId: WindowId,
      input: {
        readonly threadId: CodeThread["id"];
        readonly checkoutId: CodeThread["checkoutId"];
        readonly terminalId: CodeTerminalId;
      },
    ) => Promise<CodeOperationTerminalSnapshot>;
    readonly terminate?: (
      windowId: WindowId,
      input: {
        readonly threadId: CodeThread["id"];
        readonly checkoutId: CodeThread["checkoutId"];
        readonly terminalId: CodeTerminalId;
      },
    ) => Promise<CodeOperationTerminalSnapshot>;
  };
  readonly browser?: {
    readonly resolveAuthority: (
      threadId: BrowserThreadId,
      mode: "code",
    ) => ToolActionAuthority | undefined;
    readonly inspectThread: (
      windowId: WindowId,
      threadId: BrowserThreadId,
    ) => BrowserAutomationSnapshot;
    readonly create: (input: {
      readonly windowId: WindowId;
      readonly threadId: BrowserThreadId;
      readonly action: ToolActionRequest;
      readonly policy: {
        readonly profileMode: "isolated";
        readonly allowedOrigins: readonly string[];
        readonly credentialFieldProtection: true;
        readonly maxConcurrentTabs: number;
        readonly sessionTimeoutMs: number;
      };
    }) => Promise<BrowserAutomationSnapshot>;
    readonly act: (input: {
      readonly windowId: WindowId;
      readonly request: BrowserActionRequest;
      readonly capturedBy?: "agent";
    }) => Promise<BrowserAutomationSnapshot>;
    readonly releaseThread: (
      windowId: WindowId,
      threadId: BrowserThreadId,
    ) => Promise<BrowserAutomationSnapshot>;
  };
  readonly apple?: CodeAppleToolPort;
  readonly android?: CodeAndroidToolPort;
  /**
   * What the planner capability lends one thread's agent: a read of its own
   * Project's server-authoritative board, and an advisory work proposal that
   * waits for the user. Both re-resolve the planner designation on every call,
   * so only the currently designated planner thread ever gets an answer, and
   * neither can mutate a thread, a checkout, or GitHub.
   */
  readonly planner?: CodePlannerToolPort;
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly recordExternalContentIngestion?: (
    input: RecordExternalContentIngestionInput,
  ) => ExternalContentIngestionResult;
}

export interface CodePlannerToolPort {
  /**
   * Whether this thread is currently its Project's designated planner. Used
   * only to decide whether the planner tools are advertised at all; every
   * call still re-validates through {@link board} and {@link propose}.
   */
  readonly isPlannerThread: (threadId: CodeThread["id"]) => boolean;
  readonly board: (
    windowId: WindowId,
    threadId: CodeThread["id"],
  ) => Promise<
    | { readonly status: "ok"; readonly board: CodeBoardView }
    | { readonly status: "refused"; readonly reason: string; readonly message: string }
  >;
  readonly propose: (
    windowId: WindowId,
    threadId: CodeThread["id"],
    draft: { readonly title: string; readonly intent: string; readonly rationale?: string },
  ) => Promise<
    | { readonly status: "proposed"; readonly proposal: CodePlannerWorkProposal }
    | { readonly status: "refused"; readonly reason: string; readonly message: string }
  >;
}

export function createCodeAppManagedTools(options: CodeAppManagedToolsOptions): AppManagedToolSet {
  const allowlist = options.thread.toolConstraints ?? [];
  const tools: AppManagedToolSet = {
    definitions: [
      // A family whose capability this host did not lend is omitted, not
      // advertised only to be refused on every call.
      ...(options.browser === undefined ? [] : [BROWSER_TOOL_DEFINITION]),
      terminalDefinition,
      ...(options.apple === undefined ? [] : [appleDefinition]),
      ...(options.android === undefined ? [] : [androidDefinition]),
      ...(options.pullRequestApproval === undefined ? [] : [pullRequestDefinition]),
      // The planner tools appear only in the currently designated planner
      // thread. Any other thread that calls them anyway is refused by name
      // below with a value, never a throw.
      ...(options.planner !== undefined && options.planner.isPlannerThread(options.thread.id)
        ? [boardDefinition, proposeThreadDefinition]
        : []),
    ].filter((definition) => isToolAllowedByAllowlist(allowlist, definition.name)),
    execute: async ({ name, inputJson, signal }) => {
      if (signal?.aborted) return failure("tool-interrupted");
      const stalenessFailure = currentThreadIdentityFailure(options);
      if (stalenessFailure !== undefined) return failure(stalenessFailure);
      const profileFailure = profileToolConstraintFailure(options.thread, name);
      if (profileFailure !== undefined) {
        return failure("profile-tool-refused", profileFailure);
      }
      // The planner tools sit before the posture gate: a board read and an
      // advisory proposal work under any posture, because neither has an
      // effect an approval could gate. Designation is re-validated inside.
      if (name === CODE_BOARD_TOOL_NAME && options.planner !== undefined) {
        return plannerBoardTool(options, parseBoardInput(inputJson));
      }
      if (name === CODE_PROPOSE_THREAD_TOOL_NAME && options.planner !== undefined) {
        return plannerProposeTool(options, parseProposeThreadInput(inputJson));
      }
      if (name === CODE_BROWSER_TOOL_NAME && options.browser !== undefined) {
        return browserTool(
          options,
          parseBrowserToolInput(inputJson, { allowProfile: false }),
          signal,
        );
      }
      // The device tools decide per operation: reads run under any posture,
      // effects ask the person under an approval-gated one. See
      // `deviceEffectApproval`.
      if (name === CODE_APPLE_TOOL_NAME && options.apple !== undefined) {
        return appleTool(options, parseAppleInput(inputJson), signal);
      }
      if (name === CODE_ANDROID_TOOL_NAME && options.android !== undefined) {
        return androidTool(options, parseAndroidInput(inputJson), signal);
      }
      if (name === CODE_PULL_REQUEST_TOOL_NAME && options.pullRequestApproval !== undefined) {
        return pullRequestTool(options, parsePullRequestInput(inputJson), signal);
      }
      // The terminal follows the thread's level: Plan refuses it, a prompting
      // level asks the person before each command, and Full access runs it.
      if (name === CODE_TERMINAL_TOOL_NAME) {
        const terminalFailure = terminalAuthorityFailure(options);
        if (terminalFailure !== undefined) {
          return failure(terminalFailure, postureRefusal(terminalFailure));
        }
        return terminalTool(options, parseTerminalInput(inputJson), signal);
      }
      const postureFailure = currentAuthorityFailure(options);
      if (postureFailure !== undefined) {
        return failure(postureFailure, postureRefusal(postureFailure));
      }
      return failure("tool-unavailable");
    },
  };
  // Help is the family's own static text, not external content, so it is
  // answered outside the taint wrapper.
  const record = options.recordExternalContentIngestion;
  return withToolFamilyHelp(
    record === undefined
      ? tools
      : taintAppManagedToolResults({
          tools,
          threadId: options.thread.id,
          recordExternalContentIngestion: record,
          uuid: options.uuid,
        }),
    CODE_TOOL_HELP,
  );
}

async function plannerBoardTool(
  options: CodeAppManagedToolsOptions,
  input: { readonly operation: "read" } | undefined,
) {
  if (input === undefined || options.planner === undefined) return failure("invalid-board-input");
  let outcome: Awaited<ReturnType<CodePlannerToolPort["board"]>>;
  try {
    outcome = await options.planner.board(options.windowId, options.thread.id);
  } catch {
    return failure("planner-unavailable");
  }
  if (outcome.status === "refused") return failure(outcome.reason, outcome.message);
  const cards = outcome.board.cards.slice(0, MAX_BOARD_TOOL_CARDS);
  return {
    result: {
      generatedAt: String(outcome.board.generatedAt),
      cards: cards.map((card) => ({
        threadId: String(card.threadId),
        title: card.title,
        status: card.status,
        statusReason: card.statusReason,
        outcomeKind: card.outcomeKind,
        deliverySatisfaction: card.deliverySatisfaction,
        executing: card.executing,
        changedFiles: card.changedFiles,
        linkedPullRequest: card.linkedPullRequest,
        checks: card.checks,
        reviewState: card.reviewState,
        childAgents: card.childAgents,
        planProgress: card.planProgress,
        followUp: card.followUp,
        ...(card.blockingReason === undefined ? {} : { blockingReason: card.blockingReason }),
        lastMeaningfulActivityAt: card.lastMeaningfulActivityAt,
      })),
      ...(outcome.board.cards.length > cards.length ? { truncated: true } : {}),
    },
    isError: false,
  };
}

async function plannerProposeTool(
  options: CodeAppManagedToolsOptions,
  input: ProposeThreadToolInput | undefined,
) {
  if (input === undefined || options.planner === undefined) {
    return failure("invalid-proposal-input");
  }
  let outcome: Awaited<ReturnType<CodePlannerToolPort["propose"]>>;
  try {
    outcome = await options.planner.propose(options.windowId, options.thread.id, input);
  } catch {
    return failure("planner-unavailable");
  }
  if (outcome.status === "refused") return failure(outcome.reason, outcome.message);
  return {
    result: {
      status: "pending-user-confirmation",
      proposalId: String(outcome.proposal.id),
      title: outcome.proposal.title,
      // The proposal executes nothing; only the user's explicit confirmation
      // creates the thread, through the ordinary creation command.
      note: "Proposed. The user decides whether this thread is created.",
    },
    isError: false,
  };
}

export type PullRequestToolCommand = Extract<
  CodeOperationCommand,
  {
    readonly kind:
      | "create-pull-request"
      | "update-pull-request"
      | "comment-pull-request"
      | "merge-pull-request";
  }
>;

type PullRequestToolInput =
  | {
      readonly operation: "create";
      readonly title: string;
      readonly body: string;
      readonly draft?: boolean;
      readonly base?: string;
    }
  | {
      readonly operation: "update";
      readonly title?: string;
      readonly body?: string;
      readonly draft?: boolean;
      readonly addLabels?: ReadonlyArray<string>;
      readonly removeLabels?: ReadonlyArray<string>;
      readonly state?: "closed" | "open";
    }
  | {
      readonly operation: "comment";
      readonly body: string;
      readonly reviewThreadId?: string;
    }
  | {
      readonly operation: "merge";
      readonly method: "merge" | "squash" | "rebase";
      readonly headSha: string;
    };

/**
 * Opens or changes the pull request of this thread's own delivery branch.
 *
 * The head is never the agent's to choose: the host resolves it from the
 * thread's delivery target. Plan refuses; an approval-gated posture asks the
 * person in the thread and sends the host's one-use approval for exactly this
 * command; Full access runs it as the person's standing choice. The operation
 * service checks that authority again before `gh` runs and journals the
 * result on the thread.
 */
async function pullRequestTool(
  options: CodeAppManagedToolsOptions,
  input: PullRequestToolInput | undefined,
  signal?: AbortSignal,
) {
  if (input === undefined || options.pullRequestApproval === undefined) {
    return failure("invalid-pull-request-input");
  }
  const posture = currentPosture(options);
  if (posture === "plan") return failure("plan-mode-read-only", postureRefusal("plan"));
  const scope = {
    operationId: operationId(options),
    threadId: options.thread.id,
    checkoutId: options.thread.checkoutId,
  };
  // The approval binds the command without its authorization (see
  // `approvalEffectDigest`), so the stand-in below is replaced, never sent.
  const unauthorized: PullRequestToolCommand =
    input.operation === "create"
      ? {
          kind: "create-pull-request",
          ...scope,
          title: input.title,
          body: input.body,
          ...(input.draft === undefined ? {} : { draft: input.draft }),
          ...(input.base === undefined ? {} : { baseBranch: input.base }),
          idempotencyKey: String(scope.operationId),
          authorization: { kind: "full-access" },
        }
      : input.operation === "comment"
        ? {
            kind: "comment-pull-request",
            ...scope,
            body: input.body,
            ...(input.reviewThreadId === undefined ? {} : { reviewThreadId: input.reviewThreadId }),
            authorization: { kind: "full-access" },
          }
        : input.operation === "merge"
          ? {
              kind: "merge-pull-request",
              ...scope,
              method: input.method,
              headSha: input.headSha,
              authorization: { kind: "full-access" },
            }
          : {
              kind: "update-pull-request",
              ...scope,
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.body === undefined ? {} : { body: input.body }),
              ...(input.draft === undefined ? {} : { draft: input.draft }),
              ...(input.addLabels === undefined ? {} : { addLabels: input.addLabels }),
              ...(input.removeLabels === undefined ? {} : { removeLabels: input.removeLabels }),
              ...(input.state === undefined ? {} : { state: input.state }),
              authorization: { kind: "full-access" },
            };
  let command = unauthorized;
  // A merge the person stored a choice for (the Project's setting, or the
  // routine that started this thread) goes ahead without asking; everything
  // else, and a merge with no such choice, asks.
  const standing = input.operation === "merge" ? options.standingMerge?.() : undefined;
  if (standing !== undefined && unauthorized.kind === "merge-pull-request") {
    command = { ...unauthorized, authorization: { kind: "standing", allowedBy: standing } };
  }
  // A comment posts under the person's name and a merge cannot be taken back, so
  // both ask for this one act even at Full access.
  else if (
    decidesCodeEffectsByApproval(posture) ||
    pullRequestChangeNeedsPerActApproval(
      input.operation === "comment" || input.operation === "merge" ? input.operation : "labels",
    )
  ) {
    const outcome = await options.pullRequestApproval.request(unauthorized, signal);
    if (outcome.status !== "approved") {
      return failure(
        `pull-request-approval-${outcome.status}`,
        outcome.status === "denied"
          ? "The person declined this pull-request change. Nothing reached GitHub."
          : outcome.status === "too-large"
            ? "The title and body are too long to show whole in the approval, and an approval never covers text the person cannot read. Shorten them (about 1.5 KB together) and ask again. Nothing reached GitHub."
            : undefined,
      );
    }
    // The person answered while the thread could have moved on.
    const changed =
      currentThreadIdentityFailure(options) ??
      (currentPosture(options) === "plan" ? "plan-mode-read-only" : undefined);
    if (changed !== undefined) return failure(changed);
    if (signal?.aborted === true) return failure("tool-interrupted");
    command = {
      ...unauthorized,
      authorization: { kind: "approved", approvalId: outcome.approvalId },
    };
  }
  const result = await options.executeOperation(options.windowId, command);
  if (result.kind === "operation-failed") {
    return failure(result.failure.category, result.failure.message);
  }
  if (result.kind !== "pull-request-state") return failure("pull-request-unavailable");
  if (!("number" in result)) {
    return failure(
      result.failureCode === undefined
        ? "pull-request-unavailable"
        : `pull-request-${result.failureCode}`,
      pullRequestRefusal(result.failureCode),
    );
  }
  return {
    result: {
      status:
        input.operation === "update"
          ? "updated"
          : input.operation === "comment"
            ? "commented"
            : input.operation === "merge"
              ? "merged"
              : result.state === "created"
                ? "created"
                : "already-open",
      number: result.number,
      url: result.url,
      baseBranch: result.baseBranch,
      headBranch: result.headBranch,
      ...(result.draft === undefined ? {} : { draft: result.draft }),
      ...(input.operation === "create" && result.state !== "created"
        ? { note: "This branch already had an open pull request; nothing new was created." }
        : {}),
    },
    isError: false,
  };
}

function pullRequestRefusal(code: string | undefined): string {
  switch (code) {
    case "invalid-base":
      return "That base has no open pull request in this repository, so a stacked pull request cannot sit on it. Name an open branch, or leave base out.";
    case "not-found":
      return "This thread's branch has no open pull request to change. Create one first.";
    case "no-remote":
      return "This checkout has no GitHub remote.";
    case "invalid":
      return "GitHub refused that input. Check the text, labels, and review thread id.";
    case "label-not-found":
      return "The repository has no such label, and this tool does not create labels.";
    case "not-open":
      return "That pull request is not open.";
    case "not-closed":
      return "That pull request is not closed, or it was merged and cannot be reopened.";
    case "already-merged":
      return "That pull request is already merged.";
    case "sha-mismatch":
      return "The pull request's head moved since the person saw it. Read it again and ask again.";
    case "checks-not-passing":
      return "The repository's required checks have not all passed, so nothing was merged.";
    case "checks-unknown":
      return "The required checks could not be read, so nothing was merged.";
    case "not-mergeable":
      return "GitHub says the pull request is not mergeable right now, so nothing was merged.";
    default:
      return "GitHub could not be reached or refused the change. Check that the branch is pushed and GitHub access is signed in.";
  }
}

async function terminalTool(
  options: CodeAppManagedToolsOptions,
  input: TerminalToolInput | undefined,
  signal?: AbortSignal,
) {
  if (input === undefined) return failure("invalid-terminal-input");
  const terminalId = options.thread.id as unknown as CodeTerminalId;
  const scope = {
    threadId: options.thread.id,
    checkoutId: options.thread.checkoutId,
    terminalId,
  } as const;
  if (input.operation === "stop") {
    const stopped = await options.executeOperation(options.windowId, {
      kind: "stop-terminal",
      operationId: operationId(options),
      ...scope,
    });
    return operationResult(stopped, options, scope);
  }

  let snapshot: CodeOperationTerminalSnapshot | undefined;
  try {
    snapshot = await options.terminal.read(options.windowId, scope);
  } catch {
    // A missing terminal is an ordinary first-run state. Starting it remains a
    // server-authorized operation, while reads never replace a UI observer.
  }
  // Below Full access each command the agent types asks the person first,
  // naming it, as a provider's own shell asks per command at that level. A
  // terminal the agent starts is covered by the same answer.
  const startCommand: CodeOperationCommand | undefined =
    input.operation === "run" && snapshot?.status !== "running"
      ? {
          kind: "start-terminal",
          operationId: operationId(options),
          ...scope,
          columns: 100,
          rows: 30,
          credentialRefs: [],
        }
      : undefined;
  if (
    (input.operation === "run" || input.operation === "write") &&
    input.command !== undefined &&
    currentPosture(options) !== "full-access"
  ) {
    if (options.terminalApproval === undefined) return failure("terminal-approval-required");
    const outcome = await options.terminalApproval.request(
      { text: input.command, ...(startCommand === undefined ? {} : { start: startCommand }) },
      signal,
    );
    if (outcome !== "approved") return failure(`terminal-approval-${outcome}`);
    const changed = terminalAuthorityFailure(options);
    if (changed !== undefined) return failure(changed, postureRefusal(changed));
    if (signal?.aborted === true) return failure("tool-interrupted");
  }
  if (startCommand !== undefined) {
    const started = await options.executeOperation(options.windowId, startCommand);
    if (started.kind !== "terminal-state" || started.state !== "running") {
      return operationResult(started, options, scope);
    }
    snapshot = await options.terminal.read(options.windowId, scope);
  }
  if (snapshot === undefined) return failure("terminal-unavailable");
  if (snapshot.status !== "running") {
    return terminalSnapshot(snapshot);
  }
  if (input.operation === "run" || input.operation === "write") {
    if (signal?.aborted) return failure("tool-interrupted");
    const command = input.command;
    if (command === undefined) return failure("terminal-command-required");
    const marker =
      input.operation === "run" ? `oo${options.uuid().replaceAll("-", "")}` : undefined;
    const data =
      marker === undefined
        ? command
        : `${command}\rprintf '\\033]777;octant=${marker};exit=%s\\007' "$?"\r`;
    const written = await options.executeOperation(options.windowId, {
      kind: "write-terminal",
      operationId: operationId(options),
      ...scope,
      data,
    });
    if (written.kind === "operation-failed") return operationResult(written, options, scope);
    if (marker !== undefined) {
      return waitForTerminalCommand(options, scope, marker, signal);
    }
    await (options.wait ?? defaultWait)(200);
  }
  return terminalSnapshot(await options.terminal.read(options.windowId, scope));
}

async function waitForTerminalCommand(
  options: CodeAppManagedToolsOptions,
  scope: {
    readonly threadId: CodeThread["id"];
    readonly checkoutId: CodeThread["checkoutId"];
    readonly terminalId: CodeTerminalId;
  },
  marker: string,
  signal?: AbortSignal,
) {
  const deadline = Date.now() + TERMINAL_COMMAND_TIMEOUT_MS;
  const completion = new RegExp(`\\u001b\\]777;octant=${marker};exit=(\\d+)\\u0007`, "g");
  for (;;) {
    const authorityFailure = terminalAuthorityFailure(options);
    if (signal?.aborted || authorityFailure !== undefined) {
      await interruptTerminalCommand(options, scope, marker);
      return signal?.aborted
        ? failure("tool-interrupted")
        : failure(authorityFailure!, postureRefusal(authorityFailure!));
    }
    await (options.wait ?? defaultWait)(TERMINAL_COMPLETION_POLL_MS);
    const postWaitAuthorityFailure = terminalAuthorityFailure(options);
    if (signal?.aborted || postWaitAuthorityFailure !== undefined) {
      await interruptTerminalCommand(options, scope, marker);
      return signal?.aborted
        ? failure("tool-interrupted")
        : failure(postWaitAuthorityFailure!, postureRefusal(postWaitAuthorityFailure!));
    }
    const snapshot = await options.terminal.read(options.windowId, scope);
    const transcript = terminalTranscriptTail(snapshot, MAX_TERMINAL_SCAN_BYTES).value;
    const matches = [...transcript.matchAll(completion)];
    const exitCode = matches.at(-1)?.[1];
    if (exitCode !== undefined) {
      return terminalSnapshot(
        {
          ...snapshot,
          transcript: {
            ...snapshot.transcript,
            chunks: [transcript.replace(completion, "")],
          },
        },
        { commandCompleted: true, commandExitCode: Number(exitCode) },
      );
    }
    if (snapshot.status !== "running") {
      return terminalSnapshot(snapshot, { commandCompleted: false });
    }
    if (Date.now() >= deadline) {
      await interruptTerminalCommand(options, scope, marker);
      const partial = terminalSnapshot(snapshot, { commandCompleted: false });
      return {
        result: { ...partial.result, error: "terminal-command-timeout" },
        isError: true,
      };
    }
  }
}

async function interruptTerminalCommand(
  options: CodeAppManagedToolsOptions,
  scope: {
    readonly threadId: CodeThread["id"];
    readonly checkoutId: CodeThread["checkoutId"];
    readonly terminalId: CodeTerminalId;
  },
  marker: string,
): Promise<void> {
  try {
    if (options.terminal.interrupt === undefined) return;
    let snapshot = await options.terminal.interrupt(options.windowId, scope);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (snapshot.status !== "running" || terminalHasCompletionMarker(snapshot, marker)) return;
      await (options.wait ?? defaultWait)(TERMINAL_COMPLETION_POLL_MS);
      snapshot = await options.terminal.read(options.windowId, scope);
    }
    await options.terminal.terminate?.(options.windowId, scope);
  } catch {
    try {
      await options.terminal.terminate?.(options.windowId, scope);
    } catch {
      // The terminal may already have exited. No further provider result is accepted.
    }
  }
}

function terminalHasCompletionMarker(
  snapshot: CodeOperationTerminalSnapshot,
  marker: string,
): boolean {
  return terminalTranscriptTail(snapshot, MAX_TERMINAL_SCAN_BYTES).value.includes(
    `\u001b]777;octant=${marker};exit=`,
  );
}

async function browserTool(
  options: CodeAppManagedToolsOptions,
  input: BrowserToolInput | undefined,
  signal?: AbortSignal,
) {
  if (input === undefined || options.browser === undefined) return failure("invalid-browser-input");
  const threadId = options.thread.id as unknown as BrowserThreadId;
  const authority = options.browser.resolveAuthority(threadId, "code");
  if (authority === undefined) return failure("browser-authority-unavailable");
  if (input.operation === "stop") {
    const context = options.browser.inspectThread(options.windowId, threadId).context;
    if (context !== undefined) options.browserApproval?.forget(String(context.contextId));
    const released = await options.browser.releaseThread(options.windowId, threadId);
    return browserToolResult(released);
  }
  const postureFailure = browserAuthorityFailure(options);
  if (postureFailure !== undefined) return failure(postureFailure);
  let snapshot = options.browser.inspectThread(options.windowId, threadId);
  const existing = snapshot.context?.state === "active" ? snapshot.context : undefined;
  if (existing === undefined && snapshot.context !== undefined) {
    options.browserApproval?.forget(String(snapshot.context.contextId));
  }
  const origin =
    existing === undefined
      ? input.operation === "navigate"
        ? allowedOrigin(input.url)
        : undefined
      : existing.policy.allowedOrigins.join(", ");
  if (origin === undefined)
    return failure(
      input.operation === "navigate" ? "invalid-browser-url" : "browser-navigation-required",
    );
  const requiresApproval = currentAuthorityFailure(options) !== undefined;
  const remembered =
    existing === undefined &&
    options.browserApproval?.isOriginRemembered !== undefined &&
    options.browserApproval.isOriginRemembered(origin);
  if (
    requiresApproval &&
    (existing === undefined ||
      options.browserApproval?.isApproved(String(existing.contextId)) !== true) &&
    !remembered
  ) {
    if (options.browserApproval === undefined) return failure("browser-approval-required");
    const outcome = await options.browserApproval.request(origin, signal);
    if (outcome !== "approved") return failure(`browser-approval-${outcome}`);
    const changed = browserAuthorityFailure(options);
    if (changed !== undefined || signal?.aborted === true)
      return failure(changed ?? "tool-interrupted");
    if (existing !== undefined) options.browserApproval.remember(String(existing.contextId));
  }
  if (existing === undefined) {
    const action = actionRequest(options, authority);
    const created = await guardedBrowserEffect(options, threadId, signal, () =>
      options.browser!.create({
        windowId: options.windowId,
        threadId,
        action,
        policy: {
          profileMode: "isolated",
          allowedOrigins: [origin],
          credentialFieldProtection: true,
          maxConcurrentTabs: MAX_BROWSER_TABS_PER_CONTEXT,
          sessionTimeoutMs: 600_000,
        },
      }),
    );
    if (created.kind === "failure") return failure(created.reason);
    snapshot = created.snapshot;
    if (requiresApproval && snapshot.context?.state === "active") {
      options.browserApproval?.remember(String(snapshot.context.contextId));
    }
  }
  const context = snapshot.context;
  if (context === undefined || context.state !== "active") return browserToolResult(snapshot);
  if (signal?.aborted) return failure("tool-interrupted");
  const request = browserToolAction(input, context);
  if (request === undefined) return failure("invalid-browser-input");
  const acted = await guardedBrowserEffect(options, threadId, signal, () =>
    options.browser!.act({ windowId: options.windowId, request, capturedBy: "agent" }),
  );
  if (acted.kind === "failure") return failure(acted.reason);
  if (
    input.operation === "screenshot" &&
    browserToolImage(acted.snapshot.observation?.screenshotDataUrl) === undefined
  ) {
    return failure("browser-screenshot-unavailable");
  }
  return browserToolResult(acted.snapshot, browserToolWantsScreenshot(input));
}

/**
 * The Apple capability, driven by the thread's own agent.
 *
 * Every request carries the thread and checkout the tool is bound to, and the
 * host decides. Reading the toolchain, the runtime, or the Simulator's screen
 * is not an effect and stays available wherever the tool itself is, Plan mode
 * included, as is showing the pane of a Simulator already running. Every other
 * operation is an effect and passes
 * `deviceEffectApproval` first, before the pane opens or the host is asked.
 */
async function appleTool(
  options: CodeAppManagedToolsOptions,
  input: AppleToolInput | undefined,
  signal?: AbortSignal,
) {
  const apple = options.apple;
  if (input === undefined || apple === undefined) return failure("invalid-apple-input");
  const authority = apple.resolveAuthority(options.windowId, options.thread);
  if (authority === undefined) return failure("apple-authority-unavailable");
  const scope = {
    authority,
    threadId: options.thread.id,
    checkoutId: options.thread.checkoutId,
  } as const;

  if (input.operation === "status") {
    const snapshot = await apple.snapshot(options.windowId, scope);
    if (snapshot === undefined) return failure("apple-unavailable");
    return {
      result: {
        simulators: snapshot.simulators.map((simulator) => ({
          simulatorId: String(simulator.simulatorId),
          name: simulator.name,
          platform: simulator.platform,
          runtimeVersion: simulator.runtimeVersion,
          state: simulator.state,
        })),
        running: snapshot.active.map((progress) => ({
          actionId: String(progress.actionId),
          kind: progress.kind,
          step: progress.step,
        })),
      },
      isError: false,
    };
  }

  if (input.operation === "discover") {
    if (input.projectPath === undefined) return failure("apple-project-path-required");
    const discovered = await apple.discover(options.windowId, {
      ...scope,
      actionId: options.uuid() as AppleDiscoveryRequest["actionId"],
      correlationId: options.uuid() as AppleDiscoveryRequest["correlationId"],
      projectPath: input.projectPath as AppleDiscoveryRequest["projectPath"],
    });
    if (discovered === undefined) return failure("apple-unavailable");
    if (discovered.kind === "failure") {
      return failure(discovered.failure.category, discovered.failure.message);
    }
    return {
      result: {
        xcodeVersion: discovered.toolchain.xcodeVersion ?? "unavailable",
        schemes: discovered.workspace.schemes,
        configurations: discovered.workspace.configurations,
        simulators: discovered.simulators.map((simulator) => ({
          simulatorId: String(simulator.simulatorId),
          name: simulator.name,
          platform: simulator.platform,
          state: simulator.state,
        })),
      },
      isError: false,
    };
  }

  if (input.operation === "open") {
    if (input.simulatorId === undefined) return failure("invalid-apple-input");
    const snapshot = await apple.snapshot(options.windowId, scope);
    if (snapshot === undefined) return failure("apple-unavailable");
    const destination = snapshot.simulators.find(
      (simulator) => String(simulator.simulatorId) === input.simulatorId,
    );
    if (destination === undefined) {
      return failure(
        "simulator-not-found",
        "No Simulator with that identity is available on this thread.",
      );
    }
    if (destination.state === "unavailable") {
      return failure("unavailable", "That Simulator destination is unavailable.");
    }
    // Showing a destination that is already running changes nothing on it, so
    // it is a read under every posture and has no host action an approval
    // could bind to. Only opening a shut-down one boots, and that is gated below.
    if (destination.state === "booted" || destination.state === "booting") {
      await apple.requestPaneOpen(options.windowId, scope, destination.simulatorId);
      return {
        result: inAppPaneResult({
          kind: "open",
          outcome: "succeeded",
          simulatorId: String(destination.simulatorId),
          state: destination.state,
        }),
        isError: false,
      };
    }
    const request = appleActionRequest({ ...input, operation: "boot" }, scope, options.uuid);
    if (request === undefined) return failure("invalid-apple-input");
    if (signal?.aborted) return failure("tool-interrupted");
    const decision = await deviceEffectApproval(
      options,
      { kind: "apple-action", request },
      () => false,
      signal,
    );
    if (decision.kind === "refused") return failure(decision.reason, decision.message);
    await apple.requestPaneOpen(options.windowId, scope, destination.simulatorId);
    const evidence = await apple.execute(options.windowId, {
      ...request,
      approval: decision.approval,
    });
    if (evidence === undefined) return failure("apple-unavailable");
    return appleEvidenceResult(evidence, true);
  }

  if (signal?.aborted) return failure("tool-interrupted");
  const prepared = appleActionRequest(input, scope, options.uuid);
  if (prepared === undefined) return failure("invalid-apple-input");
  let request = prepared;
  if (!isDeviceRead(input.operation)) {
    const decision = await deviceEffectApproval(
      options,
      { kind: "apple-action", request: prepared },
      () =>
        isAppleSimulatorInputKind(prepared.kind) &&
        "simulatorId" in prepared &&
        prepared.simulatorId !== undefined &&
        apple.inputGrantIsOpen(options.windowId, options.thread.id, prepared.simulatorId),
      signal,
    );
    if (decision.kind === "refused") return failure(decision.reason, decision.message);
    request = { ...prepared, approval: decision.approval };
  }
  const opensPane =
    (input.operation === "boot" || input.operation === "run") && input.simulatorId !== undefined;
  if (opensPane && input.simulatorId !== undefined) {
    const simulatorId = decodeToolSimulatorId(input.simulatorId);
    if (simulatorId !== undefined) {
      await apple.requestPaneOpen(options.windowId, scope, simulatorId);
    }
  }
  const evidence = await apple.execute(options.windowId, request);
  if (evidence === undefined) return failure("apple-unavailable");
  const result = appleEvidenceResult(evidence, opensPane);
  if (input.operation !== "screenshot" || evidence.outcome !== "succeeded") return result;
  if (signal?.aborted) return failure("tool-interrupted");
  const reference = evidence.artifacts.find(
    (artifact) => artifact.kind === "screenshot",
  )?.reference;
  const bytes =
    reference === undefined
      ? undefined
      : await apple.readScreenshot(options.windowId, scope, reference);
  if (signal?.aborted) return failure("tool-interrupted");
  return deviceScreenshotResult(result, bytes);
}

const ANDROID_BOOT_TIMEOUT_MS = 180_000;
const ANDROID_ACTION_TIMEOUT_MS = 60_000;
const IN_APP_ANDROID_PANE_NOTE =
  "The emulator is showing in Octant's Android emulator pane. Do not start an external emulator window as the place to look.";

async function androidTool(
  options: CodeAppManagedToolsOptions,
  input: AndroidToolInput | undefined,
  signal?: AbortSignal,
) {
  const android = options.android;
  if (input === undefined || android === undefined) return failure("invalid-android-input");
  const authority = android.resolveAuthority(options.windowId, options.thread);
  if (authority === undefined) return failure("android-authority-unavailable");
  const scope = {
    authority,
    threadId: options.thread.id,
    checkoutId: options.thread.checkoutId,
  } as const;

  if (input.operation === "status") {
    const snapshot = await android.snapshot(options.windowId, scope);
    if (snapshot === undefined) return failure("android-unavailable");
    return {
      result: {
        sdkAvailable: snapshot.sdk.available,
        emulators: snapshot.emulators.map((emulator) => ({
          emulatorId: String(emulator.emulatorId),
          name: emulator.name,
          state: emulator.state,
          ...(emulator.serial === undefined ? {} : { serial: emulator.serial }),
        })),
        running: snapshot.active.map((progress) => ({
          actionId: String(progress.actionId),
          kind: progress.kind,
          step: progress.step,
        })),
      },
      isError: false,
    };
  }

  if (input.operation === "discover") {
    const discovered = await android.discover(options.windowId, {
      ...scope,
      actionId: options.uuid() as AndroidDiscoveryRequest["actionId"],
      correlationId: options.uuid() as AndroidDiscoveryRequest["correlationId"],
    });
    if (discovered === undefined) return failure("android-unavailable");
    if (discovered.kind === "failure") {
      return failure(discovered.failure.category, discovered.failure.message);
    }
    return {
      result: {
        sdkAvailable: discovered.sdk.available,
        emulators: discovered.emulators.map((emulator) => ({
          emulatorId: String(emulator.emulatorId),
          name: emulator.name,
          state: emulator.state,
        })),
      },
      isError: false,
    };
  }

  if (input.operation === "open") {
    if (input.emulatorId === undefined) return failure("invalid-android-input");
    const snapshot = await android.snapshot(options.windowId, scope);
    if (snapshot === undefined) return failure("android-unavailable");
    const destination = snapshot.emulators.find(
      (emulator) => String(emulator.emulatorId) === input.emulatorId,
    );
    if (destination === undefined) {
      return failure(
        "emulator-not-found",
        "No Android emulator with that identity is available on this thread.",
      );
    }
    if (destination.state === "unavailable") {
      return failure("unavailable", "That Android emulator destination is unavailable.");
    }
    if (destination.state === "booted" || destination.state === "booting") {
      await android.requestPaneOpen(options.windowId, scope, destination.emulatorId);
      return {
        result: inAppAndroidPaneResult({
          kind: "open",
          outcome: "succeeded",
          emulatorId: String(destination.emulatorId),
          state: destination.state,
        }),
        isError: false,
      };
    }
    const request = androidActionRequest({ ...input, operation: "boot" }, scope, options.uuid);
    if (request === undefined) return failure("invalid-android-input");
    if (signal?.aborted) return failure("tool-interrupted");
    const decision = await deviceEffectApproval(
      options,
      { kind: "android-action", request },
      () => false,
      signal,
    );
    if (decision.kind === "refused") return failure(decision.reason, decision.message);
    await android.requestPaneOpen(options.windowId, scope, destination.emulatorId);
    const evidence = await android.execute(options.windowId, {
      ...request,
      approval: decision.approval,
    });
    if (evidence === undefined) return failure("android-unavailable");
    return androidEvidenceResult(evidence, true);
  }

  if (signal?.aborted) return failure("tool-interrupted");
  const prepared = androidActionRequest(input, scope, options.uuid);
  if (prepared === undefined) return failure("invalid-android-input");
  let request = prepared;
  if (!isDeviceRead(input.operation)) {
    const decision = await deviceEffectApproval(
      options,
      { kind: "android-action", request: prepared },
      () =>
        isAndroidEmulatorInputKind(prepared.kind) &&
        android.inputGrantIsOpen(options.windowId, options.thread.id, prepared.emulatorId),
      signal,
    );
    if (decision.kind === "refused") return failure(decision.reason, decision.message);
    request = { ...prepared, approval: decision.approval };
  }
  const opensPane =
    (input.operation === "boot" || input.operation === "install" || input.operation === "launch") &&
    input.emulatorId !== undefined;
  if (opensPane && input.emulatorId !== undefined) {
    const emulatorId = decodeToolEmulatorId(input.emulatorId);
    if (emulatorId !== undefined) {
      await android.requestPaneOpen(options.windowId, scope, emulatorId);
    }
  }
  const evidence = await android.execute(options.windowId, request);
  if (evidence === undefined) return failure("android-unavailable");
  const result = androidEvidenceResult(evidence, opensPane);
  if (input.operation !== "screenshot" || evidence.outcome !== "succeeded") return result;
  if (signal?.aborted) return failure("tool-interrupted");
  const reference = evidence.artifacts.find(
    (artifact) => artifact.kind === "screenshot",
  )?.reference;
  const bytes =
    reference === undefined
      ? undefined
      : await android.readScreenshot(options.windowId, scope, reference);
  if (signal?.aborted) return failure("tool-interrupted");
  return deviceScreenshotResult(result, bytes);
}

function inAppAndroidPaneResult<T extends Record<string, unknown>>(
  result: T,
): T & { readonly opensInAppPane: true; readonly pane: string } {
  return { ...result, opensInAppPane: true, pane: IN_APP_ANDROID_PANE_NOTE };
}

function androidEvidenceResult(evidence: AndroidEmulatorEvidence, opensPane: boolean) {
  const result = {
    kind: evidence.kind,
    outcome: evidence.outcome,
    cleanup: evidence.cleanup,
    durationMs: evidence.durationMs,
    diagnostics: evidence.diagnostics.slice(0, MAX_APPLE_RESULT_DIAGNOSTICS).map((diagnostic) => ({
      severity: diagnostic.severity,
      message: diagnostic.message,
    })),
    artifacts: evidence.artifacts.map((artifact) => ({
      kind: artifact.kind,
      reference: artifact.reference,
    })),
  };
  return {
    result: opensPane && evidence.outcome === "succeeded" ? inAppAndroidPaneResult(result) : result,
    isError: evidence.outcome !== "succeeded",
  };
}

function decodeToolEmulatorId(value: string): AndroidEmulatorId | undefined {
  try {
    return decodeAndroidEmulatorId(value);
  } catch {
    return undefined;
  }
}

function androidActionRequest(
  input: AndroidToolInput,
  scope: {
    readonly authority: ToolActionAuthority;
    readonly threadId: CodeThread["id"];
    readonly checkoutId: CodeThread["checkoutId"];
  },
  uuid: () => string,
): AndroidEmulatorRequest | undefined {
  if (input.emulatorId === undefined) return undefined;
  const emulatorId = decodeToolEmulatorId(input.emulatorId);
  if (emulatorId === undefined) return undefined;
  const base = {
    ...scope,
    actionId: uuid() as AndroidEmulatorRequest["actionId"],
    correlationId: uuid() as AndroidEmulatorRequest["correlationId"],
    approval: { kind: "not-required" as const },
    emulatorId,
  };
  switch (input.operation) {
    case "boot":
    case "shutdown":
    case "screenshot":
      return {
        ...base,
        kind: input.operation,
        timeoutMs: input.operation === "boot" ? ANDROID_BOOT_TIMEOUT_MS : ANDROID_ACTION_TIMEOUT_MS,
      };
    case "install":
      if (input.apkPath === undefined) return undefined;
      return {
        ...base,
        kind: "install",
        apkPath: input.apkPath as AndroidEmulatorRequest["apkPath"],
        timeoutMs: ANDROID_ACTION_TIMEOUT_MS,
      };
    case "launch":
      if (input.packageName === undefined) return undefined;
      return {
        ...base,
        kind: "launch",
        packageName: input.packageName as AndroidEmulatorRequest["packageName"],
        timeoutMs: ANDROID_ACTION_TIMEOUT_MS,
      };
    case "tap":
    case "swipe":
    case "type-text":
    case "key-press": {
      const requestedBy = agentEventActor(scope.authority, scope.threadId, uuid);
      if (input.operation === "swipe") {
        if (
          input.x === undefined ||
          input.y === undefined ||
          input.toX === undefined ||
          input.toY === undefined
        ) {
          return undefined;
        }
        const durationMs =
          input.durationMs === undefined ? undefined : Math.round(input.durationMs);
        if (durationMs !== undefined && !(durationMs >= 50 && durationMs <= 5_000)) {
          return undefined;
        }
        return {
          ...base,
          kind: "swipe",
          requestedBy,
          point: { x: input.x, y: input.y },
          toPoint: { x: input.toX, y: input.toY },
          ...(durationMs === undefined ? {} : { durationMs }),
          timeoutMs: ANDROID_ACTION_TIMEOUT_MS,
        };
      }
      if (input.operation === "tap") {
        if (input.x === undefined || input.y === undefined) return undefined;
        return {
          ...base,
          kind: "tap",
          requestedBy,
          point: { x: input.x, y: input.y },
          timeoutMs: ANDROID_ACTION_TIMEOUT_MS,
        };
      }
      if (input.operation === "type-text") {
        if (input.text === undefined || input.text.trim().length === 0) return undefined;
        return {
          ...base,
          kind: "type-text",
          requestedBy,
          text: input.text,
          timeoutMs: ANDROID_ACTION_TIMEOUT_MS,
        };
      }
      if (input.key === undefined) return undefined;
      return {
        ...base,
        kind: "key-press",
        requestedBy,
        key: input.key,
        timeoutMs: ANDROID_ACTION_TIMEOUT_MS,
      };
    }
    default:
      return undefined;
  }
}

const IN_APP_PANE_NOTE =
  "The Simulator is showing in Octant's iOS Simulator pane. Do not launch Simulator.app, run open -a Simulator, or start serve-sim.";

function inAppPaneResult<T extends Record<string, unknown>>(
  result: T,
): T & { readonly opensInAppPane: true; readonly pane: string } {
  return { ...result, opensInAppPane: true, pane: IN_APP_PANE_NOTE };
}

function appleEvidenceResult(evidence: AppleBuildEvidence, opensPane: boolean) {
  const result = {
    kind: evidence.kind,
    outcome: evidence.outcome,
    cleanup: evidence.cleanup,
    durationMs: evidence.durationMs,
    diagnostics: evidence.diagnostics.slice(0, MAX_APPLE_RESULT_DIAGNOSTICS).map((diagnostic) => ({
      severity: diagnostic.severity,
      message: diagnostic.message,
      ...(diagnostic.location === undefined ? {} : { location: diagnostic.location }),
    })),
    // Durable evidence keeps references; explicit screenshot calls attach
    // bytes separately through the provider image channel.
    artifacts: evidence.artifacts.map((artifact) => ({
      kind: artifact.kind,
      reference: artifact.reference,
    })),
  };
  return {
    result: opensPane && evidence.outcome === "succeeded" ? inAppPaneResult(result) : result,
    isError: evidence.outcome !== "succeeded",
  };
}

function decodeToolSimulatorId(value: string): AppleSimulatorId | undefined {
  try {
    return decodeAppleSimulatorId(value);
  } catch {
    return undefined;
  }
}

function appleActionRequest(
  input: AppleToolInput,
  scope: {
    readonly authority: ToolActionAuthority;
    readonly threadId: CodeThread["id"];
    readonly checkoutId: CodeThread["checkoutId"];
  },
  uuid: () => string,
): AppleActionRequest | undefined {
  const base = {
    ...scope,
    actionId: uuid() as AppleActionRequest["actionId"],
    correlationId: uuid() as AppleActionRequest["correlationId"],
    approval: { kind: "not-required" as const },
  };
  switch (input.operation) {
    case "build":
    case "test":
    case "run": {
      if (input.projectPath === undefined) return undefined;
      if (input.operation === "run" && input.simulatorId === undefined) return undefined;
      return {
        ...base,
        kind: input.operation,
        platform: (input.platform ?? "ios") as ApplePlatform,
        ...(input.scheme === undefined ? {} : { scheme: input.scheme }),
        ...(input.simulatorId === undefined ? {} : { simulatorId: input.simulatorId as never }),
        projectPath: input.projectPath as never,
        timeoutMs: APPLE_BUILD_TIMEOUT_MS,
      } as AppleActionRequest;
    }
    case "boot":
    case "shutdown":
    case "screenshot": {
      if (input.simulatorId === undefined) return undefined;
      return {
        ...base,
        kind: input.operation,
        simulatorId: input.simulatorId as never,
        timeoutMs: input.operation === "boot" ? APPLE_BOOT_TIMEOUT_MS : APPLE_SIMULATOR_TIMEOUT_MS,
      } as AppleActionRequest;
    }
    case "tap":
    case "swipe":
    case "type-text":
    case "key-press": {
      if (input.simulatorId === undefined) return undefined;
      const requestedBy = agentEventActor(scope.authority, scope.threadId, uuid);
      if (input.operation === "swipe") {
        if (
          input.x === undefined ||
          input.y === undefined ||
          input.toX === undefined ||
          input.toY === undefined
        ) {
          return undefined;
        }
        const durationMs =
          input.durationMs === undefined ? undefined : Math.round(input.durationMs);
        // The contract's own range. Left to the desktop's decoder, a pace
        // outside it came back as the desktop being unreachable.
        if (durationMs !== undefined && !(durationMs >= 50 && durationMs <= 5_000)) {
          return undefined;
        }
        return {
          ...base,
          kind: "swipe",
          simulatorId: input.simulatorId as never,
          requestedBy,
          point: { x: input.x, y: input.y },
          toPoint: { x: input.toX, y: input.toY },
          ...(durationMs === undefined ? {} : { durationMs }),
          timeoutMs: APPLE_SIMULATOR_TIMEOUT_MS,
        } as AppleActionRequest;
      }
      if (input.operation === "tap") {
        if (input.target === undefined && (input.x === undefined || input.y === undefined)) {
          return undefined;
        }
        return {
          ...base,
          kind: "tap",
          simulatorId: input.simulatorId as never,
          requestedBy,
          ...(input.target === undefined ? {} : { target: input.target }),
          ...(input.x === undefined || input.y === undefined
            ? {}
            : { point: { x: input.x, y: input.y } }),
          timeoutMs: APPLE_SIMULATOR_TIMEOUT_MS,
        } as AppleActionRequest;
      }
      if (input.operation === "type-text") {
        if (input.text === undefined) return undefined;
        return {
          ...base,
          kind: "type-text",
          simulatorId: input.simulatorId as never,
          requestedBy,
          text: input.text,
          timeoutMs: APPLE_SIMULATOR_TIMEOUT_MS,
        } as AppleActionRequest;
      }
      if (input.key === undefined) return undefined;
      return {
        ...base,
        kind: "key-press",
        simulatorId: input.simulatorId as never,
        requestedBy,
        key: input.key,
        timeoutMs: APPLE_SIMULATOR_TIMEOUT_MS,
      } as AppleActionRequest;
    }
    default:
      return undefined;
  }
}

function agentEventActor(
  authority: ToolActionAuthority,
  threadId: CodeThread["id"],
  uuid: () => string,
): EventActor {
  return {
    kind: "agent",
    actorId: uuid() as never,
    providerInstanceId: authority.providerInstanceId as never,
    threadId: threadId as never,
  };
}

async function guardedBrowserEffect(
  options: CodeAppManagedToolsOptions,
  threadId: BrowserThreadId,
  signal: AbortSignal | undefined,
  effect: () => Promise<BrowserAutomationSnapshot>,
): Promise<
  | { readonly kind: "snapshot"; readonly snapshot: BrowserAutomationSnapshot }
  | { readonly kind: "failure"; readonly reason: string }
> {
  let settled = false;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<string>((resolve) => {
    onAbort = () => resolve("tool-interrupted");
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  const authorityChanged = (async () => {
    while (!settled) {
      await defaultWait(25);
      if (settled) break;
      const reason = browserAuthorityFailure(options);
      if (reason !== undefined) return reason;
    }
    return new Promise<string>(() => undefined);
  })();
  const pending = effect();
  try {
    const outcome = await Promise.race([
      pending.then((snapshot) => ({ kind: "snapshot" as const, snapshot })),
      interrupted.then((reason) => ({ kind: "failure" as const, reason })),
      authorityChanged.then((reason) => ({ kind: "failure" as const, reason })),
    ]);
    settled = true;
    if (outcome.kind === "snapshot") {
      const reason = browserAuthorityFailure(options);
      if (reason === undefined && signal?.aborted !== true) return outcome;
      await options.browser?.releaseThread(options.windowId, threadId);
      return { kind: "failure", reason: signal?.aborted === true ? "tool-interrupted" : reason! };
    }
    void pending.catch(() => undefined);
    await options.browser?.releaseThread(options.windowId, threadId);
    return outcome;
  } finally {
    settled = true;
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

function actionRequest(
  options: CodeAppManagedToolsOptions,
  authority: ToolActionAuthority,
): ToolActionRequest {
  return {
    actionId: options.uuid() as ToolActionRequest["actionId"],
    correlationId: options.uuid() as ToolActionRequest["correlationId"],
    capability: {
      id: "browser-automation" as ToolActionRequest["capability"]["id"],
      version: 1,
    },
    authority,
    intent: "Operate the thread-owned isolated browser for the active Code task.",
    approval: { kind: "not-required" },
  };
}

function operationId(options: CodeAppManagedToolsOptions) {
  return options.uuid() as CodeOperationCommand["operationId"];
}

async function operationResult(
  result: CodeOperationResult,
  options: CodeAppManagedToolsOptions,
  scope: {
    readonly threadId: CodeThread["id"];
    readonly checkoutId: CodeThread["checkoutId"];
    readonly terminalId: CodeTerminalId;
  },
) {
  if (result.kind === "operation-failed") {
    return failure(result.failure.category, result.failure.message);
  }
  if (result.kind !== "terminal-state") return failure("terminal-operation-failed");
  try {
    return terminalSnapshot(await options.terminal.read(options.windowId, scope));
  } catch {
    return {
      result: { status: result.state, transcript: "" },
      isError: result.state === "failed" || result.state === "unavailable",
    };
  }
}

function terminalSnapshot(
  snapshot: CodeOperationTerminalSnapshot,
  command?: { readonly commandCompleted: boolean; readonly commandExitCode?: number },
) {
  const transcript = terminalTranscriptTail(snapshot, MAX_TERMINAL_RESULT_BYTES);
  return {
    result: {
      status: snapshot.status,
      transcript: transcript.value,
      truncated: transcript.truncated,
      ...(snapshot.exitCode === undefined ? {} : { exitCode: snapshot.exitCode }),
      ...(command === undefined ? {} : command),
    },
    isError: false,
  };
}

type TerminalToolInput =
  | { readonly operation: "read" | "stop" }
  | { readonly operation: "run" | "write"; readonly command?: string };

interface AppleToolInput {
  readonly operation:
    | "discover"
    | "status"
    | "build"
    | "test"
    | "run"
    | "boot"
    | "open"
    | "shutdown"
    | "screenshot"
    | "tap"
    | "swipe"
    | "type-text"
    | "key-press";
  readonly projectPath?: string;
  readonly scheme?: string;
  readonly platform?: string;
  readonly simulatorId?: string;
  readonly bundleIdentifier?: string;
  readonly target?: string;
  readonly x?: number;
  readonly y?: number;
  readonly toX?: number;
  readonly toY?: number;
  readonly durationMs?: number;
  readonly text?: string;
  readonly key?: string;
}

interface AndroidToolInput {
  readonly operation:
    | "discover"
    | "status"
    | "open"
    | "boot"
    | "shutdown"
    | "screenshot"
    | "tap"
    | "swipe"
    | "type-text"
    | "key-press"
    | "install"
    | "launch";
  readonly emulatorId?: string;
  readonly x?: number;
  readonly y?: number;
  readonly toX?: number;
  readonly toY?: number;
  readonly durationMs?: number;
  readonly text?: string;
  readonly key?: string;
  readonly apkPath?: string;
  readonly packageName?: string;
}

interface ProposeThreadToolInput {
  readonly title: string;
  readonly intent: string;
  readonly rationale?: string;
}

function parseBoardInput(value: string): { readonly operation: "read" } | undefined {
  const parsed = parseObject(value, new Set(["operation"]));
  if (parsed === undefined || parsed.operation !== "read") return undefined;
  return { operation: "read" };
}

function parseProposeThreadInput(value: string): ProposeThreadToolInput | undefined {
  const parsed = parseObject(value, new Set(["title", "intent", "rationale"]));
  if (parsed === undefined) return undefined;
  if (typeof parsed.title !== "string" || typeof parsed.intent !== "string") return undefined;
  if (parsed.rationale !== undefined && typeof parsed.rationale !== "string") return undefined;
  return {
    title: parsed.title,
    intent: parsed.intent,
    ...(typeof parsed.rationale === "string" ? { rationale: parsed.rationale } : {}),
  };
}

function parsePullRequestInput(value: string): PullRequestToolInput | undefined {
  const parsed = parseObject(
    value,
    new Set([
      "operation",
      "title",
      "body",
      "draft",
      "base",
      "addLabels",
      "removeLabels",
      "state",
      "reviewThreadId",
      "method",
      "headSha",
    ]),
    MAX_PULL_REQUEST_TOOL_INPUT_BYTES,
  );
  if (parsed === undefined) return undefined;
  const {
    operation,
    title,
    body,
    draft,
    base,
    addLabels,
    removeLabels,
    state,
    reviewThreadId,
    method,
    headSha,
  } = parsed;
  if (title !== undefined && (typeof title !== "string" || title.trim().length === 0)) {
    return undefined;
  }
  if (body !== undefined && typeof body !== "string") return undefined;
  if (draft !== undefined && typeof draft !== "boolean") return undefined;
  if (base !== undefined && (typeof base !== "string" || base.trim().length === 0)) {
    return undefined;
  }
  const labels = (value: unknown): ReadonlyArray<string> | undefined | null =>
    value === undefined
      ? undefined
      : Array.isArray(value) && value.every((entry) => typeof entry === "string")
        ? (value as ReadonlyArray<string>)
        : null;
  const add = labels(addLabels);
  const remove = labels(removeLabels);
  if (add === null || remove === null) return undefined;
  if (state !== undefined && state !== "closed" && state !== "open") return undefined;
  if (operation === "create") {
    if (
      typeof title !== "string" ||
      add !== undefined ||
      remove !== undefined ||
      state !== undefined
    ) {
      return undefined;
    }
    return {
      operation,
      title,
      body: typeof body === "string" ? body : "",
      ...(typeof draft === "boolean" ? { draft } : {}),
      ...(typeof base === "string" ? { base } : {}),
    };
  }
  if (operation === "comment") {
    if (typeof body !== "string" || body.trim().length === 0) return undefined;
    if (reviewThreadId !== undefined && typeof reviewThreadId !== "string") return undefined;
    return {
      operation,
      body,
      ...(typeof reviewThreadId === "string" ? { reviewThreadId } : {}),
    };
  }
  if (operation === "merge") {
    if (
      (method !== "merge" && method !== "squash" && method !== "rebase") ||
      typeof headSha !== "string"
    ) {
      return undefined;
    }
    return { operation, method, headSha };
  }
  if (operation !== "update" || base !== undefined) return undefined;
  const changesLabels = (add?.length ?? 0) > 0 || (remove?.length ?? 0) > 0;
  if (
    title === undefined &&
    body === undefined &&
    draft === undefined &&
    !changesLabels &&
    state === undefined
  ) {
    return undefined;
  }
  // Closing or reopening is a change of its own, not a side effect of an edit.
  if (
    state !== undefined &&
    (title !== undefined || body !== undefined || draft !== undefined || changesLabels)
  ) {
    return undefined;
  }
  return {
    operation,
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof body === "string" ? { body } : {}),
    ...(typeof draft === "boolean" ? { draft } : {}),
    ...(add === undefined ? {} : { addLabels: add }),
    ...(remove === undefined ? {} : { removeLabels: remove }),
    ...(state === undefined ? {} : { state }),
  };
}

function parseTerminalInput(value: string): TerminalToolInput | undefined {
  const parsed = parseObject(value, new Set(["operation", "command"]));
  if (parsed === undefined) return undefined;
  const operation = parsed.operation;
  if (
    operation !== "run" &&
    operation !== "write" &&
    operation !== "read" &&
    operation !== "stop"
  ) {
    return undefined;
  }
  if (parsed.command !== undefined && typeof parsed.command !== "string") return undefined;
  if (
    typeof parsed.command === "string" &&
    Buffer.byteLength(parsed.command, "utf8") > MAX_TOOL_INPUT_BYTES
  ) {
    return undefined;
  }
  return { operation, ...(typeof parsed.command === "string" ? { command: parsed.command } : {}) };
}

function parseAppleInput(value: string): AppleToolInput | undefined {
  const parsed = parseObject(
    value,
    new Set([
      "operation",
      "projectPath",
      "scheme",
      "platform",
      "simulatorId",
      "bundleIdentifier",
      "target",
      "x",
      "y",
      "toX",
      "toY",
      "durationMs",
      "text",
      "key",
    ]),
  );
  if (parsed === undefined) return undefined;
  const operation = parsed.operation;
  if (
    operation !== "discover" &&
    operation !== "status" &&
    operation !== "build" &&
    operation !== "test" &&
    operation !== "run" &&
    operation !== "boot" &&
    operation !== "open" &&
    operation !== "shutdown" &&
    operation !== "screenshot" &&
    operation !== "tap" &&
    operation !== "swipe" &&
    operation !== "type-text" &&
    operation !== "key-press"
  ) {
    return undefined;
  }
  for (const field of [
    "projectPath",
    "scheme",
    "platform",
    "simulatorId",
    "bundleIdentifier",
    "target",
    "text",
    "key",
  ] as const) {
    if (parsed[field] !== undefined && typeof parsed[field] !== "string") return undefined;
  }
  for (const field of ["x", "y", "toX", "toY", "durationMs"] as const) {
    // JSON reads a number too large to hold, such as 1e400, as Infinity. It is
    // a number and not a place; sent on, it became `null` on the way to the
    // desktop and came back as the desktop being unreachable.
    if (parsed[field] !== undefined && !Number.isFinite(parsed[field])) return undefined;
  }
  // A point left of or above the screen is no place. Refused here, it is the
  // caller's mistake; sent on, it was journaled as the device being unavailable.
  for (const field of ["x", "y", "toX", "toY"] as const) {
    if (typeof parsed[field] === "number" && parsed[field] < 0) return undefined;
  }
  if (
    typeof parsed.text === "string" &&
    Buffer.byteLength(parsed.text, "utf8") > MAX_TOOL_INPUT_BYTES
  ) {
    return undefined;
  }
  return parsed as unknown as AppleToolInput;
}

function parseAndroidInput(value: string): AndroidToolInput | undefined {
  const parsed = parseObject(
    value,
    new Set([
      "operation",
      "emulatorId",
      "x",
      "y",
      "toX",
      "toY",
      "durationMs",
      "text",
      "key",
      "apkPath",
      "packageName",
    ]),
  );
  if (parsed === undefined) return undefined;
  const operation = parsed.operation;
  if (
    operation !== "discover" &&
    operation !== "status" &&
    operation !== "open" &&
    operation !== "boot" &&
    operation !== "shutdown" &&
    operation !== "screenshot" &&
    operation !== "tap" &&
    operation !== "swipe" &&
    operation !== "type-text" &&
    operation !== "key-press" &&
    operation !== "install" &&
    operation !== "launch"
  ) {
    return undefined;
  }
  for (const field of ["emulatorId", "text", "key", "apkPath", "packageName"] as const) {
    if (parsed[field] !== undefined && typeof parsed[field] !== "string") return undefined;
  }
  for (const field of ["x", "y", "toX", "toY", "durationMs"] as const) {
    if (parsed[field] !== undefined && !Number.isFinite(parsed[field])) return undefined;
  }
  for (const field of ["x", "y", "toX", "toY"] as const) {
    if (typeof parsed[field] === "number" && parsed[field] < 0) return undefined;
  }
  if (
    typeof parsed.text === "string" &&
    Buffer.byteLength(parsed.text, "utf8") > MAX_TOOL_INPUT_BYTES
  ) {
    return undefined;
  }
  return parsed as unknown as AndroidToolInput;
}

function profileToolConstraintFailure(thread: CodeThread, toolName: string): string | undefined {
  const decision = decideProfileToolConstraint({
    toolId: toolName,
    toolConstraints: thread.toolConstraints ?? [],
    profileDisplayName: thread.profileDisplayName ?? "the bound profile",
  });
  return decision.status === "refused" ? decision.reason : undefined;
}

function browserAuthorityFailure(options: CodeAppManagedToolsOptions): string | undefined {
  const stale = currentThreadIdentityFailure(options);
  if (stale !== undefined) return stale;
  const current = options.readThread(options.windowId, options.thread.id);
  const posture = clampTurnAccessPosture({
    requested: options.thread.executionPolicy,
    thread: current?.executionPolicy ?? options.thread.executionPolicy,
  });
  return posture === "plan" ? "plan-mode-read-only" : undefined;
}

/**
 * What keeps the agent terminal from running now: a stale thread, or Plan.
 * Every other level reaches it, asking per command below Full access.
 */
function terminalAuthorityFailure(options: CodeAppManagedToolsOptions): string | undefined {
  const staleness = currentThreadIdentityFailure(options);
  if (staleness !== undefined) return staleness;
  return currentPosture(options) === "plan" ? "plan-mode-read-only" : undefined;
}

function currentAuthorityFailure(options: CodeAppManagedToolsOptions): string | undefined {
  const staleness = currentThreadIdentityFailure(options);
  if (staleness !== undefined) return staleness;
  return currentPosture(options) === "full-access" ? undefined : "full-access-required";
}

function currentPosture(options: CodeAppManagedToolsOptions) {
  const current = options.readThread(options.windowId, options.thread.id);
  return clampTurnAccessPosture({
    requested: options.thread.executionPolicy,
    thread: current?.executionPolicy ?? options.thread.executionPolicy,
  });
}

type DeviceEffectDecision =
  | { readonly kind: "allowed"; readonly approval: ToolActionApproval }
  | { readonly kind: "refused"; readonly reason: string; readonly message?: string };

const NOT_REQUIRED: ToolActionApproval = { kind: "not-required" };

/**
 * Whether a device effect the agent asked for may reach the host, and with
 * which approval.
 *
 * Code threads start approval-gated, so requiring Full access here left an
 * agent unable to boot, build, or tap at all, and the Allow input grant
 * unreachable. Instead an approval-gated or auto-accept-edits posture asks the
 * person in the thread, once per effect, and the host receives a one-use
 * approval bound to exactly that request — the same approval a workbench click
 * carries, checked by the same Apple or Android policy. Input to a destination
 * this window already holds open rides the live Allow input grant without
 * asking again, as a pane click does. Plan mode refuses every effect; Full
 * access runs them without asking.
 */
async function deviceEffectApproval(
  options: CodeAppManagedToolsOptions,
  effect: CodeDeviceApprovalEffect,
  coveredByInputGrant: () => boolean,
  signal?: AbortSignal,
): Promise<DeviceEffectDecision> {
  const posture = currentPosture(options);
  if (posture === "plan") {
    return { kind: "refused", reason: "plan-mode-read-only", message: postureRefusal("plan") };
  }
  if (!decidesCodeEffectsByApproval(posture) || coveredByInputGrant()) {
    return { kind: "allowed", approval: NOT_REQUIRED };
  }
  return await askPersonForDevice(options, effect, true, signal);
}

/** Asks the person in the thread, and turns their answer into the host's one-use approval. */
async function askPersonForDevice(
  options: CodeAppManagedToolsOptions,
  effect: CodeDeviceApprovalEffect,
  refusedInPlan: boolean,
  signal?: AbortSignal,
): Promise<DeviceEffectDecision> {
  if (options.deviceApproval === undefined) {
    return { kind: "refused", reason: "device-approval-required" };
  }
  const outcome = await options.deviceApproval.request(effect, signal);
  if (outcome.status !== "approved") {
    return { kind: "refused", reason: `device-approval-${outcome.status}` };
  }
  // The person answered while the thread could have moved on; an approval
  // given to a thread that is now stale, or for an effect now in Plan, speaks
  // for nothing.
  const changed =
    currentThreadIdentityFailure(options) ??
    (refusedInPlan && currentPosture(options) === "plan" ? "plan-mode-read-only" : undefined);
  if (changed !== undefined) return { kind: "refused", reason: changed };
  if (signal?.aborted === true) return { kind: "refused", reason: "tool-interrupted" };
  return { kind: "allowed", approval: { kind: "approved", approvalId: outcome.approvalId } };
}

/** Whether an operation only reads the toolchain, the runtime, or a screen. */
function isDeviceRead(operation: string): boolean {
  return operation === "status" || operation === "discover" || operation === "screenshot";
}

/**
 * Staleness alone, without the full-access posture requirement. The planner
 * tools read a server projection and record an advisory proposal; neither
 * touches the checkout, so demanding Full access would only push a planner
 * thread into a wider posture than its work needs. Identity staleness still
 * refuses: a rebased, re-homed, or archived thread speaks for nothing.
 */
function currentThreadIdentityFailure(options: CodeAppManagedToolsOptions): string | undefined {
  const current = options.readThread(options.windowId, options.thread.id);
  if (
    current === undefined ||
    current.lifecycle !== "active" ||
    current.id !== options.thread.id ||
    current.checkoutId !== options.thread.checkoutId ||
    current.projectId !== options.thread.projectId ||
    current.repositoryId !== options.thread.repositoryId ||
    current.providerInstanceId !== options.thread.providerInstanceId ||
    current.modelId !== options.thread.modelId ||
    current.bindingRevisionId !== options.thread.bindingRevisionId
  ) {
    return "tool-authority-stale";
  }
  return undefined;
}

function boundedUtf8Tail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (Buffer.byteLength(value.slice(middle), "utf8") <= maxBytes) high = middle;
    else low = middle + 1;
  }
  if (low < value.length && isLowSurrogate(value.charCodeAt(low))) low += 1;
  return value.slice(low);
}

function terminalTranscriptTail(
  snapshot: CodeOperationTerminalSnapshot,
  maxBytes: number,
): { readonly value: string; readonly truncated: boolean } {
  const selected: string[] = [];
  let remaining = maxBytes;
  let firstSelectedIndex = snapshot.transcript.chunks.length;
  let truncatedByBound = false;
  for (let index = snapshot.transcript.chunks.length - 1; index >= 0; index -= 1) {
    const chunk = snapshot.transcript.chunks[index]!;
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    firstSelectedIndex = index;
    if (chunkBytes <= remaining) {
      selected.unshift(chunk);
      remaining -= chunkBytes;
      continue;
    }
    selected.unshift(boundedUtf8Tail(chunk, remaining));
    truncatedByBound = true;
    break;
  }
  return {
    value: selected.join(""),
    truncated: snapshot.transcript.truncated || truncatedByBound || firstSelectedIndex > 0,
  };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function parseObject(
  value: string,
  allowedKeys: ReadonlySet<string>,
  maxBytes = MAX_TOOL_INPUT_BYTES,
): Record<string, unknown> | undefined {
  if (Buffer.byteLength(value, "utf8") > maxBytes) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).some((key) => !allowedKeys.has(key))) return undefined;
    return record;
  } catch {
    return undefined;
  }
}

function allowedOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function failure(error: string, message?: string) {
  return { result: { error, ...(message === undefined ? {} : { message }) }, isError: true };
}

/**
 * The sentence a posture refusal carries, so the agent never has to relay a
 * bare slug: every other refusal in this file names its cause or its remedy,
 * and a person reading the tool result deserves the same.
 */
function postureRefusal(error: string) {
  return error === "full-access-required"
    ? "This tool needs Full access for the thread. Raise the thread's access, then try again."
    : "Plan mode is read-only; this tool cannot run.";
}

function defaultWait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function deviceScreenshotResult<T extends { readonly result: object; readonly isError: boolean }>(
  evidence: T,
  bytes: Uint8Array | undefined,
) {
  // The wire allows 2 MiB of base64. Refuse whole images instead of truncating
  // or resizing them and invalidating the pixel coordinates used for input.
  const maxBytes = 1_572_864;
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (
    bytes === undefined ||
    bytes.byteLength > maxBytes ||
    !pngSignature.every((byte, index) => bytes[index] === byte)
  ) {
    return {
      result: {
        ...evidence.result,
        error: "screenshot-image-unavailable",
        message:
          "The screenshot could not be delivered as a provider image. Do not infer screen contents from the artifact reference.",
      },
      isError: true,
    };
  }
  return {
    ...evidence,
    images: [{ mimeType: "image/png" as const, data: Buffer.from(bytes).toString("base64") }],
  };
}
