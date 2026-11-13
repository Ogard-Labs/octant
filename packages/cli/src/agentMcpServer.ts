import { isAbsolute } from "node:path";
import type { PermissionMode } from "@octant/contracts";
import type { HostRefusal } from "./agentHost";
import {
  answerAgentQuestion,
  listRecentAgentThreads,
  listWaitingRequests,
  openAndReadAgentThread,
  projectRow,
  readActiveProjects,
  readAgentThreadState,
  startAgentTurn,
  stopAgentTurn,
  titleFromPrompt,
  waitForAgentTurn,
  type AgentThreadState,
} from "./agentStart";
import {
  agentThreadPort,
  createAgentThread,
  openAgentThreadById,
  projectHolding,
} from "./agentThread";
import type { LocalControlSession, OpenedLocalControlSession } from "./localControl";
import {
  asObject,
  failure,
  messagesFrom,
  result,
  type JsonObject,
  type JsonRpcId,
} from "./mcpCommand";
import { addProject } from "./projectCommand";

export { stopAgentTurn } from "./agentStart";
export { agentThreadPort, isAgentSnapshotRunning } from "./agentThread";
export type {
  LocalControlRequest,
  LocalControlResponse,
  LocalControlSession,
  OpenedLocalControlSession,
} from "./localControl";

/**
 * `octant agent mcp`: `octant agent` spoken as a stdio MCP server, so another
 * agent (a coding CLI, a bot) can start work in Octant and follow it.
 *
 * It is an ordinary local client, exactly as `octant agent` is: each tool call
 * opens its own short-lived window authority with the host's local secret,
 * goes through the same thread routes as the app, and revokes it when the call
 * (and any send it started) has finished. The host keeps every authority
 * decision. Two rules are this server's own, because its caller is another
 * agent rather than the person: it never answers an approval, and it starts a
 * thread at Full access only for a caller whose grant the person gave Full
 * access (maintainer decision, 2026-11-13). The stdio server holds no grant,
 * so there both stay with the person, in Octant.
 */

export const AGENT_MCP_HELP = [
  "octant agent mcp",
  "",
  "A stdio MCP server that lets another agent start and follow work in Octant on",
  "this computer: start a Chat, Work or Code thread (in a repository's Project when",
  "given a folder), send it more, read where it got to, answer its questions, and",
  "stop it. Approvals and Full access stay with you, in Octant.",
  "",
  "Add it to an MCP client as the command `octant agent mcp`.",
  "",
].join("\n");

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const DEFAULT_WAIT_SECONDS = 600;
const MAX_WAIT_SECONDS = 3_600;
/** A reply longer than this is cut, so one answer cannot flood the caller's context. */
const MAX_REPLY_CHARACTERS = 20_000;

const INSTRUCTIONS =
  "Octant is the person's agent workspace on this computer. start_work opens an agent " +
  "in Octant with a task: pass `folder` (an absolute path) to work in a repository or " +
  "folder, which opens a Code or Work thread in the Octant Project that holds it. The " +
  "thread runs in Octant, where the person sees it and answers its approvals; follow " +
  "it with read_thread, continue it with send_message. Approvals are never answered " +
  "here, and Full access is only turned on by the person in Octant.";

const INCOMPLETE_WAITING =
  "Octant could not list everything waiting on the person, so more may be waiting; the person can see it all in Octant.";

const ACCESS_LEVELS = ["ask-first", "accept-edits", "auto", "plan"] as const;
/** What a caller may name when the person chose Full access for its grant. */
const ACCESS_LEVELS_WITH_FULL_ACCESS = [...ACCESS_LEVELS, "full-access"] as const;

/**
 * Whether a call may name Full access: its grant has it, its grant lacks it,
 * or it has no grant and Full access is the person's alone.
 */
type FullAccessStanding = "in-grant" | "not-in-grant" | "person-only";

const FULL_ACCESS_REFUSALS: Readonly<Record<Exclude<FullAccessStanding, "in-grant">, string>> = {
  "person-only":
    "Full access is only turned on by the person in Octant; start at another level, or ask them to give the Project Full access.",
  "not-in-grant":
    "This agent's grant does not include Full access; start at another level, or ask the person to choose Full access for the grant in Octant.",
};

