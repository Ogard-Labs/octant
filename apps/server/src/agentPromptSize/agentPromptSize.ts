import {
  CODE_DEBUG_TOOL_DEFINITION,
  CODE_LANGUAGE_TOOL_DEFINITION,
  lookupClosedToolCatalogEntry,
  NATIVE_HARNESS_TOOL_DEFINITIONS,
  nativeHarnessToolCapabilityId,
  NativeHarnessToolName,
  ProviderInstanceId,
  ToolCapabilityId,
  WEB_SEARCH_TOOL_DEFINITION,
  WindowsTerminalShell,
  type OctantMode,
  type ProviderContextBlock,
  type ProviderToolDefinition,
} from "@octant/contracts";
import { OCTANT_CREDENTIAL_TOOL } from "@octant/contracts/credential-request";
import {
  PAST_THREADS_TOOL_DEFINITION,
  REMEMBER_PERSON_TOOL_DEFINITION,
} from "@octant/contracts/person-memory";
import type { MediaToolHostPort } from "@octant/plugin-api/media-tools";
import {
  CREATE_IMAGE_MEDIA_TOOL_PLUGIN,
  CREATE_VIDEO_MEDIA_TOOL_PLUGIN,
  LOOK_MEDIA_TOOL_PLUGIN,
  NARRATE_MEDIA_TOOL_PLUGIN,
  TRANSCRIBE_MEDIA_TOOL_PLUGIN,
} from "@octant/plugin-host/media-tools";
import {
  providerTurnContextDelta,
  renderContextBesideRequest,
  renderOctantInstructions,
  renderProviderTurnPrompt,
} from "@octant/provider-sdk/chat-conformance";
import { Schema } from "effect";
import { AGENTS_TOOL_DEFINITION } from "../agentRun/agentRunManagedTools";
import {
  chatRoutineProposalDefinition,
  routineProposalDefinition,
} from "../automation/routineProposalTools";
import { routinesDefinition } from "../automation/routineTools";
import { delegatedBrowserToolDefinition } from "../browser/browserDelegatedChildren";
import { BROWSER_TOOL_DEFINITION } from "../browser/browserToolDefinition";
import {
  CANVAS_TOOL_NAME,
  canvasDefinitionSchema,
  canvasToolDescription,
} from "../canvas/canvasAgentTools";
import {
  documentDeliveryInstructions,
  offersCanvasTool,
} from "../canvas/canvasDeliveryInstructions";
import { THREAD_DIALOGUE_TOOL_DEFINITION } from "../chat/threadDialogueService";
import {
  androidDefinition,
  appleDefinition,
  pullRequestDefinition,
  terminalDefinition,
} from "../code/codeAppManagedTools";
import { REPORT_FINISHED_TOOL_DEFINITION } from "../finishedReceipts/finishedReceiptTools";
import { followUpSuggestionInstructionsFor } from "../followUps/followUpSuggestionInstructions";
import { githubUpdateDefinition } from "../github/githubReadToolService";
import {
  harnessTodayInstruction,
  nativeHarnessInstructions,
} from "../harness/nativeHarnessInstructions";
import { composeSystem, splitInstructions } from "../harness/nativeHarnessLoop";
import { octantOrientation } from "../orientation/octantOrientation";
import { DESKTOP_TOOL, MAC_TOOL } from "../plugins/computerUse/computerUsePlugin";
import { linearUpdateDefinition } from "../plugins/linear/linearReadToolService";
import { projectMemoryDefinition } from "../projectMemory/projectMemoryTools";
import { appToolHostLines } from "../providers/appToolHostLines";
import { CLAUDE_ARTIFACT_TOOL } from "../providers/claudeDriver";
import { codexDynamicTools } from "../providers/codexDriver";
import { encodeChatCompletionsTools, encodeResponsesTools } from "../providers/openAiToolEncoding";
import { threadsToolDefinition } from "../siblingThreads/siblingThreadTools";
import { sideTaskDefinition } from "../sideTasks/sideTaskTools";
import { WORK_ARTIFACT_INSTRUCTIONS } from "../work/workTurnContext";
import { STATUS_UPKEEP_INSTRUCTION } from "../work/workTurnService";
import { turnDecisionInstructions } from "../turnDecisions/turnDecisionInstructions";
import { GEMINI_OMNI_FLASH } from "../video/geminiVideoAdapter";
import { RUNWAY_GEN4_TURBO, RUNWAY_GEN45 } from "../video/runwayVideoAdapter";
import { describeReadyModels } from "../video/videoAgentTools";
import { ZEN_ASSISTANT_TOOL_DEFINITION } from "../zen/zenAssistantTools";

