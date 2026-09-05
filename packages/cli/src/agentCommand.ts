import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  decodeChatCommandResult,
  decodeChatThreadView,
  decodeNativeHarnessRoutingSettings,
  decodeNativeHarnessFollowUpActivationResult,
  decodeNativeHarnessFollowUpPreview,
  decodeNativeHarnessSessionView,
  decodeProjectBootstrap,
  type ChatThreadView,
  type NativeHarnessSessionView,
} from "@octant/contracts";
import { runAgentTui } from "./agentTui";
import { isTuiThemeId, type TuiThemeId } from "./agentTuiModel";
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
    if (theme !== undefined && !isTuiThemeId(theme)) return undefined;
    return {
      action: "agent",
      ...(prompt === undefined ? {} : { prompt }),
      ...(threadId === undefined ? {} : { threadId }),
      ...(project === undefined ? {} : { project }),
      ...(title === undefined ? {} : { title }),
      json: flags.json === true,
      plain: flags.plain === true,
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
      input.stdout.write("No model slots are configured. Configure them in Settings → Agents.\n");
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
      "Type a prompt and press Enter. /session shows the harness session; /next N takes a suggested follow-up; /pause and /resume hold or release the run; /quit exits.\n",
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
      await runTurn(input, threadId, prompt, lines);
    }
    return 0;
  } finally {
    lines.close();
  }
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
  if (input.command.threadId !== undefined) return input.command.threadId;
  let projectId: string | undefined;
  if (input.command.project !== undefined) {
    const bootstrap = await input.session.send({ path: "/api/projects/bootstrap", method: "GET" });
    if (bootstrap.status !== 200) {
      input.stderr.write(
        `${failureMessage(bootstrap, "Projects are unavailable on this host.")}\n`,
      );
      return undefined;
    }
    const projects = decodeProjectBootstrap(bootstrap.body).active;
    const wanted = input.command.project.trim().toLowerCase();
    const project = projects.find((entry) => entry.name.trim().toLowerCase() === wanted);
    if (project === undefined) {
      input.stderr.write(`No Project named "${input.command.project}" on this host.\n`);
      return undefined;
    }
    projectId = String(project.id);
  }
  const response = await input.session.send({
    path: "/api/chat/commands",
    method: "POST",
    body: {
      kind: "create-chat-thread",
      title:
        input.command.title ?? `Agent ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
      ...(projectId === undefined ? {} : { projectId }),
    },
  });
  if (response.status !== 200) {
    input.stderr.write(`${failureMessage(response, "The host did not create a thread.")}\n`);
    return undefined;
  }
  const created = decodeChatCommandResult(response.body);
  if (created.kind !== "thread-created") {
    input.stderr.write("The host did not create a thread.\n");
    return undefined;
  }
  return String(created.thread.id);
}

async function readThread(
  input: RunAgentCliCommandInput,
  threadId: string,
): Promise<ChatThreadView | undefined> {
  const response = await input.session.send({
    path: `/api/chat/threads/${encodeURIComponent(threadId)}`,
    method: "GET",
  });
  if (response.status !== 200) return undefined;
  return decodeChatThreadView(response.body);
}

async function runTurn(
  input: RunAgentCliCommandInput,
  threadId: string,
  prompt: string,
  lines: LineSource,
): Promise<boolean> {
  const view = await readThread(input, threadId);
  if (view === undefined) {
    input.stderr.write("The thread could not be read.\n");
    return false;
  }
  const sent = await input.session.send({
    path: "/api/chat/commands",
    method: "POST",
    body: {
      kind: "send-chat-turn",
      threadId,
      expectedVersion: view.thread.version,
      prompt,
      submissionId: randomUUID(),
    },
  });
  if (sent.status !== 200) {
    input.stderr.write(`${failureMessage(sent, "The host refused the turn.")}\n`);
    return false;
  }
  let printed = "";
  const interval = input.pollIntervalMs ?? 400;
  const answered = new Set<string>();
  for (;;) {
    if (input.signal?.aborted) return false;
    await new Promise((resolve) => setTimeout(resolve, interval));
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
    const current = await readThread(input, threadId);
    if (current === undefined) continue;
    const attempt = current.turns.at(-1)?.attempts.at(-1);
    const text = replyText(current);
    if (text.length > printed.length && text.startsWith(printed)) {
      const delta = text.slice(printed.length);
      if (input.command.json)
        input.stdout.write(`${JSON.stringify({ kind: "delta", text: delta })}\n`);
      else input.stdout.write(delta);
      printed = text;
    }
    if (attempt === undefined) continue;
    if (attempt.outcome === "queued" || attempt.outcome === "streaming") continue;
    if (input.command.json) {
      input.stdout.write(
        `${JSON.stringify({
          kind: "outcome",
          outcome: attempt.outcome,
          text,
          ...(attempt.usage === undefined ? {} : { usage: attempt.usage }),
        })}\n`,
      );
    } else {
      if (!printed.endsWith("\n")) input.stdout.write("\n");
      if (attempt.outcome !== "completed") input.stderr.write(`Turn ended: ${attempt.outcome}.\n`);
    }
    return attempt.outcome === "completed";
  }
}

/** The latest assistant reply, from the content the latest attempt references. */
function replyText(view: ChatThreadView): string {
  const attempt = view.turns.at(-1)?.attempts.at(-1);
  if (attempt === undefined) return "";
  const bodies = new Map(view.contents.map((content) => [String(content.contentId), content.body]));
  return attempt.responseRefs.map((ref) => bodies.get(String(ref.contentId)) ?? "").join("");
}

function printSession(
  view: NativeHarnessSessionView,
  stdout: RunAgentCliCommandInput["stdout"],
): void {
  stdout.write(
    `Session ${view.session.status} · lead ${String(view.session.lead.modelId)} on ${String(view.session.leadSlotId)} · ${view.session.turnsRun} turns · ${view.session.cutovers} context cuts\n`,
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
