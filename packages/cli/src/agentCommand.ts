import { createInterface } from "node:readline";
import { nativeHarnessStatusLabel } from "@octant/domain";
import {
  decodeNativeHarnessRoutingSettings,
  decodeNativeHarnessFollowUpActivationResult,
  decodeNativeHarnessFollowUpPreview,
  decodeNativeHarnessSessionView,
  type NativeHarnessSessionView,
  type OctantMode,
} from "@octant/contracts";
import { listAgentThreads, openAgentSideChat, readAgentGoal, reviseAgentGoal } from "./agentHost";
import {
  forkAgentThread,
  listAgentCheckpoints,
  markAgentCheckpoint,
  restoreAgentCheckpoint,
  type AgentBranchResult,
} from "./agentBranches";
import { AgentWake, followAgentThread } from "./agentLiveFeed";
import {
  attachAgentThread,
  agentThreadPort,
  type AgentThreadPort,
  createAgentThread,
  isAgentSnapshotRunning,
} from "./agentThread";
import { runAgentTui } from "./agentTui";
import {
  defaultCheckpointLabel,
  describeAgentGoal,
  isTuiThemeId,
  type TuiThemeId,
} from "./agentTuiModel";
import { failureMessage, type OpenedLocalControlSession } from "./localControl";

export type AgentCliCommand =
  | {
      readonly action: "agent";
      readonly prompt?: string;
      readonly threadId?: string;
      readonly project?: string;
      readonly title?: string;
      readonly json: boolean;
      /** Line mode even on a terminal that could draw the full screen. */
      readonly plain: boolean;
      readonly theme?: TuiThemeId;
      /** Attach to the latest thread instead of creating one: this folder's Code or Work Project first, else Chat. */
      readonly last: boolean;
      /** No desktop notification when a turn ends. */
      readonly quiet: boolean;
      /** `auto` follows the folder: a Code or Work Project holding it, else Chat. */
      readonly mode: "chat" | "work" | "code" | "auto";
      /** A harness model for a new Work or Code thread: `model` or `endpoint/model`. */
      readonly model?: string;
    }
  | { readonly action: "harness-slots"; readonly json: boolean }
  | { readonly action: "harness-session"; readonly threadId: string; readonly json: boolean };

const AGENT_FLAGS: ReadonlyArray<string> = [
  "prompt",
  "thread",
  "project",
  "title",
  "json",
  "plain",
  "theme",
  "last",
  "quiet",
  "mode",
  "model",
];

export function resolveAgentCliCommand(
  command: string,
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): AgentCliCommand | undefined {
  if (command === "agent") {
    if (positional.length > 0) return undefined;
    if (Object.keys(flags).some((flag) => !AGENT_FLAGS.includes(flag))) return undefined;
    const text = (flag: string) =>
      typeof flags[flag] === "string" ? String(flags[flag]) : undefined;
    const prompt = text("prompt");
    const threadId = text("thread");
    const project = text("project");
    const title = text("title");
    const theme = text("theme");
    const model = text("model");
    if (theme !== undefined && !isTuiThemeId(theme)) return undefined;
    const mode = text("mode") ?? "auto";
    if (mode !== "chat" && mode !== "work" && mode !== "code" && mode !== "auto") return undefined;
    return {
      action: "agent",
      ...(prompt === undefined ? {} : { prompt }),
      ...(threadId === undefined ? {} : { threadId }),
      ...(project === undefined ? {} : { project }),
      ...(title === undefined ? {} : { title }),
      ...(model === undefined ? {} : { model }),
      json: flags.json === true,
      plain: flags.plain === true,
      last: flags.last === true,
      quiet: flags.quiet === true,
      mode,
      ...(theme === undefined ? {} : { theme }),
    };
  }
  if (command === "harness") {
    const [action, threadId] = positional;
    if (Object.keys(flags).some((flag) => flag !== "json")) return undefined;
    if (action === "slots" && positional.length === 1) {
      return { action: "harness-slots", json: flags.json === true };
    }
    if (action === "session" && threadId !== undefined && positional.length === 2) {
      return { action: "harness-session", threadId, json: flags.json === true };
    }
  }
  return undefined;
}

/** One reader over stdin shared by the prompt loop and the questions a turn asks. */
interface LineSource {
  readonly next: () => Promise<string | undefined>;
  readonly close: () => void;
}