const WAIT_PROPERTIES = {
  wait: {
    type: "boolean",
    description:
      "Wait for the turn to end, or to need an answer, before replying. Default false: reply as soon as the turn has started.",
  },
  timeoutSeconds: {
    type: "integer",
    minimum: 1,
    maximum: MAX_WAIT_SECONDS,
    description: `How long \`wait\` waits, in seconds (default ${DEFAULT_WAIT_SECONDS}). The turn keeps running after that.`,
  },
} as const;

export const AGENT_MCP_TOOLS: ReadonlyArray<JsonObject> = [
  {
    name: "start_work",
    title: "Start work in Octant",
    description:
      "Open an agent in Octant and give it a task. To work in a repository or folder, pass `folder` " +
      "(absolute path): the thread opens in the Octant Project holding it, a Code thread in a Code " +
      "Project and a Work thread in a Work Project. Without a folder or Project it is a Chat thread. " +
      "Replies with the thread id as soon as the turn starts unless `wait` is true.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task, as the person would type it in Octant." },
        folder: {
          type: "string",
          description: "Absolute path of the repository or folder to work in.",
        },
        project: { type: "string", description: "An Octant Project's name, instead of a folder." },
        mode: {
          type: "string",
          enum: ["auto", "chat", "work", "code"],
          description:
            "auto (default) follows the Project: a Code Project starts a Code thread, a Work Project a Work thread, none a Chat thread.",
        },
        addProject: {
          type: "boolean",
          description:
            "When no Octant Project holds `folder`, add it as one first: a Code Project, or a Work Project for mode work. Set it only when the person asked to work in that folder.",
        },
        title: {
          type: "string",
          description: "The thread's title; the prompt's first line when absent.",
        },
        model: {
          type: "string",
          description: "A model id or `endpoint/model`; Octant's first harness model when absent.",
        },
        access: {
          type: "string",
          enum: [...ACCESS_LEVELS],
          description:
            "The level a new Work or Code thread starts at; Octant's own default when absent. Full access is only turned on by the person in Octant.",
        },
        ...WAIT_PROPERTIES,
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "send_message",
    title: "Send to an Octant thread",
    description: "Send the next prompt to an existing Octant thread, continuing its work.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        prompt: { type: "string" },
        ...WAIT_PROPERTIES,
      },
      required: ["threadId", "prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "read_thread",
    title: "Read an Octant thread",
    description:
      "Where an Octant thread got to: running, waiting for an answer, waiting on the person in Octant, or idle; its newest turns; the questions you may answer with answer_question; and what only the person answers in Octant.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        turns: {
          type: "integer",
          minimum: 1,
          maximum: 20,
          description: "How many of the newest turns to include (default 1).",
        },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
  {
    name: "answer_question",
    title: "Answer an Octant thread's question",
    description:
      "Answer a question an Octant thread's agent asked, by the questionId read_thread lists. Approvals are not questions: the person answers them in Octant.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        questionId: { type: "string" },
        answer: { type: "string", description: "One of the listed options, or free text." },
      },
      required: ["threadId", "questionId", "answer"],
      additionalProperties: false,
    },
  },
  {
    name: "stop_turn",
    title: "Stop an Octant thread's turn",
    description:
      "Stop the turn an Octant thread is running. The thread stays and can be continued.",
    inputSchema: {
      type: "object",
      properties: { threadId: { type: "string" } },
      required: ["threadId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_projects",
    title: "List Octant Projects",
    description: "The person's active Octant Projects, with each one's type and folder.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "add_project",
    title: "Add an Octant Project",
    description:
      "Add a folder as an Octant Project, so threads can work in it. Code for a repository, Work for other folders. Only when the person asked to work in that folder.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Absolute path of the folder." },
        type: { type: "string", enum: ["code", "work"], description: "Default code." },
        name: { type: "string", description: "The Project's name; the folder's name when absent." },
      },
      required: ["folder"],
      additionalProperties: false,
    },
  },
  {
    name: "list_waiting",
    title: "List what waits on the person in Octant",
    description:
      "Everything waiting on the person across Octant, oldest first: approvals, questions and decisions, each with its thread. Rows marked answerableHere are questions answer_question can answer once read_thread gives their questionId; the rest only the person answers, in Octant.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_threads",
    title: "List Octant threads",
    description:
      "Active Octant threads, newest first: one Project's when `folder` or `project` is given, otherwise every Project's and the Chat threads.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Absolute path inside a Project's folder." },
        project: { type: "string", description: "An Octant Project's name." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20." },
      },
      additionalProperties: false,
    },
  },
];

