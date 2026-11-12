import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import {
  AGENT_CONNECTION_CODE_PREFIX,
  AGENT_GRANT_LEVELS,
  AGENT_GRANT_TOOLS,
  DEFAULT_AGENT_GRANT_LIMITS,
  ProjectBootstrap,
  decodeAgentAccessResult,
  decodeAgentConnectionCode,
  decodeAgentConnectionFile,
  decodeHostAnswer,
  type AgentAccessCommand,
  type AgentAccessResult,
  type AgentGrantLevel,
  type AgentGrantMode,
  type AgentGrantScope,
  type AgentGrantTool,
  type AgentGrantView,
} from "@octant/contracts";
import { AGENT_CLAIM_PATH } from "./agentAccessBridge";
import { agentListenerFetch, type AgentListenerFetch } from "./agentAccessTransport";
import type { OpenedLocalControlSession } from "./localControl";

/** `octant agent-access` flags that take no value. */
export const AGENT_ACCESS_SWITCHES: ReadonlyArray<string> = [
  "json",
  "direct",
  "allow-answers",
  "stop-turns",
];

const GRANTS_PATH = "/api/desktop/agent-access";
const COMMANDS_PATH = "/api/desktop/agent-access/commands";
const DEFAULT_TOOLS: ReadonlyArray<AgentGrantTool> = AGENT_GRANT_TOOLS.filter(
  (tool) => tool !== "answer_question",
);

export type AgentAccessCliCommand =
  | {
      readonly action: "create";
      readonly name: string;
      readonly projects: ReadonlyArray<string>;
      readonly modes?: ReadonlyArray<AgentGrantMode>;
      readonly level: AgentGrantLevel;
      readonly threads: "own" | "project";
      readonly allowAnswers: boolean;
      readonly models?: ReadonlyArray<string>;
      readonly days: number;
      readonly direct: boolean;
      readonly turnsPerDay?: number;
      readonly runningTurns?: number;
      readonly requestsPerMinute?: number;
      readonly json: boolean;
    }
  | { readonly action: "list"; readonly json: boolean }
  | { readonly action: "show"; readonly grant: string; readonly json: boolean }
  | { readonly action: "code"; readonly grant: string }
  | { readonly action: "confirm"; readonly grant: string; readonly fingerprint: string }
  | { readonly action: "remove-key"; readonly grant: string; readonly fingerprint: string }
  | { readonly action: "rotate-key"; readonly grant: string }
  | { readonly action: "revoke"; readonly grant: string; readonly stopTurns: boolean }
  | {
      readonly action: "join";
      readonly code: string;
      readonly out: string;
      readonly label: string;
    };

const csv = (value: string | boolean | undefined): ReadonlyArray<string> | undefined =>
  typeof value === "string"
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : undefined;

const integer = (value: string | boolean | undefined): number | undefined | "invalid" => {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return "invalid";
  return Number(value);
};

