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
  /**
   * The person's rules for loading their own skills, kept apart from `rules`
   * because skills follow their own switch: only a session whose skills are
   * on applies them, in place of the level's ask for every skill.
   */
  readonly skillRules?: ReadonlyArray<PermissionV2Rule>;
  /**
   * The person's rules that decide a folder outside the Project, in the order
   * they wrote them: their `external_directory` rules and any rule whose
   * action is a wildcard that covers it. Present only when one of them
   * denies. The level owns what an outside folder is allowed or asked, so a
   * session restates only the denials (`ownOutsideFolderDenials` in the
   * driver): the person's choice to refuse a folder holds at every level,
   * and their allow never opens one.
   */
  readonly outsideFolderRules?: ReadonlyArray<PermissionV2Rule>;
  readonly mcp: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  /**
   * The person's file carries a policy that allows an MCP server. OpenCode 2
   * ranks a policy in that file above one in the inline configuration, so a
   * launch on the person's own configuration cannot hold that server off
   * when their tool servers are off (`createOwnOpenCodeProfile`).
   */
  readonly allowsToolServerByPolicy?: true;
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
/**
 * What the level owns, which the person's allow and ask rules never reach:
 * folders outside the Project, where the level's own ask or refusal must
 * hold; the question tool, allowed at every level; and every namespaced tool
 * at once, which is a catch-all for tool servers. Skills are read apart
 * (`skillRules`). A person's deny of an outside folder or of every namespaced
 * tool is kept, since a deny only narrows; the question tool stays the
 * level's either way.
 */
const OCTANT_OWNED_ACTIONS: ReadonlySet<string> = new Set([
  "external_directory",
  "question",
  "*_*",
]);
const OUTSIDE_FOLDER_ACTION = "external_directory";
/**
 * The shell and delegation each have two names in a person's rules: the ones
 * OpenCode's permission events use (`shell`, `subagent`) and the ones its
 * `permission` configuration key has always used (`bash`, `task`).
 */
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

interface ProjectedRules {
  readonly rules: PermissionV2Rule[];
  readonly skillRules: PermissionV2Rule[];
  readonly outsideFolderRules: PermissionV2Rule[];
}

function pushRule(
  { rules, skillRules, outsideFolderRules }: ProjectedRules,
  action: string,
  resource: string,
  effect: PermissionV2Rule["effect"],
): void {
  // `**` matches what `*` does, so a run of stars is one.
  action = action.replace(/\*+/gu, "*");
  resource = resource.replace(/\*+/gu, "*");
  if (wildcardMatches(action, OUTSIDE_FOLDER_ACTION) && outsideFolderRules.length < MAX_RULES) {
    outsideFolderRules.push({ action: OUTSIDE_FOLDER_ACTION, resource, effect });
  }
  if (action === "*" && resource === "*") {
    // A catch-all allow or ask would lift the whole thread above its
    // guardrail level, which only the level itself may do. A catch-all deny
    // only narrows, and an allowlist-style configuration starts with one: it
    // is kept where the person wrote it, so the rules after it still open
    // what they open in OpenCode itself. Dropped, everything the person had
    // not allowed followed the level instead of being refused.
    if (effect !== "deny") return;
    // Among the skill rules it is restated for skills alone: they are applied
    // after the level's rules, where a catch-all would refuse everything.
    if (skillRules.length < MAX_RULES) skillRules.push({ action: "skill", resource, effect });
    if (rules.length < MAX_RULES) rules.push({ action, resource, effect });
    return;
  }
  if (action === "skill") {
    if (skillRules.length < MAX_RULES) skillRules.push({ action, resource, effect });
    return;
  }
  if (OCTANT_OWNED_ACTIONS.has(action)) {
    // The session restates an outside-folder deny after the level's own
    // outside-folder rules (`outsideFolderRules`); a deny of every namespaced
    // tool sits with the person's other rules.
    if (action === "*_*" && effect === "deny" && rules.length < MAX_RULES) {
      rules.push({ action, resource, effect });
    }
    return;
  }
  for (const name of ACTION_ALIASES[action] ?? [action]) {
    if (rules.length < MAX_RULES) rules.push({ action: name, resource, effect });
  }
}