export interface AgentMcpPorts {
  /** Opens one local window authority on the running host, starting it where allowed. */
  readonly openSession: () => Promise<LocalControlSession>;
  /** The caller's messages, one JSON message per line. */
  readonly input: AsyncIterable<string | Uint8Array>;
  /** Protocol frames only. */
  readonly stdout: { readonly write: (chunk: string) => unknown };
  /** Everything a person should read. */
  readonly stderr: { readonly write: (chunk: string) => unknown };
  readonly version: string;
  readonly pollIntervalMs?: number;
}

export interface ToolAnswer {
  readonly value: JsonObject | string;
  readonly isError: boolean;
  /** A send still running under this call's session; the session closes after it. */
  readonly keepOpenUntil?: Promise<void>;
}

/**
 * How a host narrows the tools for a caller that is not the person at this
 * host (an outside agent under an agent grant). Every rule here is also
 * enforced where the host dispatches each request; the policy gives the caller
 * a plain refusal before a request is even made.
 */
export interface AgentToolPolicy {
  readonly tools: ReadonlySet<string>;
  readonly projectAllowed: (projectId: string) => boolean;
  readonly threadAllowed: (threadId: string) => boolean;
  /** The level a new Work or Code thread starts at when the call names none. */
  readonly defaultAccess: PermissionMode;
  /** Whether the person chose Full access for this caller's grant, so a call may name it. */
  readonly allowsFullAccess: boolean;
  /**
   * Whether the caller's limits allow another turn now. An admitted turn holds
   * its place against the limits until `release`, which the caller calls once
   * the turn has started or failed to, so turns started at the same moment
   * count each other.
   */
  readonly beforeTurn: (session: OpenedLocalControlSession) => Promise<TurnAdmission>;
}

export type TurnAdmission =
  | { readonly kind: "admitted"; readonly release: () => void }
  | { readonly kind: "refused"; readonly message: string };

export interface AgentToolCallOptions {
  readonly openSession: () => Promise<LocalControlSession>;
  readonly signal: AbortSignal;
  readonly pollIntervalMs?: number;
  readonly policy?: AgentToolPolicy;
}

/** `start_work` as a caller whose grant has Full access sees it: the level is offered. */
const START_WORK_WITH_FULL_ACCESS: JsonObject = withFullAccessOffered(
  AGENT_MCP_TOOLS.find((tool) => tool["name"] === "start_work"),
);

function withFullAccessOffered(tool: JsonObject | undefined): JsonObject {
  const schema = asJsonObject(tool?.["inputSchema"]);
  const properties = asJsonObject(schema["properties"]);
  return {
    ...tool,
    inputSchema: {
      ...schema,
      properties: {
        ...properties,
        access: {
          ...asJsonObject(properties["access"]),
          enum: [...ACCESS_LEVELS_WITH_FULL_ACCESS],
          description:
            "The level a new Work or Code thread starts at; this grant's highest level when absent. The person chose Full access for this grant.",
        },
      },
    },
  };
}

function asJsonObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

/** The tools a caller may see: all of them, or those its policy lists. */
export function agentToolList(policy?: AgentToolPolicy): ReadonlyArray<JsonObject> {
  if (policy === undefined) return AGENT_MCP_TOOLS;
  const listed = AGENT_MCP_TOOLS.filter((tool) => policy.tools.has(String(tool["name"])));
  if (!policy.allowsFullAccess) return listed;
  return listed.map((tool) => (tool["name"] === "start_work" ? START_WORK_WITH_FULL_ACCESS : tool));
}

