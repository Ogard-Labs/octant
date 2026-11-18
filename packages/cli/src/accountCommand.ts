import {
  decodeAggregateVersion,
  decodeHostAnswer,
  decodeProviderInstanceId,
  ProviderRegistryCommandResult,
  ProviderRegistrySnapshot,
  type ProviderInstance,
  type ProviderRegistryCommand,
} from "@octant/contracts";
import { providerAccountProfile, type ProviderAccountProfile } from "@octant/domain";
import { randomUUID } from "node:crypto";
import { failureMessage, type OpenedLocalControlSession } from "./localControl";

export type AccountAgent = "claude" | "codex";

export type AccountCliCommand =
  | { readonly action: "list" }
  | {
      readonly action: "add";
      readonly agent: AccountAgent;
      readonly name: string | undefined;
      readonly signIn: boolean;
    }
  | { readonly action: "sign-in" | "status"; readonly account: string }
  | { readonly action: "remove"; readonly account: string; readonly yes: boolean };

/**
 * `octant account list|add|sign-in|status|remove`: a person manages extra
 * Claude Code and Codex subscription accounts from their own terminal.
 */
export function resolveAccountCliCommand(
  positional: readonly string[],
  flags: Readonly<Record<string, string | boolean>>,
): AccountCliCommand | undefined {
  const [action, target, ...rest] = positional;
  const allows = (names: readonly string[]): boolean =>
    Object.keys(flags).every((flag) => names.includes(flag));
  if (action === "list") {
    return target === undefined && Object.keys(flags).length === 0 ? { action } : undefined;
  }
  if (action === "add") {
    if ((target !== "claude" && target !== "codex") || rest.length !== 0) return undefined;
    if (!allows(["name", "no-sign-in"])) return undefined;
    const name = flags.name;
    if (name !== undefined && (typeof name !== "string" || name.trim() === "")) return undefined;
    if (flags["no-sign-in"] !== undefined && flags["no-sign-in"] !== true) return undefined;
    return {
      action,
      agent: target,
      name: typeof name === "string" ? name.trim() : undefined,
      signIn: flags["no-sign-in"] !== true,
    };
  }
  if (target === undefined || target.trim() === "" || rest.length !== 0) return undefined;
  if (action === "sign-in" || action === "status") {
    return Object.keys(flags).length === 0 ? { action, account: target } : undefined;
  }
  if (action === "remove") {
    if (!allows(["yes"]) || (flags.yes !== undefined && flags.yes !== true)) return undefined;
    return { action, account: target, yes: flags.yes === true };
  }
  return undefined;
}

export interface RunAccountCliCommandInput {
  readonly command: AccountCliCommand;
  readonly session: OpenedLocalControlSession;
  /** Asks one question on the terminal; absent when no terminal can answer. */
  readonly ask: ((question: string) => Promise<string | undefined>) | undefined;
  /** Runs a program with the terminal attached and returns its exit code. */
  readonly run: (
    binary: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ) => Promise<number>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: { readonly write: (chunk: string) => unknown };
  readonly stderr: { readonly write: (chunk: string) => unknown };
}

/** A subscription or API-key Claude account, or a Codex account, as a person sees it. */
interface Account {
  readonly instance: ProviderInstance;
  readonly agent: AccountAgent;
  readonly profile: ProviderAccountProfile;
  readonly binaryPath: string;
  /** The stored directory; undefined is the CLI's own default. */
  readonly directory: string | undefined;
  /** How the account signs in when not with its own CLI login: an API key or a gateway. */
  readonly storedKey: "API key" | "gateway" | undefined;
}

/** Host credentials that would sign an extra account in as someone else. */
const HOST_CREDENTIAL_VARIABLES: Readonly<Record<AccountAgent, readonly string[]>> = {
  claude: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY"],
};

const AGENT_LABEL: Readonly<Record<AccountAgent, string>> = { claude: "Claude", codex: "Codex" };

