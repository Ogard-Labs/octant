import { readFileSync } from "node:fs";
import type { PermissionV2Rule } from "@opencode-ai/sdk/v2/types";
import { parseRoutingConfig, routingConfigCandidates } from "./openCodeProcess";

/**
 * What the person keeps in their own OpenCode configuration that a session
 * may load once they let OpenCode run as itself: the permission rules they
 * wrote, and the MCP servers they added. Both are read from the same files
 * the routing configuration comes from, projected to a bounded shape, and
 * written into the launch's private configuration; the files themselves are
 * never handed to the process.
 */
export interface OpenCodeOwnSetup {
  /** In OpenCode 2 action names, in the order the person wrote them. */
  readonly rules: ReadonlyArray<PermissionV2Rule>;
  readonly mcp: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export const NO_OPENCODE_OWN_SETUP: OpenCodeOwnSetup = { rules: [], mcp: {} };

const MAX_RULES = 200;
const MAX_SERVERS = 32;
const MAX_COMMAND_ARGUMENTS = 32;
const MAX_TEXT = 1_024;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const ENV_REFERENCE = /^(?:[A-Za-z][A-Za-z-]{0,31} )?\{env:[A-Z][A-Z0-9_]{0,63}\}$/u;
const CREDENTIAL_TEXT =
  /(?:api[_-]?key|access[_-]?token|auth(?:entication)?[_-]?(?:key|token)|token|secret|password|credential|authorization|bearer|\b(?:sk|ghp|gho|xox[bp])[-_][A-Za-z0-9])/iu;
const SENSITIVE_KEY =
  /(?:api[_-]?key|access[_-]?token|auth(?:entication)?[_-]?(?:key|token)|token|secret|password|credential|authorization|bearer)/iu;
/** Whatever the posture owns: the person's rules never reach these. */
const OCTANT_OWNED_ACTIONS: ReadonlySet<string> = new Set([
  "external_directory",
  "question",
  "skill",
  "*_*",
]);
/** OpenCode 1 and OpenCode 2 name the shell and delegation differently. */
const ACTION_ALIASES: Readonly<Record<string, ReadonlyArray<string>>> = {
  bash: ["bash", "shell"],
  shell: ["bash", "shell"],
  task: ["task", "subagent"],
  subagent: ["task", "subagent"],
};

type JsonRecord = { readonly [key: string]: unknown };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, limit = MAX_TEXT): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) return undefined;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f]/u.test(value) ? undefined : value;
}

function effectOf(value: unknown): PermissionV2Rule["effect"] | undefined {
  return value === "allow" || value === "ask" || value === "deny" ? value : undefined;
}

function pushRule(
  rules: PermissionV2Rule[],
  action: string,
  resource: string,
  effect: PermissionV2Rule["effect"],
): void {
  // `**` matches what `*` does, so a run of stars is one.
  action = action.replace(/\*+/gu, "*");
  resource = resource.replace(/\*+/gu, "*");
  // A catch-all rule would lift the whole thread above its guardrail level,
  // which only the level itself may do.
  if (action === "*" && resource === "*") return;
  if (OCTANT_OWNED_ACTIONS.has(action)) return;
  for (const name of ACTION_ALIASES[action] ?? [action]) {
    if (rules.length < MAX_RULES) rules.push({ action: name, resource, effect });
  }
}

function projectRules(config: JsonRecord): PermissionV2Rule[] {
  const rules: PermissionV2Rule[] = [];
  const written = config.permission;
  if (isRecord(written)) {
    for (const [tool, setting] of Object.entries(written)) {
      const action = boundedText(tool, 128);
      if (action === undefined) continue;
      const whole = effectOf(setting);
      if (whole !== undefined) {
        pushRule(rules, action, "*", whole);
      } else if (isRecord(setting)) {
        for (const [pattern, effect] of Object.entries(setting)) {
          const resource = boundedText(pattern, 512);
          const next = effectOf(effect);
          if (resource !== undefined && next !== undefined) pushRule(rules, action, resource, next);
        }
      }
    }
  }
  const asRules = config.permissions;
  if (Array.isArray(asRules)) {
    for (const entry of asRules) {
      if (!isRecord(entry)) continue;
      const action = boundedText(entry.action, 128);
      const resource = boundedText(entry.resource, 512);
      const effect = effectOf(entry.effect);
      if (action !== undefined && resource !== undefined && effect !== undefined) {
        pushRule(rules, action, resource, effect);
      }
    }
  }
  return rules;
}

function projectStringRecord(
  value: unknown,
  keep: (key: string, entry: string) => boolean,
): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const projected: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    const text = boundedText(entry);
    if (boundedText(key, 128) !== undefined && text !== undefined && keep(key, text)) {
      projected[key] = text;
    }
  }
  return projected;
}