/** Runs until the caller closes its input. */
export async function runAgentMcpServer(ports: AgentMcpPorts): Promise<number> {
  // Sessions open one at a time, so calls that arrive together while the host
  // is stopped start it once rather than racing to start it twice.
  let opening: Promise<unknown> = Promise.resolve();
  const openSession = (): Promise<LocalControlSession> => {
    const next = opening.then(() => ports.openSession());
    opening = next.catch(() => undefined);
    return next;
  };
  const serving = { ...ports, openSession };
  const running = new Map<string, AbortController>();
  const inFlight = new Set<Promise<void>>();
  const write = (message: JsonObject) => ports.stdout.write(`${JSON.stringify(message)}\n`);
  for await (const message of messagesFrom(ports.input)) {
    if (message.kind === "malformed") {
      write(message.answer);
      continue;
    }
    const { id, method, params } = message;
    if (id === undefined) {
      if (method === "notifications/cancelled") {
        const requestId = params?.["requestId"];
        if (typeof requestId === "string" || typeof requestId === "number") {
          running.get(idKey(requestId))?.abort();
        }
      }
      continue;
    }
    if (method === "initialize") {
      write(result(id, initializeResult(params, ports.version)));
    } else if (method === "ping") {
      write(result(id, {}));
    } else if (method === "tools/list") {
      write(result(id, { tools: AGENT_MCP_TOOLS }));
    } else if (method === "tools/call") {
      const controller = new AbortController();
      running.set(idKey(id), controller);
      const call = answerToolCall(id, params, serving, controller.signal)
        .then((answer) => {
          write(answer);
        })
        .finally(() => running.delete(idKey(id)));
      inFlight.add(call);
      void call.finally(() => inFlight.delete(call));
    } else {
      write(failure(id, -32601, "Method not found"));
    }
  }
  // The caller left: nobody is waiting on a `wait` any more, so end those and
  // let every call close its window before returning.
  for (const controller of running.values()) controller.abort();
  await Promise.all(inFlight);
  return 0;
}

export function initializeResult(params: JsonObject | undefined, version: string): JsonObject {
  const asked = params?.["protocolVersion"];
  return {
    protocolVersion:
      typeof asked === "string" &&
      (SUPPORTED_PROTOCOL_VERSIONS as ReadonlyArray<string>).includes(asked)
        ? asked
        : SUPPORTED_PROTOCOL_VERSIONS[0],
    capabilities: { tools: {} },
    serverInfo: { name: "octant", title: "Octant", version },
    instructions: INSTRUCTIONS,
  };
}