/**
 * How much Octant itself puts in front of a model: the widest tool list and
 * instructions each runtime can be given, encoded the way that runtime's
 * adapter sends them. It is built from the same definitions and renderers a
 * turn uses, with no server, so a change that makes every prompt larger shows
 * as a number before it ships. It is an upper bound: a turn's posture withholds
 * some of these tools, and no posture adds one. What the person adds (skills, memory, files,
 * plugins, MCP servers) and a runtime's own prompt are not Octant's and are
 * not counted.
 */

export const AGENT_PROMPT_BUDGET_PATH = "scripts/agent-prompt-size-budget.json";

/** The runtimes that carry Octant's tools; `harness` is Octant Harness on a model endpoint. */
export const AGENT_PROMPT_RUNTIMES = [
  "claude",
  "codex",
  "opencode",
  "acp",
  "pi",
  "harness",
] as const;
export type AgentPromptRuntime = (typeof AGENT_PROMPT_RUNTIMES)[number];

/** A thread's lead in each mode, and a child run in each mode. */
export const AGENT_PROMPT_CONTEXTS = [
  "chat",
  "work",
  "code",
  "chat-child",
  "work-child",
  "code-child",
] as const;
export type AgentPromptContext = (typeof AGENT_PROMPT_CONTEXTS)[number];

/** Guided tools the widest turn of no measured context carries, each with why. */
export const NOT_MEASURED_TOOLS: Readonly<Record<string, string>> = {
  octant_side_chat_list_files: "a Side Chat's only tools, beside no other",
  octant_side_chat_read_file: "a Side Chat's only tools, beside no other",
  octant_side_chat_search_files: "a Side Chat's only tools, beside no other",
};

export interface AgentPromptPart {
  readonly instructionBytes: number;
  readonly toolBytes: number;
  readonly estimatedTokens: number;
}

export interface AgentPromptSize {
  readonly firstPrompt: AgentPromptPart;
  /** What Octant sends again on every later turn of the same session. */
  readonly laterTurn: AgentPromptPart;
}

export type AgentPromptReport = Readonly<
  Record<AgentPromptRuntime, Readonly<Record<AgentPromptContext, AgentPromptSize>>>
>;

export interface AgentPromptBudgetEntry {
  readonly firstPromptBytes: number;
  readonly laterTurnBytes: number;
}

export type AgentPromptBudget = Readonly<
  Record<AgentPromptRuntime, Readonly<Record<AgentPromptContext, AgentPromptBudgetEntry>>>
>;

export interface AgentPromptDifference {
  readonly runtime: AgentPromptRuntime;
  readonly context: AgentPromptContext;
  readonly measure: keyof AgentPromptBudgetEntry;
  readonly measured: number;
  readonly budget: number;
}

const refused = async () => ({ status: "refused" as const, reason: "measured only" });
const refusedWith = async () => ({ status: "refused" as const, error: "measured only" });

const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * The longest description one ready profile gives, from each driver's shipped
 * model set; fal lists the person's own endpoints, and how many profiles a
 * person adds is theirs.
 */
const WIDEST_VIDEO_PROFILE = [[GEMINI_OMNI_FLASH], [RUNWAY_GEN45, RUNWAY_GEN4_TURBO]]
  .map((models) =>
    describeReadyModels([
      {
        instance: {
          id: ProviderInstanceId.make("00000000-0000-4000-8000-000000000000"),
          displayName: "Video",
        },
        models,
      },
    ]),
  )
  .reduce((widest, next) => (bytes(next) > bytes(widest) ? next : widest));

