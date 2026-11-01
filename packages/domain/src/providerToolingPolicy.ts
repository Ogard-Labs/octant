/**
 * Turns a person's request to add or remove a tool on a Claude Code or Codex
 * account into the provider's own command, as an argument list.
 *
 * Nothing here runs anything. The list is handed to a process that does not
 * use a shell, so a value is one argument whatever it contains; the checks
 * exist so the command the person is shown means what it says and so no value
 * can pass for an option. Every command names its scope (`user`) so the change
 * lands on the account and never on whatever folder the host happens to be in.
 *
 * Command shapes were read from the installed CLIs' own help (Claude Code
 * 2.1.314, Codex 0.164.0). Neither takes a secret on its command line safely,
 * so a secret is accepted only where the CLI reads it from the environment.
 */

import type { ProviderToolingProvider, ProviderToolingRequest } from "@octant/contracts";
import { redactSecrets } from "./secretGuardPolicy";

export type ProviderToolingCommandKind = ProviderToolingRequest["kind"];

export type ProviderToolingRefusalCode = "invalid-value" | "secret-unsupported" | "unsupported";

export interface ProviderToolingCommand {
  readonly provider: ProviderToolingProvider;
  readonly commandKind: ProviderToolingCommandKind;
  /** Everything after the program name. */
  readonly argv: ReadonlyArray<string>;
  /** The one value given through the environment, never through `argv`. */
  readonly secret?: { readonly variable: string; readonly value: string };
  readonly summary: string;
  readonly effects: ReadonlyArray<string>;
  /** The server, marketplace, or plugin name the journal records. */
  readonly name?: string;
}

export type ProviderToolingCommandResult =
  | { readonly status: "ok"; readonly command: ProviderToolingCommand }
  | {
      readonly status: "refused";
      readonly reason: ProviderToolingRefusalCode;
      readonly message: string;
      readonly field?: string;
    };

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._~:/+=@-]{0,255}$/;
const GITHUB_SHORTHAND = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const GITHUB_REFERENCE = /^@[A-Za-z0-9_][A-Za-z0-9_./-]{0,127}$/;
const MAXIMUM_VALUE = 2048;
const SECRET_VARIABLE = "MCP_CLIENT_SECRET";

/** What each CLI cannot take safely, stated once and shown beside the form. */
export const PROVIDER_TOOLING_NOTES: Readonly<
  Record<ProviderToolingProvider, ReadonlyArray<string>>
> = {
  claude: [
    "Claude Code reads a server's OAuth client secret from an environment variable, so Octant passes that one secret that way. It takes a server's own keys and headers only on its command line, where other programs on this computer can read them, so Octant does not add those. Use a Connector for a hosted server that needs a key.",
  ],
  codex: [
    "Codex takes a server's keys and OAuth client secret only on its command line, where other programs on this computer can read them, so Octant passes no secret to it. For a hosted server you can name the environment variable Codex reads a bearer token from; Octant never sees the token.",
  ],
};

const PROVIDER_NAME: Readonly<Record<ProviderToolingProvider, string>> = {
  claude: "Claude Code",
  codex: "Codex",
};

function refuse(
  reason: ProviderToolingRefusalCode,
  message: string,
  field?: string,
): ProviderToolingCommandResult {
  return {
    status: "refused",
    reason,
    message,
    ...(field === undefined ? {} : { field }),
  };
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Returns a message when the value cannot be one plain argument, else undefined. */
function plainValueProblem(
  value: string,
  label: string,
  maximum = MAXIMUM_VALUE,
): string | undefined {
  if (value.length === 0) return `${label} is empty.`;
  if (value.length > maximum) return `${label} is longer than ${maximum} characters.`;
  if (hasControlCharacter(value)) return `${label} has a line break or control character.`;
  return undefined;
}

function nameProblem(value: string, label: string): string | undefined {
  return NAME.test(value)
    ? undefined
    : `${label} may use letters, digits, dot, underscore and dash, start with a letter or digit, and be at most 64 characters.`;
}

function webAddressProblem(value: string, label: string): string | undefined {
  const plain = plainValueProblem(value, label);
  if (plain !== undefined) return plain;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `${label} is not a web address.`;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return `${label} must start with https:// or http://.`;
  }
  if (parsed.hostname === "") return `${label} has no host.`;
  if (parsed.username !== "" || parsed.password !== "") {
    return `${label} must not carry a user name or password.`;
  }
  return undefined;
}