async function answerToolCall(
  id: JsonRpcId,
  params: JsonObject | undefined,
  ports: AgentMcpPorts,
  signal: AbortSignal,
): Promise<JsonObject> {
  const name = params?.["name"];
  const args = asObject(params?.["arguments"]) ?? {};
  if (typeof name !== "string" || !AGENT_MCP_TOOLS.some((tool) => tool["name"] === name)) {
    return failure(id, -32602, `Unknown tool: ${String(name)}`);
  }
  const answer = await callAgentTool(name, args, {
    openSession: ports.openSession,
    signal,
    ...(ports.pollIntervalMs === undefined ? {} : { pollIntervalMs: ports.pollIntervalMs }),
  }).catch(
    (error: unknown): ToolAnswer => ({
      value: `Octant could not finish this call: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    }),
  );
  const text =
    typeof answer.value === "string" ? answer.value : JSON.stringify(answer.value, null, 2);
  return result(id, {
    content: [{ type: "text", text }],
    ...(answer.isError ? { isError: true } : {}),
  });
}

/**
 * One tool call: parse its arguments, open a session, run it, and close the
 * session once the call (and any send it started) has finished. Shared by the
 * stdio server and the host's agent-access endpoint.
 */
export async function callAgentTool(
  name: string,
  args: JsonObject,
  options: AgentToolCallOptions,
): Promise<ToolAnswer> {
  const parsed = parseToolArguments(
    name,
    args,
    options.policy === undefined
      ? "person-only"
      : options.policy.allowsFullAccess
        ? "in-grant"
        : "not-in-grant",
  );
  if (parsed.kind === "invalid") return { value: parsed.message, isError: true };
  if (options.policy !== undefined && !options.policy.tools.has(parsed.call.tool)) {
    return { value: `This agent's grant does not include ${parsed.call.tool}.`, isError: true };
  }
  const session = await options.openSession();
  if (session.kind === "refuses") return { value: session.reason, isError: true };
  let answer: ToolAnswer | undefined;
  try {
    answer = await runTool(parsed.call, session, options);
    return answer;
  } finally {
    if (answer?.keepOpenUntil === undefined) await session.close();
    else void answer.keepOpenUntil.finally(() => session.close());
  }
}

type ToolCall =
  | {
      readonly tool: "start_work";
      readonly prompt: string;
      readonly folder?: string;
      readonly project?: string;
      readonly mode: "auto" | "chat" | "work" | "code";
      readonly addProject: boolean;
      readonly title?: string;
      readonly model?: string;
      readonly access?: PermissionMode;
      readonly wait: boolean;
      readonly timeoutSeconds: number;
    }
  | {
      readonly tool: "send_message";
      readonly threadId: string;
      readonly prompt: string;
      readonly wait: boolean;
      readonly timeoutSeconds: number;
    }
  | { readonly tool: "read_thread"; readonly threadId: string; readonly turns: number }
  | {
      readonly tool: "answer_question";
      readonly threadId: string;
      readonly questionId: string;
      readonly answer: string;
    }
  | { readonly tool: "stop_turn"; readonly threadId: string }
  | { readonly tool: "list_projects" }
  | { readonly tool: "list_waiting" }
  | {
      readonly tool: "add_project";
      readonly folder: string;
      readonly type: "code" | "work";
      readonly name?: string;
    }
  | {
      readonly tool: "list_threads";
      readonly folder?: string;
      readonly project?: string;
      readonly limit: number;
    };

class InvalidArgument extends Error {}

/** Checks a call's arguments against its schema; the host checks everything else. */
export function parseToolArguments(
  name: string,
  args: JsonObject,
  fullAccess: FullAccessStanding = "person-only",
):
  | { readonly kind: "call"; readonly call: ToolCall }
  | { readonly kind: "invalid"; readonly message: string } {
  const text = (key: string, required: boolean): string | undefined => {
    const value = args[key];
    if (value === undefined && !required) return undefined;
    if (typeof value !== "string" || value.trim() === "") {
      throw new InvalidArgument(`\`${key}\` must be a non-empty string.`);
    }
    return value;
  };
  const required = (key: string): string => text(key, true) ?? "";
  const choice = <T extends string>(key: string, options: ReadonlyArray<T>): T | undefined => {
    const value = args[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !(options as ReadonlyArray<string>).includes(value)) {
      // Full access is named on its own so the caller learns why, not just that.
      throw new InvalidArgument(
        key === "access" && value === "full-access" && fullAccess !== "in-grant"
          ? FULL_ACCESS_REFUSALS[fullAccess]
          : `\`${key}\` must be one of: ${options.join(", ")}.`,
      );
    }
    return value as T;
  };
  const flag = (key: string): boolean => {
    const value = args[key];
    if (value === undefined) return false;
    if (typeof value !== "boolean") throw new InvalidArgument(`\`${key}\` must be true or false.`);
    return value;
  };
  const integer = (key: string, fallback: number, max: number): number => {
    const value = args[key];
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
      throw new InvalidArgument(`\`${key}\` must be a whole number from 1 to ${max}.`);
    }
    return value;
  };
  const folder = (): string | undefined => {
    const value = text("folder", false);
    if (value !== undefined && !isAbsolute(value)) {
      throw new InvalidArgument("`folder` must be an absolute path.");
    }
    return value;
  };
  const optional = <K extends string, V>(key: K, value: V | undefined) =>
    (value === undefined ? {} : { [key]: value }) as { readonly [P in K]?: V };
  try {
    switch (name) {
      case "start_work": {
        const at = folder();
        const project = text("project", false);
        if (at !== undefined && project !== undefined) {
          throw new InvalidArgument("Pass `folder` or `project`, not both.");
        }
        return {
          kind: "call",
          call: {
            tool: "start_work",
            prompt: required("prompt"),
            ...optional("folder", at),
            ...optional("project", project),
            mode: choice("mode", ["auto", "chat", "work", "code"] as const) ?? "auto",
            addProject: flag("addProject"),
            ...optional("title", text("title", false)),
            ...optional("model", text("model", false)),
            ...optional(
              "access",
              choice(
                "access",
                fullAccess === "in-grant" ? ACCESS_LEVELS_WITH_FULL_ACCESS : ACCESS_LEVELS,
              ),
            ),
            wait: flag("wait"),
            timeoutSeconds: integer("timeoutSeconds", DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS),
          },
        };
      }
      case "send_message":
        return {
          kind: "call",
          call: {
            tool: "send_message",
            threadId: required("threadId"),
            prompt: required("prompt"),
            wait: flag("wait"),
            timeoutSeconds: integer("timeoutSeconds", DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS),
          },
        };
      case "read_thread":
        return {
          kind: "call",
          call: {
            tool: "read_thread",
            threadId: required("threadId"),
            turns: integer("turns", 1, 20),
          },
        };
      case "answer_question":
        return {
          kind: "call",
          call: {
            tool: "answer_question",
            threadId: required("threadId"),
            questionId: required("questionId"),
            answer: required("answer"),
          },
        };
      case "stop_turn":
        return { kind: "call", call: { tool: "stop_turn", threadId: required("threadId") } };
      case "list_projects":
        return { kind: "call", call: { tool: "list_projects" } };
      case "list_waiting":
        return { kind: "call", call: { tool: "list_waiting" } };
      case "add_project": {
        const at = folder();
        if (at === undefined) throw new InvalidArgument("`folder` must be a non-empty string.");
        return {
          kind: "call",
          call: {
            tool: "add_project",
            folder: at,
            type: choice("type", ["code", "work"] as const) ?? "code",
            ...optional("name", text("name", false)),
          },
        };
      }
      default: {
        const at = folder();
        const project = text("project", false);
        if (at !== undefined && project !== undefined) {
          throw new InvalidArgument("Pass `folder` or `project`, not both.");
        }
        return {
          kind: "call",
          call: {
            tool: "list_threads",
            ...optional("folder", at),
            ...optional("project", project),
            limit: integer("limit", 20, 100),
          },
        };
      }
    }
  } catch (error) {
    if (error instanceof InvalidArgument) return { kind: "invalid", message: error.message };
    throw error;
  }
}

async function runTool(
  call: ToolCall,
  session: OpenedLocalControlSession,
  options: AgentToolCallOptions,
): Promise<ToolAnswer> {
  const { signal, policy } = options;
  const poll =
    options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs };
  if (policy !== undefined && "threadId" in call && !policy.threadAllowed(call.threadId)) {
    return { value: "That thread is not in this agent's grant.", isError: true };
  }
  switch (call.tool) {
    case "start_work":
      return await startWork(call, session, poll, signal, policy);
    case "send_message": {
      const opened = await openAgentThreadById(session, call.threadId);
      if (opened.kind === "refused") return refused(opened);
      const thread = {
        threadId: call.threadId,
        mode: opened.mode,
        ...(opened.projectName === undefined ? {} : { projectName: opened.projectName }),
      };
      return await sendAndFollow(session, thread, call.prompt, call, poll, signal, policy);
    }
    case "read_thread": {
      const read = await openAndReadAgentThread(session, call.threadId, { turns: call.turns });
      return read.kind === "refused" ? refused(read) : answered(stateAnswer(read.state));
    }
    case "answer_question": {
      const done = await answerAgentQuestion(session, call);
      return done.kind === "refused"
        ? refused(done)
        : answered({ answered: true, next: "Use read_thread to follow the thread." });
    }
    case "stop_turn": {
      const stopped = await stopAgentTurn(session, call.threadId);
      return stopped.kind === "refused" ? refused(stopped) : answered({ result: stopped.kind });
    }
    case "list_projects": {
      const projects = await readActiveProjects(session);
      return projects.kind === "refused"
        ? refused(projects)
        : answered({
            projects: projects.active
              .filter((project) => policy?.projectAllowed(String(project.id)) ?? true)
              .map(projectRow),
          });
    }
    case "list_waiting": {
      const listed = await listWaitingRequests(session);
      return listed.kind === "refused"
        ? refused(listed)
        : answered({
            waiting: listed.requests.filter(
              (request) => policy?.threadAllowed(request.threadId) ?? true,
            ),
            ...(listed.complete ? {} : { incomplete: INCOMPLETE_WAITING }),
          });
    }
    case "add_project": {
      if (policy !== undefined) {
        return { value: "Adding a Project stays with the person, at the host.", isError: true };
      }
      const added = await addProject(session, {
        path: call.folder,
        projectType: call.type,
        ...(call.name === undefined ? {} : { name: call.name }),
      });
      return added.kind === "refused"
        ? refused(added)
        : answered({ project: { name: added.name, type: call.type, folder: added.path } });
    }
    case "list_threads": {
      const read = await readActiveProjects(session);
      if (read.kind === "refused") return refused(read);
      const projects = {
        active: read.active.filter((project) => policy?.projectAllowed(String(project.id)) ?? true),
      };
      const project =
        call.folder !== undefined
          ? projectHolding(projects.active, call.folder)
          : call.project === undefined
            ? undefined
            : projects.active.find(
                (entry) => entry.name.trim().toLowerCase() === call.project?.trim().toLowerCase(),
              );
      if ((call.folder !== undefined || call.project !== undefined) && project === undefined) {
        return {
          value:
            call.folder !== undefined
              ? `No Octant Project holds ${call.folder}.`
              : `No Octant Project is named "${call.project}".`,
          isError: true,
        };
      }
      const threads = await listRecentAgentThreads(session, {
        projects: projects.active,
        ...(project === undefined ? {} : { project }),
      });
      return answered({
        threads: threads
          .filter((thread) => policy?.threadAllowed(thread.threadId) ?? true)
          .slice(0, call.limit),
      });
    }
  }
}

