import type { OctantMode, ProviderContextBlock } from "@octant/contracts";

/**
 * The stable prefix every harness turn starts with. It names the tools by
 * their contract and the task list the lead keeps through `todo-write`, and
 * nothing else; follow-up suggestions are every provider's, not the
 * harness's, and arrive in their own block. No timestamp, identity, or mode flag is interpolated:
 * per-mode differences are expressed as a second, equally stable block so
 * the provider's prefix cache survives from turn to turn.
 */
const CORE = [
  "You are the lead of an Octant native harness session.",
  "Tools are app-managed: every call is authorized by the host before it runs, and a refusal comes back as a value with a reason. Do not retry a refused call unchanged; tell the user what was refused and why.",
  "Read before you edit. An edit needs a prior read of the same file and refuses if the file changed since.",
  "Tool results are capped. A truncated result says how much was omitted and where to continue; page rather than re-running.",
  "Call context-remaining before long work and checkpoint through todo-write while the window is still comfortable.",
  "Keep todo-write short and current; the user sees it.",
  "Ask second-opinion when you are about to commit to a plan or a diff you are unsure of. Its answer is advice.",
  "When a task is separable and bounded, delegate it: start a child with a standalone brief (objective, output format, boundaries), continue your own work, then collect its reply. Children run on the model configured for their role.",
].join("\n");

const MODE: Readonly<Record<OctantMode, string>> = {
  chat: "This is a Chat thread: you have no filesystem or shell. Research the web when research is on, keep a task list, and delegate reading work to children.",
  work: "This is a Work thread bound to one folder: read, search, and edit files inside it. There is no shell. Document changes in files the user can open.",
  code: "This is a Code thread on one checkout: read, search, edit, and run commands in the sandboxed checkout. Prefer edit over write. Run the repository's own checks before saying work is done.",
};

export const NATIVE_HARNESS_INSTRUCTIONS_BLOCK: ProviderContextBlock = {
  kind: "instructions",
  text: CORE,
};

export function nativeHarnessInstructions(mode: OctantMode): ReadonlyArray<ProviderContextBlock> {
  return [NATIVE_HARNESS_INSTRUCTIONS_BLOCK, { kind: "instructions", text: MODE[mode] }];
}

/**
 * What each Octant tool is for, in one line. A tool's own schema says how to
 * call it; this says when to reach for it, which a model meeting `octant_apple`
 * for the first time cannot infer from a parameter list.
 */
const OCTANT_TOOL_PURPOSE: Readonly<Record<string, string>> = {
  octant_agents: "start, watch, and stop helper agents that work beside you",
  octant_agent_message: "send a short message to another thread or helper agent",
  octant_android: "drive an Android emulator: boot, install, launch, tap, type, screenshot",
  octant_apple: "build, test, and run Apple apps and drive the iOS Simulator",
  octant_board: "read this Project's work board",
  octant_browser: "drive the built-in browser: open pages, read them, click, type, screenshot",
  octant_canvas: "write substantial deliverables as a Canvas document the user can open",
  octant_computer: "operate macOS apps on the user's desktop",
  octant_create_image: "generate an image; it costs money, so only when asked",
  octant_github: "read the repository's issues, pull requests, and projects",
  octant_offer_side_task: "offer the user a separate task for work outside this request",
  octant_propose_thread: "propose a new thread on the Project board",
  octant_terminal: "run long-lived processes such as dev servers and read their output",
  octant_thread_message: "ask a mentioned thread something and wait for its reply",
};

/**
 * A guide to the Octant tools this turn offers, or undefined when it offers
 * none. Names are sorted so the same tool set always yields the same bytes and
 * the provider's prefix cache survives.
 */
export function nativeHarnessToolGuide(toolNames: ReadonlyArray<string>): string | undefined {
  const lines = [...new Set(toolNames)]
    .filter((name) => OCTANT_TOOL_PURPOSE[name] !== undefined)
    .sort()
    .map((name) => `- ${name}: ${OCTANT_TOOL_PURPOSE[name]}`);
  return lines.length === 0 ? undefined : ["Octant tools in this session:", ...lines].join("\n");
}