function looksSecret(value: string): boolean {
  return redactSecrets(value).redacted;
}

/** The single entry point: validate one request and produce its command. */
export function buildProviderToolingCommand(
  provider: ProviderToolingProvider,
  request: ProviderToolingRequest,
): ProviderToolingCommandResult {
  const product = PROVIDER_NAME[provider];
  switch (request.kind) {
    case "mcp-add-url":
      return addUrlServer(provider, product, request);
    case "mcp-add-stdio":
      return addStdioServer(provider, product, request);
    case "mcp-remove": {
      const problem = nameProblem(request.name, "The server name");
      if (problem !== undefined) return refuse("invalid-value", problem, "name");
      return ok({
        provider,
        commandKind: "mcp-remove",
        argv:
          provider === "claude"
            ? ["mcp", "remove", "--scope", "user", request.name]
            : ["mcp", "remove", request.name],
        summary: `Removes the MCP server ${request.name} from this ${product} account.`,
        effects: [`${product} stops offering ${request.name} to this account.`],
        name: request.name,
      });
    }
    case "marketplace-add":
      return addMarketplace(provider, product, request.source);
    case "marketplace-remove": {
      const problem = nameProblem(request.name, "The marketplace name");
      if (problem !== undefined) return refuse("invalid-value", problem, "name");
      return ok({
        provider,
        commandKind: "marketplace-remove",
        argv:
          provider === "claude"
            ? ["plugin", "marketplace", "remove", "--scope", "user", request.name]
            : ["plugin", "marketplace", "remove", request.name],
        summary: `Removes the plugin marketplace ${request.name} from this ${product} account.`,
        effects: [`Plugins already installed from it stay until you remove them.`],
        name: request.name,
      });
    }
    case "plugin-install":
    case "plugin-uninstall":
      return pluginCommand(provider, product, request);
  }
}

function ok(command: ProviderToolingCommand): ProviderToolingCommandResult {
  return { status: "ok", command };
}

function addUrlServer(
  provider: ProviderToolingProvider,
  product: string,
  request: Extract<ProviderToolingRequest, { kind: "mcp-add-url" }>,
): ProviderToolingCommandResult {
  const nameIssue = nameProblem(request.name, "The server name");
  if (nameIssue !== undefined) return refuse("invalid-value", nameIssue, "name");
  const urlIssue = webAddressProblem(request.url, "The server address");
  if (urlIssue !== undefined) return refuse("invalid-value", urlIssue, "url");
  const effects = [
    `${product} connects to ${request.url} when a thread that loads this account's own setup starts.`,
  ];
  if (provider === "claude") {
    if (request.bearerTokenEnvVar !== undefined) {
      return refuse(
        "unsupported",
        "Claude Code has no option that names a bearer-token variable.",
        "bearerTokenEnvVar",
      );
    }
    const transport = request.transport ?? "http";
    const argv = ["mcp", "add", "--scope", "user", "--transport", transport];
    let secret: ProviderToolingCommand["secret"];
    if (request.oauthClientSecret !== undefined) {
      if (request.oauthClientId === undefined) {
        return refuse(
          "invalid-value",
          "A client secret needs the OAuth client ID it belongs to.",
          "oauthClientId",
        );
      }
      if (hasNul(request.oauthClientSecret) || request.oauthClientSecret.includes("\n")) {
        return refuse("invalid-value", "The client secret has a line break.", "oauthClientSecret");
      }
      argv.push("--client-secret");
      secret = { variable: SECRET_VARIABLE, value: request.oauthClientSecret };
    }
    if (request.oauthClientId !== undefined) {
      if (!CLIENT_ID.test(request.oauthClientId)) {
        return refuse(
          "invalid-value",
          "The OAuth client ID may use letters, digits and . _ ~ : / + = @ -, and start with a letter or digit.",
          "oauthClientId",
        );
      }
      argv.push("--client-id", request.oauthClientId);
    }
    argv.push("--", request.name, request.url);
    return ok({
      provider,
      commandKind: "mcp-add-url",
      argv,
      ...(secret === undefined ? {} : { secret }),
      summary: `Adds a hosted MCP server named ${request.name} to this ${product} account.`,
      effects,
      name: request.name,
    });
  }
  if (request.oauthClientSecret !== undefined) {
    return refuse(
      "secret-unsupported",
      "Codex takes an OAuth client secret only on its command line, where other programs on this computer can read it. Octant does not pass secrets that way.",
      "oauthClientSecret",
    );
  }
  if (request.oauthClientId !== undefined || request.transport === "sse") {
    return refuse(
      "unsupported",
      request.transport === "sse"
        ? "Codex adds streamable HTTP servers only."
        : "Octant passes an OAuth client ID to Claude Code only.",
      request.transport === "sse" ? "transport" : "oauthClientId",
    );
  }
  const argv = ["mcp", "add", request.name, "--url", request.url];
  if (request.bearerTokenEnvVar !== undefined) {
    if (
      !ENVIRONMENT_NAME.test(request.bearerTokenEnvVar) ||
      looksSecret(request.bearerTokenEnvVar)
    ) {
      return refuse(
        "invalid-value",
        "Give the name of the variable that holds the token, not the token. A name may use letters, digits and underscore, and start with a letter or underscore.",
        "bearerTokenEnvVar",
      );
    }
    argv.push("--bearer-token-env-var", request.bearerTokenEnvVar);
    effects.push(
      `Codex reads a bearer token from the variable ${request.bearerTokenEnvVar}, which must be set where Codex runs. Octant does not see it.`,
    );
  }
  return ok({
    provider,
    commandKind: "mcp-add-url",
    argv,
    summary: `Adds a hosted MCP server named ${request.name} to this ${product} account.`,
    effects,
    name: request.name,
  });
}