async function startWork(
  call: Extract<ToolCall, { readonly tool: "start_work" }>,
  session: OpenedLocalControlSession,
  poll: { readonly pollIntervalMs?: number },
  signal: AbortSignal,
  policy: AgentToolPolicy | undefined,
): Promise<ToolAnswer> {
  let mode = call.mode;
  let addedProject: string | undefined;
  if (policy !== undefined) {
    if (call.addProject) {
      return { value: "Adding a Project stays with the person, at the host.", isError: true };
    }
    if (call.folder !== undefined || call.project !== undefined) {
      const projects = await readActiveProjects(session);
      if (projects.kind === "refused") return refused(projects);
      const named =
        call.folder !== undefined
          ? projectHolding(projects.active, call.folder)
          : projects.active.find(
              (entry) => entry.name.trim().toLowerCase() === call.project?.trim().toLowerCase(),
            );
      if (named === undefined || !policy.projectAllowed(String(named.id))) {
        return {
          value:
            "That Project is not in this agent's grant. list_projects shows the ones it may use.",
          isError: true,
        };
      }
    }
  }
  if (mode !== "chat" && call.folder !== undefined) {
    const projects = await readActiveProjects(session);
    if (projects.kind === "refused") return refused(projects);
    const holding = projectHolding(projects.active, call.folder);
    const wantedType = mode === "work" ? "work" : "code";
    if (holding === undefined) {
      if (!call.addProject) {
        return {
          value: `No Octant Project holds ${call.folder}. If the person asked to work there, call start_work again with addProject: true to add it as a ${wantedType === "code" ? "Code" : "Work"} Project, or use mode "chat".`,
          isError: true,
        };
      }
      const added = await addProject(session, { path: call.folder, projectType: wantedType });
      if (added.kind === "refused") return refused(added);
      addedProject = added.name;
    } else if (mode !== "auto" && holding.type !== mode) {
      return {
        value: `"${holding.name}" is a ${holding.type} Project; mode ${mode} needs a ${mode} one. Use mode "auto".`,
        isError: true,
      };
    }
  }
  if (mode !== "chat" && call.folder === undefined && call.project === undefined) {
    // Nothing names a Project, and the server's own working directory is not
    // the caller's, so it is never guessed from.
    if (mode !== "auto") {
      return {
        value: `A ${mode} thread works in a Project: pass \`folder\` or \`project\`.`,
        isError: true,
      };
    }
    mode = "chat";
  }
  // Limits are checked before anything is created, so a refused turn leaves
  // no empty thread behind.
  const admission = await policy?.beforeTurn(session);
  if (admission?.kind === "refused") return { value: admission.message, isError: true };
  const created = await createAgentThread(session, {
    mode,
    title: call.title ?? titleFromPrompt(call.prompt),
    projectName: call.project,
    cwd: call.folder,
    model: call.model,
    access: call.access ?? (mode === "chat" ? undefined : policy?.defaultAccess),
    // A grant cannot remember a level on a Project; its Full access is the thread's.
    ...(policy === undefined ? {} : { fullAccessScope: "thread" as const }),
  });
  if (created.kind === "refused") {
    admission?.release();
    return refused(created);
  }
  const thread = {
    threadId: created.threadId,
    mode: created.mode,
    ...(created.projectName === undefined ? {} : { projectName: created.projectName }),
  };
  const answer = await sendAndFollow(session, thread, call.prompt, call, poll, signal, admission);
  if (addedProject === undefined || typeof answer.value === "string") return answer;
  return { ...answer, value: { ...answer.value, addedProject } };
}