/** A port that answers yes to every capability, so each media tool gives its widest definition. */
function widestMediaPort(mode: OctantMode): MediaToolHostPort {
  const isAvailable = () => true;
  return {
    turn: {
      mode,
      hasFolder: mode !== "chat",
      unattended: false,
      inPlan: () => false,
      allowed: () => true,
    },
    transcription: { isAvailable, transcribe: refused },
    narration: { isAvailable, narrate: refused },
    imageDescription: {
      isAvailable,
      describeAttachment: refused,
      describeFolderImage: refused,
    },
    imageGeneration: {
      isAvailable,
      generate: refusedWith,
      ...(mode === "chat" ? {} : { save: refusedWith, iconSet: refusedWith }),
    },
    videoGeneration: {
      isAvailable,
      describeModels: () => WIDEST_VIDEO_PROFILE,
      generate: refusedWith,
      ...(mode === "chat" ? {} : { save: refusedWith }),
    },
  };
}

function mediaTools(
  mode: OctantMode,
  plugins: ReadonlyArray<typeof LOOK_MEDIA_TOOL_PLUGIN>,
): ReadonlyArray<ProviderToolDefinition> {
  const port = widestMediaPort(mode);
  return plugins.flatMap((plugin) => plugin.createTools(port)?.definitions ?? []);
}

function canvasTool(mode: OctantMode, scope: "thread" | "run"): ProviderToolDefinition {
  return {
    name: CANVAS_TOOL_NAME,
    description: canvasToolDescription(mode, scope),
    inputSchema: canvasDefinitionSchema,
  };
}

const isHarnessToolName = Schema.is(NativeHarnessToolName);

/** What a child run's session is composed of: the workspace tools and the web, never a lead's thread tools. */
const CHILD_HARNESS_TOOLS: ReadonlySet<string> = new Set([
  "read",
  "grep",
  "glob",
  "edit",
  "write",
  "bash",
  "web-fetch",
  "web-search",
  "ask-user",
  "diagnostics",
]);

function harnessTools(mode: OctantMode, child: boolean): ReadonlyArray<ProviderToolDefinition> {
  return NATIVE_HARNESS_TOOL_DEFINITIONS.filter((definition) => {
    if (!isHarnessToolName(definition.name)) return false;
    const entry = lookupClosedToolCatalogEntry({
      id: ToolCapabilityId.make(nativeHarnessToolCapabilityId(definition.name)),
      version: 1,
    });
    if (entry?.modes.includes(mode) !== true) return false;
    return (
      !child ||
      (CHILD_HARNESS_TOOLS.has(definition.name) && (definition.name !== "bash" || mode === "code"))
    );
  });
}

/** A turn carries one of these, never both. */
function widestOf(
  left: ProviderToolDefinition,
  right: ProviderToolDefinition,
): ProviderToolDefinition {
  return bytes(JSON.stringify(left)) >= bytes(JSON.stringify(right)) ? left : right;
}

const EVERYWHERE: ReadonlyArray<ProviderToolDefinition> = [
  AGENTS_TOOL_DEFINITION,
  widestOf(MAC_TOOL, DESKTOP_TOOL),
  projectMemoryDefinition,
  PAST_THREADS_TOOL_DEFINITION,
  REMEMBER_PERSON_TOOL_DEFINITION,
];

const ALL_MEDIA = [
  CREATE_IMAGE_MEDIA_TOOL_PLUGIN,
  CREATE_VIDEO_MEDIA_TOOL_PLUGIN,
  LOOK_MEDIA_TOOL_PLUGIN,
  NARRATE_MEDIA_TOOL_PLUGIN,
  TRANSCRIBE_MEDIA_TOOL_PLUGIN,
];