export function resolveAgentAccessCliCommand(
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): AgentAccessCliCommand | undefined {
  const [action, first, second] = positional;
  const only = (...allowed: string[]) => Object.keys(flags).every((flag) => allowed.includes(flag));
  const json = flags.json === true;
  switch (action) {
    case "create": {
      if (first === undefined || positional.length !== 2) return undefined;
      if (
        !only(
          "project",
          "mode",
          "access",
          "threads",
          "allow-answers",
          "models",
          "days",
          "direct",
          "turns-per-day",
          "running-turns",
          "requests-per-minute",
          "json",
        )
      ) {
        return undefined;
      }
      const projects = csv(flags.project) ?? [];
      const modes = csv(flags.mode);
      if (modes !== undefined && !modes.every((mode) => ["chat", "work", "code"].includes(mode))) {
        return undefined;
      }
      const level = (typeof flags.access === "string" ? flags.access : "ask-first") as string;
      if (!(AGENT_GRANT_LEVELS as ReadonlyArray<string>).includes(level)) return undefined;
      const threads = typeof flags.threads === "string" ? flags.threads : "own";
      if (threads !== "own" && threads !== "project") return undefined;
      const days = integer(flags.days);
      const turnsPerDay = integer(flags["turns-per-day"]);
      const runningTurns = integer(flags["running-turns"]);
      const requestsPerMinute = integer(flags["requests-per-minute"]);
      if ([days, turnsPerDay, runningTurns, requestsPerMinute].includes("invalid"))
        return undefined;
      const models = csv(flags.models);
      return {
        action: "create",
        name: first,
        projects,
        ...(modes === undefined ? {} : { modes: modes as ReadonlyArray<AgentGrantMode> }),
        level: level as AgentGrantLevel,
        threads,
        allowAnswers: flags["allow-answers"] === true,
        ...(models === undefined ? {} : { models }),
        days: typeof days === "number" ? days : 30,
        direct: flags.direct === true,
        ...(typeof turnsPerDay === "number" ? { turnsPerDay } : {}),
        ...(typeof runningTurns === "number" ? { runningTurns } : {}),
        ...(typeof requestsPerMinute === "number" ? { requestsPerMinute } : {}),
        json,
      };
    }
    case "list":
      return positional.length === 1 && only("json") ? { action: "list", json } : undefined;
    case "show":
      return first !== undefined && positional.length === 2 && only("json")
        ? { action: "show", grant: first, json }
        : undefined;
    case "code":
    case "rotate-key":
      return first !== undefined && positional.length === 2 && only()
        ? { action, grant: first }
        : undefined;
    case "confirm":
    case "remove-key":
      return first !== undefined && second !== undefined && positional.length === 3 && only()
        ? { action, grant: first, fingerprint: second.toLowerCase() }
        : undefined;
    case "revoke":
      return first !== undefined && positional.length === 2 && only("stop-turns")
        ? { action: "revoke", grant: first, stopTurns: flags["stop-turns"] === true }
        : undefined;
    case "join":
      if (first === undefined || positional.length !== 2 || !only("out", "label")) return undefined;
      return {
        action: "join",
        code: first,
        out: typeof flags.out === "string" ? flags.out : "octant-agent.json",
        label: typeof flags.label === "string" ? flags.label : hostname().slice(0, 64),
      };
    default:
      return undefined;
  }
}

interface Output {
  readonly stdout: { readonly write: (chunk: string) => unknown };
  readonly stderr: { readonly write: (chunk: string) => unknown };
}