async function sendAndFollow(
  session: OpenedLocalControlSession,
  thread: {
    readonly threadId: string;
    readonly mode: "chat" | "work" | "code";
    readonly projectName?: string;
  },
  prompt: string,
  options: { readonly wait: boolean; readonly timeoutSeconds: number },
  poll: { readonly pollIntervalMs?: number },
  signal: AbortSignal,
  /** The policy to admit this turn, or the admission the caller already holds for it. */
  limits: AgentToolPolicy | TurnAdmission | undefined,
): Promise<ToolAnswer> {
  const admission =
    limits === undefined || "kind" in limits ? limits : await limits.beforeTurn(session);
  if (admission?.kind === "refused") return { value: admission.message, isError: true };
  let started: Awaited<ReturnType<typeof startAgentTurn>>;
  try {
    started = await startAgentTurn(
      agentThreadPort(session, thread.mode, thread.threadId),
      prompt,
      poll,
    );
  } finally {
    admission?.release();
  }
  if (started.kind === "refused") {
    return {
      value: `${started.message} (thread ${thread.threadId})`,
      isError: true,
    };
  }
  if (!options.wait) {
    const read = await readAgentThreadState(session, thread);
    return {
      ...answered(
        read.kind === "read"
          ? stateAnswer(read.state)
          : { threadId: thread.threadId, mode: thread.mode, status: "running" },
      ),
      keepOpenUntil: started.settled,
    };
  }
  const followed = await waitForAgentTurn(session, thread, {
    timeoutMs: options.timeoutSeconds * 1_000,
    signal,
    ...poll,
  });
  if (followed.kind === "refused") return { ...refused(followed), keepOpenUntil: started.settled };
  return {
    ...answered({
      ...stateAnswer(followed.state),
      ...(followed.timedOut ? { waitEnded: "The wait ended; the turn is still running." } : {}),
    }),
    keepOpenUntil: started.settled,
  };
}

