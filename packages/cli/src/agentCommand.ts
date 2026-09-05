import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import {
  decodeChatCommandResult,
  decodeChatThreadView,
  decodeNativeHarnessRoutingSettings,
  decodeNativeHarnessSessionView,
  decodeProjectBootstrap,
  type ChatThreadView,
  type NativeHarnessSessionView,
} from "@octant/contracts";
import { failureMessage, type OpenedLocalControlSession } from "./localControl";

export type AgentCliCommand =
  | {
      readonly action: "agent";
      readonly prompt?: string;
      readonly threadId?: string;
      readonly project?: string;
      readonly title?: string;
      readonly json: boolean;
    }
  | { readonly action: "harness-slots"; readonly json: boolean }
  | { readonly action: "harness-session"; readonly threadId: string; readonly json: boolean };

const AGENT_FLAGS: ReadonlyArray<string> = ["prompt", "thread", "project", "title", "json"];

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
    return {
      action: "agent",
      ...(prompt === undefined ? {} : { prompt }),
      ...(threadId === undefined ? {} : { threadId }),
      ...(project === undefined ? {} : { project }),
      ...(title === undefined ? {} : { title }),
      json: flags.json === true,
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

export interface RunAgentCliCommandInput {
  readonly command: AgentCliCommand;
  readonly session: OpenedLocalControlSession;
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: { readonly write: (chunk: string) => unknown };
  readonly stderr: { readonly write: (chunk: string) => unknown };
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
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

  if (input.command.prompt !== undefined) {
    return (await runTurn(input, threadId, input.command.prompt)) ? 0 : 1;
  }

  const lines = createInterface({ input: input.stdin, terminal: false });
  input.stdout.write(
    "Type a prompt and press Enter. /session shows the harness session; /quit exits.\n",
  );
  for await (const line of lines) {
    const prompt = line.trim();
    if (prompt.length === 0) continue;
    if (prompt === "/quit" || prompt === "/exit") break;
    if (prompt === "/session") {
      const view = await readSession(input, threadId);
      if (view === null || view === "unavailable") input.stdout.write("No harness session yet.\n");
      else printSession(view, input.stdout);
      continue;
    }
    await runTurn(input, threadId, prompt);
  }
  return 0;
}

async function readSession(
  input: RunAgentCliCommandInput,
  threadId: string,
): Promise<NativeHarnessSessionView | null | "unavailable"> {
  const response = await input.session.send({
    path: `/api/native-harness/sessions/${encodeURIComponent(threadId)}`,
    method: "GET",
  });
  if (response.status !== 200) {
    input.stderr.write(`${failureMessage(response, "The harness session is unavailable.")}\n`);
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
  for (;;) {
    if (input.signal?.aborted) return false;
    await new Promise((resolve) => setTimeout(resolve, interval));
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