/** The `octant_*` tools (and Chat's search) the widest turn of a context carries. */
function octantTools(context: AgentPromptContext): ReadonlyArray<ProviderToolDefinition> {
  switch (context) {
    case "chat":
      return [
        ...EVERYWHERE,
        ...mediaTools("chat", ALL_MEDIA),
        canvasTool("chat", "thread"),
        sideTaskDefinition(false, false),
        chatRoutineProposalDefinition,
        THREAD_DIALOGUE_TOOL_DEFINITION,
        // A Zen space's assistant is a Chat thread with this beside the rest.
        ZEN_ASSISTANT_TOOL_DEFINITION,
      ];
    case "work":
      return [
        ...EVERYWHERE,
        ...mediaTools("work", ALL_MEDIA),
        canvasTool("work", "thread"),
        BROWSER_TOOL_DEFINITION,
        OCTANT_CREDENTIAL_TOOL,
        threadsToolDefinition(["list", "read", "wait", "send", "acknowledge", "receipts", "help"]),
        sideTaskDefinition(false, false),
        routineProposalDefinition,
        routinesDefinition,
        REPORT_FINISHED_TOOL_DEFINITION,
      ];
    case "code":
      return [
        ...EVERYWHERE,
        ...mediaTools("code", ALL_MEDIA),
        canvasTool("code", "thread"),
        BROWSER_TOOL_DEFINITION,
        OCTANT_CREDENTIAL_TOOL,
        terminalDefinition,
        CODE_DEBUG_TOOL_DEFINITION,
        appleDefinition,
        androidDefinition,
        pullRequestDefinition,
        // A thread with linked issues may update them, which widens both.
        githubUpdateDefinition,
        linearUpdateDefinition,
        CODE_LANGUAGE_TOOL_DEFINITION,
        threadsToolDefinition([
          "list",
          "read",
          "wait",
          "send",
          "acknowledge",
          "receipts",
          "board",
          "start",
          "move-to-worktree",
          "help",
        ]),
        sideTaskDefinition(true, true),
        routineProposalDefinition,
        routinesDefinition,
        REPORT_FINISHED_TOOL_DEFINITION,
      ];
    case "chat-child":
      return [PAST_THREADS_TOOL_DEFINITION];
    case "work-child":
      return [
        PAST_THREADS_TOOL_DEFINITION,
        canvasTool("work", "run"),
        delegatedBrowserToolDefinition({ uploads: false, downloads: false }),
      ];
    case "code-child":
      return [
        PAST_THREADS_TOOL_DEFINITION,
        canvasTool("code", "run"),
        delegatedBrowserToolDefinition({ uploads: false, downloads: false }),
      ];
  }
}

function modeOf(context: AgentPromptContext): OctantMode {
  return context === "chat" || context === "chat-child"
    ? "chat"
    : context === "work" || context === "work-child"
      ? "work"
      : "code";
}

function isChild(context: AgentPromptContext): boolean {
  return context.endsWith("-child");
}

/** The first-party tools the widest turn of a context carries on every runtime. */
export function promptTools(context: AgentPromptContext): ReadonlyArray<ProviderToolDefinition> {
  const own = octantTools(context);
  // A child's workspace tools are Octant's own on every runtime.
  if (isChild(context)) return [...harnessTools(modeOf(context), true), ...own];
  return context === "chat" ? [...own, WEB_SEARCH_TOOL_DEFINITION] : own;
}

function runtimeTools(
  runtime: AgentPromptRuntime,
  context: AgentPromptContext,
): ReadonlyArray<ProviderToolDefinition> {
  if (runtime !== "harness" || isChild(context)) return promptTools(context);
  const harness = harnessTools(modeOf(context), false);
  const named = new Set(harness.map((tool) => tool.name));
  return [...harness, ...promptTools(context).filter((tool) => !named.has(tool.name))];
}

const textBytes = (blocks: ReadonlyArray<ProviderContextBlock>): number =>
  bytes(blocks.map((block) => block.text).join(""));

/** A Windows host adds its shell's paragraph in Work and Code; the longest one bounds every host. */
function widestHarnessInstructions(mode: OctantMode): ReadonlyArray<ProviderContextBlock> {
  return WindowsTerminalShell.literals
    .map((windowsShell) => nativeHarnessInstructions(mode, { platform: "win32", windowsShell }))
    .reduce(
      (widest, next) => (textBytes(next) > textBytes(widest) ? next : widest),
      nativeHarnessInstructions(mode, { platform: "darwin" }),
    );
}