function hasNul(value: string): boolean {
  return value.includes("\u0000");
}

function addStdioServer(
  provider: ProviderToolingProvider,
  product: string,
  request: Extract<ProviderToolingRequest, { kind: "mcp-add-stdio" }>,
): ProviderToolingCommandResult {
  const nameIssue = nameProblem(request.name, "The server name");
  if (nameIssue !== undefined) return refuse("invalid-value", nameIssue, "name");
  const commandIssue = plainValueProblem(request.command, "The command");
  if (commandIssue !== undefined) return refuse("invalid-value", commandIssue, "command");
  if (request.command.startsWith("-")) {
    return refuse("invalid-value", "The command may not start with a dash.", "command");
  }
  for (const argument of request.args) {
    // An empty argument is a real argument; only length and control characters matter.
    if (argument.length > MAXIMUM_VALUE || hasControlCharacter(argument)) {
      return refuse(
        "invalid-value",
        "An argument is too long or has a line break or control character.",
        "args",
      );
    }
  }
  const seen = new Set<string>();
  for (const entry of request.env) {
    if (!ENVIRONMENT_NAME.test(entry.name)) {
      return refuse(
        "invalid-value",
        `${entry.name.slice(0, 40)} is not a valid variable name.`,
        "env",
      );
    }
    if (seen.has(entry.name)) {
      return refuse("invalid-value", `${entry.name} is listed twice.`, "env");
    }
    seen.add(entry.name);
    if (entry.value.length > 1024 || hasControlCharacter(entry.value)) {
      return refuse("invalid-value", `The value of ${entry.name} is not plain text.`, "env");
    }
    if (looksSecret(entry.value) || looksSecret(`${entry.name}=${entry.value}`)) {
      return refuse(
        "secret-unsupported",
        `${entry.name} looks like a key. ${product} takes environment values only on its command line, where other programs on this computer can read them, so Octant does not add a key this way.`,
        "env",
      );
    }
  }
  const argv =
    provider === "claude" ? ["mcp", "add", "--scope", "user"] : ["mcp", "add", request.name];
  for (const entry of request.env) {
    argv.push("--env", `${entry.name}=${entry.value}`);
  }
  if (provider === "claude") argv.push("--", request.name, request.command, ...request.args);
  else argv.push("--", request.command, ...request.args);
  return ok({
    provider,
    commandKind: "mcp-add-stdio",
    argv,
    summary: `Adds a local MCP server named ${request.name} to this ${product} account.`,
    effects: [
      `${product} runs ${[request.command, ...request.args].join(" ")} on this computer, with your permissions, when a thread that loads this account's own setup starts it.`,
    ],
    name: request.name,
  });
}