function accountOf(instance: ProviderInstance): Account | undefined {
  if (instance.driverKind === "claude") {
    const profile = providerAccountProfile("claude");
    if (profile === undefined) return undefined;
    return {
      instance,
      agent: "claude",
      profile,
      binaryPath: instance.configuration.binaryPath,
      directory: instance.configuration.configDirectory,
      storedKey:
        instance.configuration.authentication === "api-key"
          ? "API key"
          : instance.configuration.authentication === "gateway"
            ? "gateway"
            : undefined,
    };
  }
  if (instance.driverKind === "codex") {
    const profile = providerAccountProfile("codex");
    if (profile === undefined) return undefined;
    return {
      instance,
      agent: "codex",
      profile,
      binaryPath: instance.configuration.binaryPath,
      directory: instance.configuration.codexHome,
      storedKey: undefined,
    };
  }
  return undefined;
}

type Read =
  | { readonly kind: "read"; readonly accounts: readonly Account[] }
  | { readonly kind: "failed"; readonly message: string };

async function readAccounts(session: OpenedLocalControlSession): Promise<Read> {
  const response = await session.send({ path: "/api/providers/bootstrap", method: "GET" });
  if (response.status !== 200) {
    return {
      kind: "failed",
      message: failureMessage(response, "Octant could not list its providers."),
    };
  }
  try {
    const snapshot = decodeHostAnswer(ProviderRegistrySnapshot)(response.body);
    return {
      kind: "read",
      accounts: snapshot.instances.flatMap((instance) => accountOf(instance) ?? []),
    };
  } catch {
    return { kind: "failed", message: "Octant returned an unusable provider list." };
  }
}

type Resolved =
  | { readonly kind: "found"; readonly account: Account }
  | { readonly kind: "refused"; readonly message: string };

function resolveAccount(accounts: readonly Account[], name: string): Resolved {
  const byId = accounts.find((account) => String(account.instance.id) === name);
  if (byId !== undefined) return { kind: "found", account: byId };
  const exact = accounts.filter((account) => account.instance.displayName === name);
  const folded = accounts.filter(
    (account) => account.instance.displayName.toLowerCase() === name.toLowerCase(),
  );
  const matches = exact.length > 0 ? exact : folded;
  const [only, ...others] = matches;
  if (only !== undefined && others.length === 0) return { kind: "found", account: only };
  if (only === undefined) {
    return {
      kind: "refused",
      message: `No Claude or Codex account is named "${name}". Run \`octant account list\` to see them.`,
    };
  }
  const lines = matches.map(
    (account) =>
      `  ${String(account.instance.id)}  ${account.instance.displayName} (${AGENT_LABEL[account.agent]})`,
  );
  return {
    kind: "refused",
    message: [`More than one account is named "${name}". Use its id:`, ...lines].join("\n"),
  };
}

function directoryLabel(account: Account): string {
  return account.directory ?? `~/${account.profile.defaultHostDirectoryName}`;
}

export async function runAccountCliCommand(input: RunAccountCliCommandInput): Promise<number> {
  const { command, session, stdout, stderr } = input;
  const read = await readAccounts(session);
  if (read.kind === "failed") {
    stderr.write(`${read.message}\n`);
    return 1;
  }
  if (command.action === "list") {
    if (read.accounts.length === 0) {
      stdout.write("No Claude or Codex accounts. Add one in Octant Settings first.\n");
      return 0;
    }
    for (const account of read.accounts) {
      const kind =
        account.storedKey === undefined
          ? AGENT_LABEL[account.agent]
          : `${AGENT_LABEL[account.agent]}, ${account.storedKey}`;
      stdout.write(`${account.instance.displayName}  ${kind}  ${directoryLabel(account)}\n`);
    }
    return 0;
  }
  if (command.action === "add") return await addAccount(input, command, read.accounts);
  const resolved = resolveAccount(read.accounts, command.account);
  if (resolved.kind === "refused") {
    stderr.write(`${resolved.message}\n`);
    return 1;
  }
  if (command.action === "remove") return await removeAccount(input, command, resolved.account);
  return await runAccountCli(input, resolved.account, command.action);
}