/** Octant's own instruction blocks for a context, in the order a turn sends them. */
function promptInstructions(
  runtime: AgentPromptRuntime,
  context: AgentPromptContext,
  tools: ReadonlyArray<ProviderToolDefinition>,
): ReadonlyArray<ProviderContextBlock> {
  const mode = modeOf(context);
  const lines = appToolHostLines(tools).map(
    (line): ProviderContextBlock => ({ kind: "instructions", text: line.text, tool: line.tool }),
  );
  if (isChild(context)) return lines;
  // A Claude Work or Code lead whose person turned on artifact delivery is
  // given the longer artifact rule in place of the Canvas rule; no other
  // runtime names an artifact tool, and Chat never does.
  const delivery = documentDeliveryInstructions({
    artifactToolName: runtime === "claude" && mode !== "chat" ? CLAUDE_ARTIFACT_TOOL : undefined,
    canvasOffered: offersCanvasTool(tools),
  });
  return [
    octantOrientation(mode),
    ...(runtime === "harness" ? widestHarnessInstructions(mode) : []),
    ...(runtime === "harness"
      ? [
          {
            kind: "turn-instructions" as const,
            text: harnessTodayInstruction("2026-01-01T00:00:00.000Z"),
          },
        ]
      : []),
    ...turnDecisionInstructions(mode),
    followUpSuggestionInstructionsFor(true),
    ...(mode === "work"
      ? [WORK_ARTIFACT_INSTRUCTIONS, STATUS_UPKEEP_INSTRUCTION].map((text) => ({
          kind: "instructions" as const,
          text,
        }))
      : []),
    ...(delivery === undefined ? [] : [{ kind: "instructions" as const, text: delivery }]),
    ...lines,
  ];
}

/** The instruction texts the widest first turn of a context sends a runtime. */
export function promptInstructionTexts(
  runtime: AgentPromptRuntime,
  context: AgentPromptContext,
): ReadonlyArray<string> {
  return promptInstructions(runtime, context, runtimeTools(runtime, context)).map(
    (block) => block.text,
  );
}

function renderedInstructions(
  runtime: AgentPromptRuntime,
  blocks: ReadonlyArray<ProviderContextBlock>,
  tools: ReadonlyArray<ProviderToolDefinition>,
): number {
  if (runtime === "harness") {
    // The harness splits a turn as it sends it: standing instructions become
    // the system prompt, and one-turn ones such as the date ride, tagged, in
    // the user message.
    const { system, rest } = splitInstructions(blocks);
    return (
      bytes(composeSystem(system, tools) ?? "") +
      (rest.length === 0 ? 0 : bytes(renderProviderTurnPrompt({ context: rest, prompt: "" })))
    );
  }
  if (blocks.length === 0) return 0;
  if (runtime === "claude") return bytes(renderContextBesideRequest(blocks));
  if (runtime === "codex") return bytes(renderOctantInstructions(blocks));
  return bytes(renderProviderTurnPrompt({ context: blocks, prompt: "" }));
}

/** The tool list as the runtime's adapter hands it over: MCP's list, Codex's dynamic tools, or the request's own. */
function renderedTools(
  runtime: AgentPromptRuntime,
  tools: ReadonlyArray<ProviderToolDefinition>,
): number {
  if (runtime === "codex") return bytes(JSON.stringify(codexDynamicTools(tools) ?? []));
  // An endpoint speaks Chat Completions or Responses; the larger encoding bounds both.
  if (runtime === "harness")
    return Math.max(
      bytes(JSON.stringify(encodeChatCompletionsTools(tools))),
      bytes(JSON.stringify(encodeResponsesTools(tools))),
    );
  return bytes(JSON.stringify(tools));
}

function part(instructionBytes: number, toolBytes: number): AgentPromptPart {
  return {
    instructionBytes,
    toolBytes,
    estimatedTokens: Math.ceil((instructionBytes + toolBytes) / 4),
  };
}

/** ACP reports no prompt retention and an endpoint keeps none, so both are told again. */
const KEEPS_STANDING_CONTEXT: ReadonlySet<AgentPromptRuntime> = new Set([
  "claude",
  "codex",
  "opencode",
  "pi",
]);