function addMarketplace(
  provider: ProviderToolingProvider,
  product: string,
  source: string,
): ProviderToolingCommandResult {
  const plain = plainValueProblem(source, "The marketplace source");
  if (plain !== undefined) return refuse("invalid-value", plain, "source");
  let kind: "web" | "github" | "path";
  if (source.startsWith("/")) {
    kind = "path";
    if (source.split("/").includes("..")) {
      return refuse("invalid-value", 'A folder path may not contain "..".', "source");
    }
  } else if (source.includes("://")) {
    kind = "web";
    const issue = webAddressProblem(source, "The marketplace source");
    if (issue !== undefined) return refuse("invalid-value", issue, "source");
    if (new URL(source).protocol !== "https:") {
      return refuse("invalid-value", "A marketplace address must start with https://.", "source");
    }
  } else {
    kind = "github";
    const at = source.indexOf("@");
    const repository = provider === "codex" && at !== -1 ? source.slice(0, at) : source;
    const reference = provider === "codex" && at !== -1 ? source.slice(at) : "";
    if (
      !GITHUB_SHORTHAND.test(repository) ||
      (reference !== "" && !GITHUB_REFERENCE.test(reference))
    ) {
      return refuse(
        "invalid-value",
        "Give a GitHub repository as owner/repo, an https:// address, or a folder path that starts with /.",
        "source",
      );
    }
  }
  const origin =
    kind === "path"
      ? `the folder ${source}`
      : kind === "web"
        ? source
        : `the GitHub repository ${source}`;
  return ok({
    provider,
    commandKind: "marketplace-add",
    argv:
      provider === "claude"
        ? ["plugin", "marketplace", "add", "--scope", "user", "--", source]
        : ["plugin", "marketplace", "add", "--", source],
    summary: `Adds a plugin marketplace from ${origin} to this ${product} account.`,
    effects: [
      `${product} fetches the marketplace's catalogue. No plugin is installed by this step.`,
    ],
  });
}

function pluginCommand(
  provider: ProviderToolingProvider,
  product: string,
  request: Extract<ProviderToolingRequest, { kind: "plugin-install" | "plugin-uninstall" }>,
): ProviderToolingCommandResult {
  const pluginIssue = nameProblem(request.plugin, "The plugin name");
  if (pluginIssue !== undefined) return refuse("invalid-value", pluginIssue, "plugin");
  if (request.marketplace !== undefined) {
    const issue = nameProblem(request.marketplace, "The marketplace name");
    if (issue !== undefined) return refuse("invalid-value", issue, "marketplace");
  }
  const selector =
    request.marketplace === undefined ? request.plugin : `${request.plugin}@${request.marketplace}`;
  if (request.kind === "plugin-install") {
    return ok({
      provider,
      commandKind: "plugin-install",
      argv:
        provider === "claude"
          ? ["plugin", "install", "--scope", "user", "--", selector]
          : ["plugin", "add", "--", selector],
      summary: `Installs the plugin ${selector} for this ${product} account.`,
      effects: [
        `A plugin can bring skills, hooks, and MCP servers. ${product} loads them with your permissions when a thread that loads this account's own setup starts.`,
        "Octant does not run the plugin's own installer. A plugin that needs one to approve a command is refused by the provider.",
      ],
      name: request.plugin,
    });
  }
  return ok({
    provider,
    commandKind: "plugin-uninstall",
    argv:
      provider === "claude"
        ? ["plugin", "uninstall", "--scope", "user", "--", selector]
        : ["plugin", "remove", "--", selector],
    summary: `Uninstalls the plugin ${selector} from this ${product} account.`,
    effects: [`${product} removes the plugin and what it cached.`],
    name: request.plugin,
  });
}

/**
 * The command as a person reads it. Quoting is for the eye only: the host
 * never gives this text to a shell. A secret shows as `<secret>`.
 */
export function formatProviderToolingCommandLine(input: {
  readonly binary: string;
  readonly environment: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly argv: ReadonlyArray<string>;
}): string {
  const prefix = input.environment.map((entry) => `${entry.name}=${quoteForReading(entry.value)}`);
  return [...prefix, quoteForReading(input.binary), ...input.argv.map(quoteForReading)].join(" ");
}

function quoteForReading(value: string): string {
  if (value === "<secret>") return value;
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