/** Every agent-access command except `join`, over this host's loopback administration. */
export async function runAgentAccessCliCommand(
  input: Output & {
    readonly command: Exclude<AgentAccessCliCommand, { readonly action: "join" }>;
    readonly session: OpenedLocalControlSession;
  },
): Promise<number> {
  const { command, session } = input;
  const send = async (body: AgentAccessCommand): Promise<AgentAccessResult> => {
    const response = await session.send({ path: COMMANDS_PATH, method: "POST", body });
    return readResult(response.body);
  };
  const grants = async (): Promise<ReadonlyArray<AgentGrantView> | undefined> => {
    const response = await session.send({ path: GRANTS_PATH, method: "GET" });
    const result = readResult(response.body);
    if (result.kind === "grants") return result.grants;
    input.stderr.write(`${messageOf(result, "Agent access is unavailable on this host.")}\n`);
    return undefined;
  };
  const find = async (reference: string): Promise<AgentGrantView | undefined> => {
    const listed = await grants();
    if (listed === undefined) return undefined;
    const wanted = reference.toLowerCase();
    const matches = listed.filter(
      (view) =>
        String(view.grant.grantId) === reference ||
        String(view.grant.grantId).startsWith(wanted) ||
        view.grant.name.toLowerCase() === wanted,
    );
    if (matches.length === 1) return matches[0];
    input.stderr.write(
      matches.length === 0
        ? `No agent grant matches ${reference}. List them with: octant agent-access list\n`
        : `More than one agent grant matches ${reference}; use its id.\n`,
    );
    return undefined;
  };
  const fail = (result: AgentAccessResult): number => {
    input.stderr.write(`${messageOf(result, "Octant refused that.")}\n`);
    return 1;
  };

  if (command.action === "list") {
    const listed = await grants();
    if (listed === undefined) return 1;
    if (command.json) {
      input.stdout.write(`${JSON.stringify({ grants: listed })}\n`);
      return 0;
    }
    if (listed.length === 0)
      input.stdout.write(
        "No agent grants. Make one with: octant agent-access create <name> --project <name>\n",
      );
    for (const view of listed) input.stdout.write(`${summary(view)}\n`);
    return 0;
  }
  if (command.action === "create") {
    const projects = await session.send({ path: "/api/projects/bootstrap", method: "GET" });
    if (projects.status !== 200) {
      input.stderr.write("Projects are unavailable on this host.\n");
      return 1;
    }
    const active = decodeHostAnswer(ProjectBootstrap)(projects.body).active;
    const resolved = [];
    for (const name of command.projects) {
      const project = active.find(
        (entry) => entry.name.trim().toLowerCase() === name.toLowerCase(),
      );
      if (project === undefined) {
        input.stderr.write(`No active Project is named ${name}.\n`);
        return 1;
      }
      resolved.push(project);
    }
    const modes: ReadonlyArray<AgentGrantMode> =
      command.modes ??
      [...new Set(resolved.map((project) => project.type as AgentGrantMode))].filter(
        (mode) => mode !== "chat" || resolved.length === 0,
      );
    const scope: AgentGrantScope = {
      projects: resolved.map((project) => project.id),
      modes: modes.length === 0 ? ["chat"] : modes,
      highestLevel: command.level,
      threads: command.threads,
      tools: command.allowAnswers ? [...AGENT_GRANT_TOOLS] : [...DEFAULT_TOOLS],
      ...(command.models === undefined ? {} : { models: command.models }),
      limits: {
        runningTurns: command.runningTurns ?? DEFAULT_AGENT_GRANT_LIMITS.runningTurns,
        turnsPerDay: command.turnsPerDay ?? DEFAULT_AGENT_GRANT_LIMITS.turnsPerDay,
        requestsPerMinute:
          command.requestsPerMinute ?? DEFAULT_AGENT_GRANT_LIMITS.requestsPerMinute,
      },
      direct: command.direct,
    };
    const created = await send({
      kind: "create",
      draft: { name: command.name, scope, days: command.days },
    });
    if (created.kind !== "grant") return fail(created);
    const grantId = created.grant.grant.grantId;
    const ticket = await send({ kind: "issue-ticket", grantId });
    const direct = command.direct ? await send({ kind: "rotate-direct-key", grantId }) : undefined;
    if (command.json) {
      input.stdout.write(`${JSON.stringify({ grant: created.grant, ticket, direct })}\n`);
      return ticket.kind === "ticket" ? 0 : 1;
    }
    input.stdout.write(`Agent grant ${command.name} (${String(grantId)})\n`);
    printTicket(input, ticket);
    if (direct !== undefined) printDirectKey(input, direct);
    return ticket.kind === "ticket" ? 0 : 1;
  }

  const view = await find(command.grant);
  if (view === undefined) return 1;
  const grantId = view.grant.grantId;
  switch (command.action) {
    case "show":
      input.stdout.write(command.json ? `${JSON.stringify(view)}\n` : `${detail(view)}\n`);
      return 0;
    case "code": {
      const ticket = await send({ kind: "issue-ticket", grantId });
      if (ticket.kind !== "ticket") return fail(ticket);
      printTicket(input, ticket);
      return 0;
    }
    case "confirm":
    case "remove-key": {
      const keys =
        command.action === "confirm"
          ? view.pendingClaims.map((claim) => claim.fingerprint)
          : view.grant.keys.map((key) => key.fingerprint);
      const matches = keys.filter((fingerprint) => fingerprint.startsWith(command.fingerprint));
      if (matches.length !== 1 || command.fingerprint.length < 8) {
        input.stderr.write(
          command.action === "confirm"
            ? "Name a waiting key by at least 8 characters of its fingerprint; octant agent-access show lists them.\n"
            : "Name an enrolled key by at least 8 characters of its fingerprint.\n",
        );
        return 1;
      }
      const fingerprint = matches[0] ?? "";
      const result = await send(
        command.action === "confirm"
          ? { kind: "confirm-key", grantId, fingerprint }
          : { kind: "remove-key", grantId, fingerprint },
      );
      if (result.kind !== "grant") return fail(result);
      input.stdout.write(
        command.action === "confirm"
          ? `Confirmed key ${fingerprint.slice(0, 16)} for ${view.grant.name}. The agent can connect now.\n`
          : `Removed key ${fingerprint.slice(0, 16)} from ${view.grant.name}.\n`,
      );
      return 0;
    }
    case "rotate-key": {
      const result = await send({ kind: "rotate-direct-key", grantId });
      if (result.kind !== "direct-key") return fail(result);
      printDirectKey(input, result);
      return 0;
    }
    case "revoke": {
      const result = await send({ kind: "revoke", grantId, stopRunningTurns: command.stopTurns });
      if (result.kind !== "done") return fail(result);
      input.stdout.write(
        `Revoked ${view.grant.name}.${command.stopTurns ? " Its running turns were asked to stop." : " Its running turns keep running."}\n`,
      );
      return 0;
    }
  }
}