function projectRules(config: JsonRecord): ProjectedRules {
  const projected: ProjectedRules = { rules: [], skillRules: [], outsideFolderRules: [] };
  const written = config.permission;
  if (isRecord(written)) {
    for (const [tool, setting] of Object.entries(written)) {
      const action = boundedText(tool, 128);
      if (action === undefined) continue;
      const whole = effectOf(setting);
      if (whole !== undefined) {
        pushRule(projected, action, "*", whole);
      } else if (isRecord(setting)) {
        for (const [pattern, effect] of Object.entries(setting)) {
          const resource = boundedText(pattern, 512);
          const next = effectOf(effect);
          if (resource !== undefined && next !== undefined) {
            pushRule(projected, action, resource, next);
          }
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
        pushRule(projected, action, resource, effect);
      }
    }
  }
  return projected;
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

function isServerEntry(value: unknown): boolean {
  return isRecord(value) && (value.type === "local" || value.type === "remote");
}

/**
 * The MCP servers a configuration names, in the shape OpenCode 1 wrote them
 * (`mcp.<name>`, switched off with `enabled: false`). OpenCode 2 writes them
 * under `mcp.servers.<name>` and switches one off with `disabled: true`
 * (`opencode mcp add` in the opencode v2.4.1 binary); read only as the older
 * shape, a person's OpenCode 2 servers never reached a launch on the private
 * configuration. That release still reads the older shape and, like this,
 * takes `mcp.servers` for a server of that name only when it is one, and lets
 * the newer entry win where both name a server (`Config` normalization).
 */
function writtenServers(mcp: JsonRecord): ReadonlyArray<readonly [string, unknown]> {
  const current = isServerEntry(mcp.servers) ? undefined : mcp.servers;
  const entries: (readonly [string, unknown])[] = Object.entries(mcp).filter(
    ([name]) => name !== "servers" || current === undefined,
  );
  if (!isRecord(current)) return entries;
  for (const [name, entry] of Object.entries(current)) {
    entries.push([
      name,
      isRecord(entry) && typeof entry.disabled === "boolean"
        ? { ...entry, enabled: !entry.disabled }
        : entry,
    ]);
  }
  return entries;
}

/**
 * Whether a configuration's policies allow an MCP server: `mcp.use`, or the
 * older `integration.use` on an `mcp:` resource, which OpenCode 2 reads as
 * the same (opencode v2.4.1 policy schema). Its deprecated place under
 * `experimental` counts too.
 */
function policiesAllowToolServer(config: JsonRecord): boolean {
  const experimental = isRecord(config.experimental) ? config.experimental.policies : undefined;
  return [config.policies, experimental].some(
    (policies) =>
      Array.isArray(policies) &&
      policies.some(
        (policy) =>
          isRecord(policy) &&
          policy.effect === "allow" &&
          (policy.action === "mcp.use" ||
            (policy.action === "integration.use" &&
              typeof policy.resource === "string" &&
              policy.resource.startsWith("mcp:"))),
      ),
  );
}

/** The permission rules and MCP servers of a parsed OpenCode configuration. */
export function projectOpenCodeOwnSetup(
  config: unknown,
  environmentNames: ReadonlySet<string>,
): OpenCodeOwnSetup {
  if (!isRecord(config)) return NO_OPENCODE_OWN_SETUP;
  const mcp: Record<string, Record<string, unknown>> = {};
  if (isRecord(config.mcp)) {
    for (const [name, entry] of writtenServers(config.mcp)) {
      if (!Object.hasOwn(mcp, name) && Object.keys(mcp).length >= MAX_SERVERS) continue;
      if (!SERVER_NAME.test(name)) continue;
      const server = projectServer(entry, environmentNames);
      if (server !== undefined) mcp[name] = server;
    }
  }
  const { rules, skillRules, outsideFolderRules } = projectRules(config);
  return {
    rules,
    ...(skillRules.length === 0 ? {} : { skillRules }),
    ...(outsideFolderRules.some((rule) => rule.effect === "deny") ? { outsideFolderRules } : {}),
    mcp,
    ...(policiesAllowToolServer(config) ? { allowsToolServerByPolicy: true as const } : {}),
  };
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