function measure(runtime: AgentPromptRuntime, context: AgentPromptContext): AgentPromptSize {
  const tools = runtimeTools(runtime, context);
  const blocks = promptInstructions(runtime, context, tools);
  // A child's follow-up carries no context of its own: its session has it.
  const later = isChild(context)
    ? []
    : providerTurnContextDelta({
        context: blocks,
        holds: () => KEEPS_STANDING_CONTEXT.has(runtime),
        heldIdentities: new Set(),
        identify: (block) => block.text,
      }).context;
  const toolBytes = renderedTools(runtime, tools);
  return {
    firstPrompt: part(renderedInstructions(runtime, blocks, tools), toolBytes),
    laterTurn: part(
      renderedInstructions(runtime, later, tools),
      runtime === "harness" ? toolBytes : 0,
    ),
  };
}

function byRuntimeAndContext<T>(
  read: (runtime: AgentPromptRuntime, context: AgentPromptContext) => T,
): Readonly<Record<AgentPromptRuntime, Readonly<Record<AgentPromptContext, T>>>> {
  const forRuntime = (runtime: AgentPromptRuntime) => ({
    chat: read(runtime, "chat"),
    work: read(runtime, "work"),
    code: read(runtime, "code"),
    "chat-child": read(runtime, "chat-child"),
    "work-child": read(runtime, "work-child"),
    "code-child": read(runtime, "code-child"),
  });
  return {
    claude: forRuntime("claude"),
    codex: forRuntime("codex"),
    opencode: forRuntime("opencode"),
    acp: forRuntime("acp"),
    pi: forRuntime("pi"),
    harness: forRuntime("harness"),
  };
}

export function measureAgentPrompts(): AgentPromptReport {
  return byRuntimeAndContext(measure);
}

const total = (size: AgentPromptPart): number => size.instructionBytes + size.toolBytes;

export function budgetFor(report: AgentPromptReport): AgentPromptBudget {
  return byRuntimeAndContext((runtime, context) => ({
    firstPromptBytes: total(report[runtime][context].firstPrompt),
    laterTurnBytes: total(report[runtime][context].laterTurn),
  }));
}

/** A missing or malformed number would silently drop that limit from the check. */
export function readAgentPromptBudget(
  value: unknown,
):
  | { readonly status: "read"; readonly budget: AgentPromptBudget }
  | { readonly status: "refused"; readonly message: string } {
  let missing: string | undefined;
  const field = (from: unknown, key: string): unknown =>
    typeof from === "object" && from !== null ? Reflect.get(from, key) : undefined;
  const budget = byRuntimeAndContext((runtime, context): AgentPromptBudgetEntry => {
    const entry = field(field(value, runtime), context);
    const whole = (measure: keyof AgentPromptBudgetEntry): number => {
      const size = field(entry, measure);
      if (typeof size === "number" && Number.isInteger(size) && size >= 0) return size;
      missing ??= `${AGENT_PROMPT_BUDGET_PATH} has no whole-byte ${measure} for ${runtime} ${context}.`;
      return 0;
    };
    return {
      firstPromptBytes: whole("firstPromptBytes"),
      laterTurnBytes: whole("laterTurnBytes"),
    };
  });
  return missing === undefined
    ? { status: "read", budget }
    : { status: "refused", message: missing };
}

function differing(
  report: AgentPromptReport,
  budget: AgentPromptBudget,
  differs: (measured: number, budget: number) => boolean,
): ReadonlyArray<AgentPromptDifference> {
  const measured = budgetFor(report);
  return AGENT_PROMPT_RUNTIMES.flatMap((runtime) =>
    AGENT_PROMPT_CONTEXTS.flatMap((context) =>
      (["firstPromptBytes", "laterTurnBytes"] as const).flatMap((measure) => {
        const size = measured[runtime][context][measure];
        const limit = budget[runtime][context][measure];
        return differs(size, limit)
          ? [{ runtime, context, measure, measured: size, budget: limit }]
          : [];
      }),
    ),
  );
}

export function overBudget(
  report: AgentPromptReport,
  budget: AgentPromptBudget,
): ReadonlyArray<AgentPromptDifference> {
  return differing(report, budget, (measured, limit) => measured > limit);
}

/** A budget left above the real size would let later growth pass unseen. */
export function underBudget(
  report: AgentPromptReport,
  budget: AgentPromptBudget,
): ReadonlyArray<AgentPromptDifference> {
  return differing(report, budget, (measured, limit) => measured < limit);
}