/**
 * `octant agent-access join <code>` on the agent's machine: makes a key pair,
 * offers its public half against the code's one-time ticket, and writes the
 * connection file the bridge reads. The person then confirms the key's
 * fingerprint on the host; until then the key proves nothing.
 */
export async function runAgentAccessJoin(
  input: Output & {
    readonly command: Extract<AgentAccessCliCommand, { readonly action: "join" }>;
    readonly fetch?: AgentListenerFetch;
  },
): Promise<number> {
  const { command } = input;
  if (!command.code.startsWith(AGENT_CONNECTION_CODE_PREFIX)) {
    input.stderr.write(`A connection code starts with ${AGENT_CONNECTION_CODE_PREFIX}\n`);
    return 1;
  }
  let code;
  try {
    code = decodeAgentConnectionCode(
      JSON.parse(
        Buffer.from(command.code.slice(AGENT_CONNECTION_CODE_PREFIX.length), "base64url").toString(
          "utf8",
        ),
      ),
    );
  } catch {
    input.stderr.write("That connection code is not valid.\n");
    return 1;
  }
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKey = pair.publicKey.export({ format: "pem", type: "spki" }).toString().trim();
  const fingerprint = createHash("sha256")
    .update(pair.publicKey.export({ format: "der", type: "spki" }))
    .digest("hex");
  const listener =
    input.fetch ??
    agentListenerFetch({
      origin: code.origin,
      ...(code.pin === undefined ? {} : { pin: code.pin }),
    });
  let response;
  try {
    response = await listener({
      path: AGENT_CLAIM_PATH,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ticketId: code.ticketId,
        ticketProof: code.ticketProof,
        publicKey,
        fingerprint,
        label: command.label,
      }),
    });
  } catch (error) {
    input.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (response.status !== 202) {
    input.stderr.write(
      "Octant refused the connection code: it expired, was used already, or is not for this host. Ask for a new one.\n",
    );
    return 1;
  }
  const file = decodeAgentConnectionFile({
    version: 1,
    origin: code.origin,
    hostId: code.hostId,
    grantId: code.grantId,
    ...(code.pin === undefined ? {} : { pin: code.pin }),
    fingerprint,
    publicKey,
    privateKey: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  });
  await writeFile(command.out, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  await chmod(command.out, 0o600);
  input.stdout.write(
    [
      `Wrote ${command.out}. Keep it private: it holds this machine's key.`,
      `Now confirm this key on the Octant host:`,
      `  octant agent-access confirm ${String(code.grantId).slice(0, 8)} ${fingerprint.slice(0, 16)}`,
      `Then add Octant to your MCP client as: octant agent mcp --connection ${command.out}`,
      "",
    ].join("\n"),
  );
  return 0;
}

function readResult(body: unknown): AgentAccessResult {
  try {
    return decodeAgentAccessResult(body);
  } catch {
    const message =
      typeof body === "object" &&
      body !== null &&
      typeof (body as { message?: unknown }).message === "string"
        ? String((body as { message: string }).message)
        : "Octant answered in a way this command does not understand. Update Octant.";
    return { kind: "refused", reason: "invalid", message };
  }
}

function messageOf(result: AgentAccessResult, fallback: string): string {
  return result.kind === "refused" ? result.message : fallback;
}

function printTicket(output: Output, ticket: AgentAccessResult): void {
  if (ticket.kind !== "ticket") {
    output.stderr.write(`${messageOf(ticket, "No connection code was issued.")}\n`);
    return;
  }
  output.stdout.write(
    [
      "On the agent's machine, run within five minutes:",
      `  octant agent-access join ${ticket.connectionCode}`,
      "",
    ].join("\n"),
  );
}

function printDirectKey(output: Output, result: AgentAccessResult): void {
  if (result.kind !== "direct-key") {
    output.stderr.write(`${messageOf(result, "No direct key was issued.")}\n`);
    return;
  }
  output.stdout.write(
    [
      "Direct key (shown once; Octant keeps only a hash):",
      `  ${result.key}`,
      `Endpoint: ${result.endpoint}  (send it as Authorization: Bearer <key>)`,
      "",
    ].join("\n"),
  );
}

function summary(view: AgentGrantView): string {
  const grant = view.grant;
  const state = grant.state === "active" ? "active" : "revoked";
  const keys = `${grant.keys.length} key${grant.keys.length === 1 ? "" : "s"}${view.pendingClaims.length > 0 ? `, ${view.pendingClaims.length} waiting` : ""}`;
  return `${String(grant.grantId).slice(0, 8)}  ${grant.name}  ${state}  ${grant.scope.modes.join("/")} at most ${grant.scope.highestLevel}  ${keys}  ${view.threadsStarted} threads`;
}

function detail(view: AgentGrantView): string {
  const grant = view.grant;
  return [
    `${grant.name} (${String(grant.grantId)})`,
    `  state: ${grant.state}${grant.revokedAt === undefined ? "" : ` since ${grant.revokedAt}`}`,
    `  Projects: ${grant.scope.projects.length === 0 ? "none" : grant.scope.projects.join(", ")}`,
    `  modes: ${grant.scope.modes.join(", ")}; at most ${grant.scope.highestLevel}; threads: ${grant.scope.threads}`,
    `  tools: ${grant.scope.tools.join(", ")}`,
    `  limits: ${grant.scope.limits.runningTurns} running, ${grant.scope.limits.turnsPerDay} turns a day (${view.turnsToday} today), ${grant.scope.limits.requestsPerMinute} requests a minute`,
    `  ends: ${grant.expiresAt}; direct key: ${view.directKey ? "issued" : "none"}`,
    `  last use: ${view.lastUsedAt ?? "never"}${view.lastSourceClass === undefined ? "" : ` (${view.lastSourceClass})`}`,
    ...grant.keys.map(
      (key) => `  key ${key.fingerprint.slice(0, 16)}  ${key.label}  since ${key.enrolledAt}`,
    ),
    ...view.pendingClaims.map(
      (claim) =>
        `  waiting ${claim.fingerprint.slice(0, 16)}  ${claim.label}  (confirm with octant agent-access confirm ${String(grant.grantId).slice(0, 8)} ${claim.fingerprint.slice(0, 16)})`,
    ),
  ].join("\n");
}