async function runAccountCli(
  input: RunAccountCliCommandInput,
  account: Account,
  action: "sign-in" | "status",
): Promise<number> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.env)) {
    if (value !== undefined) env[name] = value;
  }
  if (account.directory !== undefined) {
    for (const name of HOST_CREDENTIAL_VARIABLES[account.agent]) delete env[name];
    for (const name of account.profile.stateDirectoryEnvVars) env[name] = account.directory;
  }
  const argv = action === "sign-in" ? account.profile.signInArgv : account.profile.statusArgv;
  try {
    return await input.run(account.binaryPath, argv, env);
  } catch (error) {
    input.stderr.write(
      `Could not run ${account.binaryPath}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

function nextAccountName(existing: readonly Account[], agent: AccountAgent): string {
  const sameAgent = existing.filter((account) => account.agent === agent);
  const first = sameAgent[0]?.instance.displayName ?? AGENT_LABEL[agent];
  const base = first.replace(/ \(\d+\)$/, "");
  const taken = new Set(existing.map((account) => account.instance.displayName));
  for (let number = 2; ; number += 1) {
    const candidate = `${base} (${number})`;
    if (!taken.has(candidate)) return candidate;
  }
}

async function addAccount(
  input: RunAccountCliCommandInput,
  command: Extract<AccountCliCommand, { action: "add" }>,
  accounts: readonly Account[],
): Promise<number> {
  const { session, stdout, stderr } = input;
  const label = AGENT_LABEL[command.agent];
  const template = accounts.find((account) => account.agent === command.agent);
  if (template === undefined) {
    stderr.write(`No ${label} account exists yet. Add ${label} in Octant Settings first.\n`);
    return 1;
  }
  const displayName = command.name ?? nextAccountName(accounts, command.agent);
  const instanceId = decodeProviderInstanceId(randomUUID());
  const body: ProviderRegistryCommand =
    command.agent === "claude"
      ? {
          kind: "create-claude-provider",
          instanceId,
          expectedVersion: decodeAggregateVersion(0),
          displayName,
          configuration: {
            kind: "claude-agent-sdk",
            binaryPath: template.binaryPath,
            authentication: "subscription",
          },
        }
      : {
          kind: "create-codex-provider",
          instanceId,
          expectedVersion: decodeAggregateVersion(0),
          displayName,
          binaryPath: template.binaryPath,
        };
  const response = await session.send({
    path: "/api/providers/commands",
    method: "POST",
    body,
  });
  if (response.status !== 200) {
    stderr.write(`${failureMessage(response, `Octant did not add the ${label} account.`)}\n`);
    return 1;
  }
  try {
    const result = decodeHostAnswer(ProviderRegistryCommandResult)(response.body);
    if (result.kind !== "provider-created") throw new Error("unexpected result");
  } catch {
    stderr.write("Octant returned an unusable answer.\n");
    return 1;
  }
  const reread = await readAccounts(session);
  const created =
    reread.kind === "read"
      ? reread.accounts.find((account) => String(account.instance.id) === String(instanceId))
      : undefined;
  if (created === undefined) {
    stderr.write(
      `Added "${displayName}", but could not read it back. Run \`octant account list\`.\n`,
    );
    return 1;
  }
  stdout.write(`Added ${label} account "${displayName}" in ${directoryLabel(created)}.\n`);
  if (!command.signIn) {
    stdout.write(`Sign it in with \`octant account sign-in "${displayName}"\`.\n`);
    return 0;
  }
  return await runAccountCli(input, created, "sign-in");
}

async function removeAccount(
  input: RunAccountCliCommandInput,
  command: Extract<AccountCliCommand, { action: "remove" }>,
  account: Account,
): Promise<number> {
  const { stdout, stderr } = input;
  const name = account.instance.displayName;
  const directory = directoryLabel(account);
  if (!command.yes) {
    if (input.ask === undefined) {
      stderr.write(`No terminal to ask on. Add --yes to remove "${name}".\n`);
      return 1;
    }
    const reply = await input.ask(
      `Remove account ${name}? Its directory ${directory} stays on disk. [y/N] `,
    );
    if (reply === undefined || !/^y(es)?$/i.test(reply.trim())) {
      stdout.write("Nothing was removed.\n");
      return 1;
    }
  }
  const response = await input.session.send({
    path: "/api/providers/commands",
    method: "POST",
    body: {
      kind: "remove-provider",
      instanceId: account.instance.id,
      expectedVersion: account.instance.version,
    } satisfies ProviderRegistryCommand,
  });
  if (response.status !== 200) {
    stderr.write(`${failureMessage(response, `Octant did not remove "${name}".`)}\n`);
    return 1;
  }
  stdout.write(`Removed "${name}". Its directory ${directory} stayed on disk.\n`);
  return 0;
}