function lineSource(stdin: NodeJS.ReadableStream): LineSource {
  const lines = createInterface({ input: stdin, terminal: false });
  const queue: string[] = [];
  const waiters: Array<(line: string | undefined) => void> = [];
  let closed = false;
  lines.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter !== undefined) waiter(line);
    else queue.push(line);
  });
  lines.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter(undefined);
  });
  return {
    next: () =>
      new Promise((resolve) => {
        const queued = queue.shift();
        if (queued !== undefined) resolve(queued);
        else if (closed) resolve(undefined);
        else waiters.push(resolve);
      }),
    close: () => lines.close(),
  };
}

export interface RunAgentCliCommandInput {
  readonly command: AgentCliCommand;
  readonly session: OpenedLocalControlSession;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: { readonly write: (chunk: string) => unknown };
  readonly stderr: { readonly write: (chunk: string) => unknown };
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
  /** Whether stdout is a terminal that can draw the full screen. */
  readonly interactive?: boolean;
}

/**
 * `octant agent`: a thread on this host, driven from the terminal.
 *
 * The CLI is an ordinary client of the same routes the app uses. It creates
 * or attaches to a Chat thread, sends each prompt as a turn, prints the reply
 * as it lands in the journal, and reads the thread's harness session for
 * `/session`. There is no private session store: everything it shows is what
 * the web and the phone would show for the same thread.
 */