/** The thread's state with a plain next step, so the calling agent knows what to do. */
function stateAnswer(state: AgentThreadState): JsonObject {
  const next =
    state.status === "waiting-for-answer"
      ? "Answer with answer_question, or ask the person."
      : state.status === "waiting-for-person"
        ? "The person answers these in Octant; read_thread again later."
        : state.status === "running"
          ? "The thread is working in Octant; use read_thread to follow it."
          : "The turn has ended; send_message continues the thread.";
  return {
    threadId: state.threadId,
    mode: state.mode,
    title: state.title,
    ...(state.projectName === undefined ? {} : { project: state.projectName }),
    status: state.status,
    turns: state.turns.map((turn) => ({
      ...turn,
      reply:
        turn.reply.length <= MAX_REPLY_CHARACTERS
          ? turn.reply
          : `${turn.reply.slice(0, MAX_REPLY_CHARACTERS)}\n… (cut here; the full reply is in Octant)`,
    })),
    ...(state.questions.length === 0 ? {} : { questions: state.questions }),
    ...(state.waitingInOctant.length === 0 ? {} : { waitingInOctant: state.waitingInOctant }),
    ...(state.waitingIncomplete === true ? { waitingIncomplete: INCOMPLETE_WAITING } : {}),
    next,
  };
}

function answered(value: JsonObject): ToolAnswer {
  return { value, isError: false };
}

function refused(refusal: HostRefusal): ToolAnswer {
  return { value: refusal.message, isError: true };
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}