function projectServer(
  value: unknown,
  environmentNames: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const referencesKnownEnvironment = (entry: string): boolean => {
    const name = /\{env:([A-Z][A-Z0-9_]{0,63})\}/u.exec(entry)?.[1];
    return ENV_REFERENCE.test(entry) && name !== undefined && environmentNames.has(name);
  };
  const server: Record<string, unknown> = {};
  if (value.type === "local") {
    const command = Array.isArray(value.command)
      ? value.command.map((argument) => boundedText(argument))
      : [];
    if (
      command.length === 0 ||
      command.length > MAX_COMMAND_ARGUMENTS ||
      command.some((argument) => argument === undefined)
    ) {
      return undefined;
    }
    server.type = "local";
    server.command = command;
    // A literal credential never crosses; a reference to a variable the host
    // has does, so the secret stays where the person keeps it.
    if (command.some((argument) => argument !== undefined && CREDENTIAL_TEXT.test(argument))) {
      return undefined;
    }
    // A name list cannot tell every secret from a setting, so only a
    // reference to a variable the host has crosses.
    const environment = projectStringRecord(value.environment, (_key, entry) =>
      referencesKnownEnvironment(entry),
    );
    if (environment !== undefined) server.environment = environment;
  } else if (value.type === "remote") {
    const url = boundedText(value.url, 2_048);
    if (url === undefined) return undefined;
    try {
      const parsed = new URL(url);
      if (parsed.username !== "" || parsed.password !== "") return undefined;
      for (const key of parsed.searchParams.keys()) if (SENSITIVE_KEY.test(key)) return undefined;
      if (parsed.pathname.split("/").some((part) => /^[A-Za-z0-9_-]{24,}$/u.test(part))) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    server.type = "remote";
    server.url = url;
    const headers = projectStringRecord(value.headers, (_key, entry) =>
      referencesKnownEnvironment(entry),
    );
    if (headers !== undefined && Object.keys(headers).length > 0) server.headers = headers;
    if (typeof value.oauth === "boolean") server.oauth = value.oauth;
  } else {
    return undefined;
  }
  if (typeof value.enabled === "boolean") server.enabled = value.enabled;
  if (
    typeof value.timeout === "number" &&
    Number.isFinite(value.timeout) &&
    value.timeout > 0 &&
    value.timeout <= 600_000
  ) {
    server.timeout = value.timeout;
  }
  return server;
}

/** The permission rules and MCP servers of a parsed OpenCode configuration. */
export function projectOpenCodeOwnSetup(
  config: unknown,
  environmentNames: ReadonlySet<string>,
): OpenCodeOwnSetup {
  if (!isRecord(config)) return NO_OPENCODE_OWN_SETUP;
  const mcp: Record<string, Record<string, unknown>> = {};
  if (isRecord(config.mcp)) {
    for (const [name, entry] of Object.entries(config.mcp)) {
      if (Object.keys(mcp).length >= MAX_SERVERS) break;
      if (!SERVER_NAME.test(name)) continue;
      const server = projectServer(entry, environmentNames);
      if (server !== undefined) mcp[name] = server;
    }
  }
  return { rules: projectRules(config), mcp };
}

/** Reads the person's own OpenCode configuration; unreadable or invalid reads as none. */
export function readOpenCodeOwnSetup(
  environment: NodeJS.ProcessEnv = process.env,
): OpenCodeOwnSetup {
  for (const path of routingConfigCandidates(environment)) {
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    try {
      return projectOpenCodeOwnSetup(
        parseRoutingConfig(content),
        new Set(Object.keys(environment)),
      );
    } catch {
      return NO_OPENCODE_OWN_SETUP;
    }
  }
  return NO_OPENCODE_OWN_SETUP;
}

/** One launch's identity for a setup, so a connection never carries a different one. */
export function openCodeOwnSetupKey(setup: OpenCodeOwnSetup): string {
  return JSON.stringify(setup);
}

function wildcardMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, ".*");
  return new RegExp(`^${escaped.replace(/\?/gu, ".")}$`, "su").test(value);
}

/**
 * Whether the person's own rules admit an action on a path: the last rule
 * that names the action and matches one of the path's spellings is `allow`.
 * An action no rule names is not admitted here.
 */
export function openCodeOwnRulesAllow(
  rules: ReadonlyArray<PermissionV2Rule>,
  action: string,
  paths: ReadonlyArray<string>,
): boolean {
  let effect: PermissionV2Rule["effect"] | undefined;
  for (const rule of rules) {
    if (!wildcardMatches(rule.action, action)) continue;
    if (!paths.some((path) => wildcardMatches(rule.resource, path))) continue;
    effect = rule.effect;
  }
  return effect === "allow";
}