export async function runAgentCliCommand(input: RunAgentCliCommandInput): Promise<number> {
  if (input.command.action === "harness-slots") {
    const response = await input.session.send({
      path: "/api/native-harness/routing",
      method: "GET",
    });
    if (response.status !== 200) {
      input.stderr.write(
        `${failureMessage(response, "Model slots are unavailable on this host.")}\n`,
      );
      return 1;
    }
    const settings = decodeNativeHarnessRoutingSettings(
      (response.body as { settings: unknown }).settings,
    );
    if (input.command.json) {
      input.stdout.write(`${JSON.stringify(settings)}\n`);
      return 0;
    }
    if (settings.configuration.slots.length === 0) {
      input.stdout.write(
        "No model slots are configured. Configure them in Settings → Octant Harness.\n",
      );
    }
    for (const slot of settings.configuration.slots) {
      input.stdout.write(`${slot.id}\n`);
      slot.candidates.forEach((candidate, index) => {
        input.stdout.write(
          `  ${index === 0 ? "primary " : "fallback"} ${String(candidate.modelId)} (${String(candidate.providerInstanceId)})\n`,
        );
      });
    }
    for (const binding of settings.configuration.jobSlots) {
      input.stdout.write(`${binding.job} → ${binding.slotId}\n`);
    }
    return 0;
  }
  if (input.command.action === "harness-session") {
    const view = await readSession(input, input.command.threadId);
    if (view === "unavailable") return 1;
    if (input.command.json) {
      input.stdout.write(`${JSON.stringify({ view })}\n`);
      return 0;
    }
    if (view === null) {
      input.stdout.write("This thread has no native harness session.\n");
      return 0;
    }
    printSession(view, input.stdout);
    return 0;
  }

  const threadId = await resolveThread(input);
  if (threadId === undefined) return 1;
  if (input.command.json) input.stdout.write(`${JSON.stringify({ kind: "thread", threadId })}\n`);
  else input.stdout.write(`Thread ${threadId}\n`);

  if (
    input.command.prompt === undefined &&
    !input.command.json &&
    !input.command.plain &&
    input.interactive === true
  ) {
    const exit = await runAgentTui({
      session: input.session,
      threadId,
      themeId: input.command.theme,
      quiet: input.command.quiet,
      mode: modeOf(input.command),
      ...(input.pollIntervalMs === undefined ? {} : { pollIntervalMs: input.pollIntervalMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (exit !== "unavailable") return exit;
    input.stderr.write("The terminal UI is unavailable here; continuing in line mode.\n");
  }
  const lines = lineSource(input.stdin);
  try {
    if (input.command.prompt !== undefined) {
      return (await runTurn(input, threadId, input.command.prompt, lines)) ? 0 : 1;
    }
    input.stdout.write(
      "Type a prompt and press Enter. /session shows the harness session; /next N takes a suggested follow-up; /pause and /resume hold or release the run; /side asks Side Chat, which only reads; /goal shows the goal and /goal revise changes its objective; /fork forks at the last reply; /checkpoint marks it, /checkpoints lists them, /restore N starts a thread from one; /quit exits.\n",
    );
    for (;;) {
      const line = await lines.next();
      if (line === undefined) break;
      const prompt = line.trim();
      if (prompt.length === 0) continue;
      if (prompt === "/quit" || prompt === "/exit") break;
      if (prompt === "/session") {
        const view = await readSession(input, threadId);
        if (view === null || view === "unavailable")
          input.stdout.write("No harness session yet.\n");
        else printSession(view, input.stdout);
        continue;
      }
      if (prompt === "/pause" || prompt === "/resume") {
        await pauseOrResume(input, threadId, prompt === "/pause" ? "pause" : "resume");
        continue;
      }
      if (prompt === "/next" || prompt.startsWith("/next ")) {
        await takeFollowUp(input, threadId, prompt.slice("/next".length).trim(), lines);
        continue;
      }
      if (prompt === "/side" || prompt.startsWith("/side ")) {
        await askSideChat(input, threadId, prompt.slice("/side".length).trim(), lines);
        continue;
      }
      if (prompt === "/goal" || prompt.startsWith("/goal ")) {
        await goalCommand(input, threadId, prompt.slice("/goal".length).trim());
        continue;
      }
      if (
        prompt === "/fork" ||
        prompt === "/checkpoints" ||
        prompt === "/checkpoint" ||
        prompt.startsWith("/checkpoint ") ||
        prompt.startsWith("/restore")
      ) {
        await branchCommand(input, threadId, prompt);
        continue;
      }
      await runTurn(input, threadId, prompt, lines);
    }
    return 0;
  } finally {
    lines.close();
  }
}

/**
 * Asks the thread's Side Chat and prints its answer. The question and answer
 * live in that separate, read-only Chat, never in the thread itself.
 */
async function askSideChat(
  input: RunAgentCliCommandInput,
  threadId: string,
  question: string,
  lines: LineSource,
): Promise<void> {
  if (question.length === 0) {
    input.stderr.write("Ask a question: /side what is it changing?\n");
    return;
  }
  const opened = await openAgentSideChat(input.session, threadId);
  if (opened.kind === "refused") {
    input.stderr.write(`${opened.message}\n`);
    return;
  }
  await runTurn(input, String(opened.sidecar.sidecarThreadId), question, lines, "chat");
}

/**
 * Forks and checkpoints. Each one that creates a thread names it and how to
 * continue it; this session stays on the thread it was started with.
 */
async function branchCommand(
  input: RunAgentCliCommandInput,
  threadId: string,
  prompt: string,
): Promise<void> {
  const snapshot = await agentThreadPort(input.session, modeOf(input.command), threadId).read();
  if (snapshot === undefined) {
    input.stderr.write("The thread could not be read.\n");
    return;
  }
  const created = (result: AgentBranchResult) => {
    if (result.kind === "refused") input.stderr.write(`${result.message}\n`);
    else
      input.stdout.write(
        `Created ${result.mode} thread ${result.threadId}. Continue it with: octant agent --thread ${result.threadId}\n`,
      );
  };
  if (prompt === "/fork") {
    created(await forkAgentThread(input.session, snapshot));
    return;
  }
  if (prompt === "/checkpoint" || prompt.startsWith("/checkpoint ")) {
    const label = prompt.slice("/checkpoint".length).trim() || defaultCheckpointLabel();
    const marked = await markAgentCheckpoint(input.session, snapshot, label);
    if (marked.kind === "refused") input.stderr.write(`${marked.message}\n`);
    else input.stdout.write(`Marked checkpoint "${marked.checkpoint.label}".\n`);
    return;
  }
  const listed = await listAgentCheckpoints(input.session, threadId);
  if (listed.kind === "refused") {
    input.stderr.write(`${listed.message}\n`);
    return;
  }
  if (prompt === "/checkpoints") {
    if (listed.checkpoints.length === 0)
      input.stdout.write("No checkpoints yet. /checkpoint marks the last reply.\n");
    listed.checkpoints.forEach((checkpoint, index) =>
      input.stdout.write(`  ${index + 1}. ${checkpoint.label} · ${checkpoint.markedAt}\n`),
    );
    return;
  }
  const picked = listed.checkpoints[Number(prompt.slice("/restore".length).trim()) - 1];
  if (picked === undefined) {
    input.stderr.write("Pick a checkpoint by number from /checkpoints: /restore 1\n");
    return;
  }
  created(
    await restoreAgentCheckpoint(input.session, picked, `${snapshot.title} (${picked.label})`),
  );
}

/** Shows the goal, or revises its objective against the version just read. */
async function goalCommand(
  input: RunAgentCliCommandInput,
  threadId: string,
  argument: string,
): Promise<void> {
  const read = await readAgentGoal(input.session, threadId);
  if (read.kind === "refused") {
    input.stderr.write(`${read.message}\n`);
    return;
  }
  if (read.goal === null) {
    input.stdout.write("This thread has no goal.\n");
    return;
  }
  const revise = /^revise\s+(.+)$/s.exec(argument);
  if (revise === null) {
    if (argument.length > 0)
      input.stderr.write("Revise the objective with: /goal revise <new objective>\n");
    else input.stdout.write(`${describeAgentGoal(read.goal)}\n`);
    return;
  }
  const revised = await reviseAgentGoal(input.session, read.goal, (revise[1] ?? "").trim());
  if (revised.kind === "refused") input.stderr.write(`${revised.message}\n`);
  else if (revised.kind === "stale") {
    const now = await readAgentGoal(input.session, threadId);
    input.stderr.write(
      `The goal changed on another screen first; nothing was revised. Now: ${
        now.kind === "goal" && now.goal !== null ? describeAgentGoal(now.goal) : "unreadable"
      }\n`,
    );
  } else input.stdout.write("Goal revised.\n");
}

/** Holds or releases the harness session; a held session refuses the next turn. */
async function pauseOrResume(
  input: RunAgentCliCommandInput,
  threadId: string,
  action: "pause" | "resume",
): Promise<void> {
  const view = await readSession(input, threadId);
  if (view === null || view === "unavailable") {
    input.stdout.write("No harness session yet.\n");
    return;
  }
  const response = await input.session.send({
    path: `/api/native-harness/sessions/${encodeURIComponent(threadId)}/commands`,
    method: "POST",
    body: {
      kind: action === "pause" ? "pause-native-harness-session" : "resume-native-harness-session",
      sessionId: String(view.session.id),
      expectedVersion: view.session.version,
    },
  });
  if (response.status !== 200) {
    input.stderr.write(`${failureMessage(response, `The session could not be ${action}d.`)}\n`);
    return;
  }
  input.stdout.write(action === "pause" ? "Paused.\n" : "Resumed.\n");
}

/**
 * Takes one of the lead's suggested follow-ups: shows what it would create,
 * asks for a plain yes, and only then activates it. A same-thread follow-up
 * runs here at once; a new thread is created on the host and named so the
 * person can continue there.
 */
async function takeFollowUp(
  input: RunAgentCliCommandInput,
  threadId: string,
  argument: string,
  lines: LineSource,
): Promise<void> {
  const view = await readSession(input, threadId);
  if (view === null || view === "unavailable" || view.followUps === undefined) {
    input.stdout.write("No follow-ups have been suggested yet.\n");
    return;
  }
  const suggestion = /^\d+$/.test(argument)
    ? view.followUps.suggestions[Number(argument) - 1]
    : undefined;
  if (suggestion === undefined) {
    view.followUps.suggestions.forEach((entry, index) =>
      input.stdout.write(`  ${index + 1}. ${entry.title} [${entry.target}]\n`),
    );
    input.stdout.write("Pick one by number: /next 1\n");
    return;
  }
  const base = `/api/native-harness/sessions/${encodeURIComponent(threadId)}/follow-ups`;
  const previewed = await input.session.send({
    path: `${base}/preview`,
    method: "POST",
    body: { suggestionId: String(suggestion.id) },
  });
  if (previewed.status !== 200) {
    input.stderr.write(`${failureMessage(previewed, "The follow-up could not be previewed.")}\n`);
    return;
  }
  const preview = decodeNativeHarnessFollowUpPreview(
    (previewed.body as { preview?: unknown }).preview,
  );
  const target =
    preview.wouldCreate.kind === "same-thread"
      ? "continues in this thread"
      : preview.wouldCreate.kind === "new-thread"
        ? `starts a new ${preview.wouldCreate.mode} thread`
        : "starts a new Code thread on its own worktree";
  input.stdout.write(`${suggestion.title} — ${target}\n${suggestion.prompt}\nGo ahead? [y/N] `);
  const answer = (await lines.next())?.trim() ?? "";
  if (!/^y(es)?$/i.test(answer)) {
    input.stdout.write("Left as a suggestion.\n");
    return;
  }
  const activated = await input.session.send({
    path: `${base}/activate`,
    method: "POST",
    body: {
      turnId: String(view.followUps.turnId),
      suggestionId: String(suggestion.id),
      confirmed: true,
    },
  });
  const result = decodeNativeHarnessFollowUpActivationResult(activated.body);
  if (result.kind !== "follow-up-activated") {
    input.stderr.write(`${result.message}\n`);
    return;
  }
  if (result.created.kind === "same-thread") {
    await runTurn(input, threadId, suggestion.prompt, lines);
    return;
  }
  if (input.command.json) {
    input.stdout.write(`${JSON.stringify({ kind: "follow-up", created: result.created })}\n`);
    return;
  }
  if (result.created.threadId === undefined) {
    input.stdout.write("Activated; the host created no thread to attach to.\n");
    return;
  }
  input.stdout.write(
    `Created ${result.created.mode} thread ${result.created.threadId}. Continue there with:\n  octant agent --thread ${result.created.threadId} --prompt ${JSON.stringify(suggestion.prompt)}\n`,
  );
}

/** A gated tool call is allowed or refused from the terminal: y, a (always this session), or n. */
async function decidePendingApproval(
  input: RunAgentCliCommandInput,
  threadId: string,
  approval: NonNullable<NativeHarnessSessionView["approvals"]>[number],
  lines: LineSource,
): Promise<void> {
  if (input.command.json) {
    input.stdout.write(`${JSON.stringify({ kind: "approval", approval })}\n`);
  } else {
    input.stdout.write(
      `\n! ${approval.toolName} wants to ${approval.summary} (${approval.approvalClass})\n  allow? [y]es / [a]lways this session / [n]o > `,
    );
  }
  const line = (await lines.next())?.trim().toLowerCase() ?? "";
  const decision =
    line === "y" || line === "yes" || line === "approve"
      ? "approve"
      : line === "a" || line === "always" || line === "approve-always"
        ? "approve-always"
        : "deny";
  await input.session.send({
    path: `/api/native-harness/sessions/${encodeURIComponent(threadId)}/approvals`,
    method: "POST",
    body: { approvalId: String(approval.id), decision },
  });
}

/**
 * A pending question is answered from the same terminal the prompt came
 * from: the options are numbered so a digit picks one, and any other line is
 * the answer itself. In JSON mode the question is emitted as a line and the
 * answer is read the same way, so a script can answer too.
 */
async function answerPendingQuestion(
  input: RunAgentCliCommandInput,
  threadId: string,
  question: NativeHarnessSessionView["questions"][number],
  lines: LineSource,
): Promise<void> {
  if (input.command.json) {
    input.stdout.write(`${JSON.stringify({ kind: "question", question })}\n`);
  } else {
    input.stdout.write(`\n? ${question.prompt}\n`);
    question.options.forEach((option, index) => input.stdout.write(`  ${index + 1}. ${option}\n`));
    input.stdout.write("> ");
  }
  const line = await lines.next();
  if (line === undefined) return;
  const trimmed = line.trim();
  const picked = /^\d+$/.test(trimmed) ? question.options[Number(trimmed) - 1] : undefined;
  const answer = picked ?? trimmed;
  if (answer.length === 0) return;
  await input.session.send({
    path: `/api/native-harness/sessions/${encodeURIComponent(threadId)}/questions`,
    method: "POST",
    body: { questionId: String(question.id), answer },
  });
}

async function readSession(
  input: RunAgentCliCommandInput,
  threadId: string,
  quiet = false,
): Promise<NativeHarnessSessionView | null | "unavailable"> {
  const response = await input.session.send({
    path: `/api/native-harness/sessions/${encodeURIComponent(threadId)}`,
    method: "GET",
  });
  if (response.status !== 200) {
    if (!quiet) {
      input.stderr.write(`${failureMessage(response, "The harness session is unavailable.")}\n`);
    }
    return "unavailable";
  }
  const view = (response.body as { view?: unknown }).view;
  return view === null || view === undefined ? null : decodeNativeHarnessSessionView(view);
}

async function resolveThread(input: RunAgentCliCommandInput): Promise<string | undefined> {
  if (input.command.action !== "agent") return undefined;
  if (
    (input.command.threadId !== undefined || input.command.last) &&
    input.command.mode !== "chat"
  ) {
    // A Work or Code thread is driven by what this terminal's window has
    // open, and its mode is the thread's own, never a guess from flags.
    const attached = await attachAgentThread(input.session, {
      threadId: input.command.threadId,
      mode: input.command.mode,
      projectName: input.command.project,
    });
    if (attached.kind === "refused") {
      input.stderr.write(`${attached.message}\n`);
      return undefined;
    }
    if (attached.kind === "attached") {
      resolvedMode = attached.mode;
      if (!input.command.json) {
        input.stdout.write(
          `Continuing ${attached.mode === "code" ? "Code" : "Work"} thread in ${attached.projectName}.\n`,
        );
      }
      return attached.threadId;
    }
    if (input.command.mode !== "auto") {
      input.stderr.write(
        input.command.threadId === undefined
          ? `There is no ${input.command.mode === "code" ? "Code" : "Work"} thread to continue in this folder's Project.\n`
          : `No ${input.command.mode === "code" ? "Code" : "Work"} thread ${input.command.threadId} on this host.\n`,
      );
      return undefined;
    }
  }
  if (input.command.threadId !== undefined) {
    resolvedMode = "chat";
    return input.command.threadId;
  }
  if (input.command.last) {
    const latest = (await listAgentThreads(input.session))[0];
    if (latest === undefined) {
      input.stderr.write("There is no Chat thread to continue yet.\n");
      return undefined;
    }
    return String(latest.id);
  }
  const created = await createAgentThread(input.session, {
    mode: input.command.mode,
    title:
      input.command.title ?? `Agent ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
    projectName: input.command.project,
    model: input.command.model,
  });
  if (created.kind === "refused") {
    input.stderr.write(`${created.message}\n`);
    return undefined;
  }
  resolvedMode = created.mode;
  if (!input.command.json) {
    input.stdout.write(
      created.mode === "chat"
        ? "New Chat thread.\n"
        : `New ${created.mode === "code" ? "Code" : "Work"} thread in ${created.projectName ?? "the Project"}.\n`,
    );
  }
  return created.threadId;
}

/** The mode a thread created under `auto` turned out to be in. */
let resolvedMode: "chat" | "work" | "code" | undefined;

function modeOf(command: AgentCliCommand): "chat" | "work" | "code" {
  if (command.action !== "agent") return "chat";
  // The thread's own mode, once known, wins over the flag that found it.
  if (resolvedMode !== undefined) return resolvedMode;
  if (command.mode !== "auto") return command.mode;
  return "chat";
}

async function runTurn(
  input: RunAgentCliCommandInput,
  threadId: string,
  prompt: string,
  lines: LineSource,
  mode: OctantMode = modeOf(input.command),
): Promise<boolean> {
  const port = agentThreadPort(input.session, mode, threadId);
  // Follow the thread before sending so the first words of the reply wake
  // the read that prints them.
  const wake = new AgentWake();
  const feed = new AbortController();
  const stopFeed = () => feed.abort();
  input.signal?.addEventListener("abort", stopFeed, { once: true });
  followAgentThread(input.session, mode, threadId, wake, feed.signal);
  try {
    return await followTurn(input, threadId, prompt, lines, port, wake, feed.signal);
  } finally {
    input.signal?.removeEventListener("abort", stopFeed);
    feed.abort();
  }
}

async function followTurn(
  input: RunAgentCliCommandInput,
  threadId: string,
  prompt: string,
  lines: LineSource,
  port: AgentThreadPort,
  wake: AgentWake,
  signal: AbortSignal,
): Promise<boolean> {
  // A Chat send answers only once its turn has ended, so waiting on it would
  // hold the whole reply back. Send alongside the reads instead, and ignore
  // the thread's earlier turn until this one shows up.
  const before = (await port.read())?.turns.at(-1)?.id;
  let sent: Awaited<ReturnType<AgentThreadPort["send"]>> | undefined;
  void port
    .send(prompt)
    .catch(() => ({ kind: "refused" as const, message: "The host refused the turn." }))
    .then((result) => {
      sent = result;
      wake.notify();
    });
  let printed = "";
  // Harness questions and approvals have no stream; this is how long one can
  // wait unseen while the reply itself is quiet.
  const fallback = input.pollIntervalMs ?? 1_000;
  const answered = new Set<string>();
  for (;;) {
    if (input.signal?.aborted) return false;
    await wake.next(fallback, signal);
    if (input.signal?.aborted) return false;
    if (sent?.kind === "refused") {
      input.stderr.write(`${sent.message}\n`);
      return false;
    }
    const session = await readSession(input, threadId, true);
    const pending =
      session === null || session === "unavailable"
        ? undefined
        : session.questions.find(
            (question) => question.status === "pending" && !answered.has(String(question.id)),
          );
    if (pending !== undefined) {
      answered.add(String(pending.id));
      await answerPendingQuestion(input, threadId, pending, lines);
    }
    const approval =
      session === null || session === "unavailable"
        ? undefined
        : session.approvals?.find(
            (entry) => entry.status === "pending" && !answered.has(String(entry.id)),
          );
    if (approval !== undefined) {
      answered.add(String(approval.id));
      await decidePendingApproval(input, threadId, approval, lines);
    }
    const current = await port.read();
    if (current === undefined) continue;
    const turn = current.turns.at(-1);
    if (turn?.id === before && sent === undefined) continue;
    const text = turn?.reply ?? "";
    if (text.length > printed.length && text.startsWith(printed)) {
      const delta = text.slice(printed.length);
      if (input.command.json)
        input.stdout.write(`${JSON.stringify({ kind: "delta", text: delta })}\n`);
      else input.stdout.write(delta);
      printed = text;
    }
    if (turn === undefined || sent === undefined || isAgentSnapshotRunning(current)) continue;
    if (input.command.json) {
      input.stdout.write(
        `${JSON.stringify({
          kind: "outcome",
          outcome: turn.outcome,
          text,
          ...(turn.inputTokens === undefined ? {} : { usage: { inputTokens: turn.inputTokens } }),
        })}\n`,
      );
    } else {
      if (!printed.endsWith("\n")) input.stdout.write("\n");
      if (turn.outcome !== "completed") input.stderr.write(`Turn ended: ${turn.outcome}.\n`);
    }
    return turn.outcome === "completed";
  }
}

function printSession(
  view: NativeHarnessSessionView,
  stdout: RunAgentCliCommandInput["stdout"],
): void {
  stdout.write(
    `Session ${nativeHarnessStatusLabel(view.session.status)} · lead ${String(view.session.lead.modelId)} on ${String(view.session.leadSlotId)} · ${view.session.turnsRun} turns · ${view.session.cutovers} context cuts\n`,
  );
  if (view.session.detail !== undefined) stdout.write(`  ${view.session.detail}\n`);
  for (const route of view.routes.slice(-5)) {
    const model = "candidate" in route ? String(route.candidate.modelId) : "—";
    stdout.write(`  route ${route.job} → ${route.slotId}: ${route.kind} (${model})\n`);
  }
  for (const intervention of view.interventions.slice(-5)) {
    const detail =
      intervention.kind === "redirect"
        ? intervention.instruction
        : intervention.kind === "second-opinion"
          ? intervention.answer
          : intervention.reason;
    stdout.write(`  advisor ${intervention.kind}: ${detail}\n`);
  }
  if (view.followUps !== undefined && view.followUps.suggestions.length > 0) {
    stdout.write("  suggested next:\n");
    view.followUps.suggestions.forEach((suggestion, index) => {
      const done = view.activatedFollowUpIds.includes(suggestion.id) ? " (activated)" : "";
      stdout.write(`    ${index + 1}. ${suggestion.title} [${suggestion.target}]${done}\n`);
    });
  }
}
