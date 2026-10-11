import type { ProviderDriverKind, ProviderInstance, ProviderInstanceId } from "@octant/contracts";

/**
 * One CLI driver's account rules. An account is a provider instance with a
 * display name, an accent, an Octant-assigned provider-owned state directory,
 * and a sign-in command. Octant never reads, stores, or injects that
 * provider's credentials.
 *
 * Claude is the only adopter in this change. Other drivers stay single-account
 * until they declare a profile.
 */
export interface ProviderAccountProfile {
  readonly driverKind: ProviderDriverKind;
  readonly supportsMultipleAccounts: boolean;
  /** Environment variables that point the CLI at this account's state directory. */
  readonly stateDirectoryEnvVars: ReadonlyArray<string>;
  /** Default host directory name under $HOME, for example `.claude`. */
  readonly defaultHostDirectoryName: string;
  /**
   * Extra-account parent name under $HOME. Extra accounts use
   * `~/<this>/<instanceId>`, for example `~/.claude-accounts/<id>`.
   */
  readonly extraAccountsDirectoryName: string;
  readonly signInArgv: ReadonlyArray<string>;
  readonly statusArgv: ReadonlyArray<string>;
}

export const CLAUDE_ACCOUNT_PROFILE: ProviderAccountProfile = {
  driverKind: "claude",
  supportsMultipleAccounts: true,
  stateDirectoryEnvVars: ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"],
  defaultHostDirectoryName: ".claude",
  extraAccountsDirectoryName: ".claude-accounts",
  signInArgv: ["auth", "login"],
  statusArgv: ["auth", "status"],
};

const PROFILES: Readonly<Partial<Record<ProviderDriverKind, ProviderAccountProfile>>> = {
  claude: CLAUDE_ACCOUNT_PROFILE,
};

export function providerAccountProfile(
  driverKind: ProviderDriverKind,
): ProviderAccountProfile | undefined {
  return PROFILES[driverKind];
}

/** Closed accent set shared by every multi-account driver. */
export {
  CLAUDE_ACCOUNT_ACCENTS as PROVIDER_ACCOUNT_ACCENTS,
  type ClaudeAccountAccent as ProviderAccountAccent,
} from "@octant/contracts/providers";

export function assignedProviderAccountDirectory(
  profile: ProviderAccountProfile,
  homeDirectory: string,
  instanceId: ProviderInstanceId,
): string {
  const home = stripTrailingSlashes(homeDirectory.trim());
  if (!isPosixAbsolutePath(home)) {
    throw new Error("Account home must be an absolute directory.");
  }
  return `${home}/${profile.extraAccountsDirectoryName}/${instanceId}`;
}

export function defaultProviderAccountDirectory(
  profile: ProviderAccountProfile,
  homeDirectory: string,
): string {
  const home = stripTrailingSlashes(homeDirectory.trim());
  if (!isPosixAbsolutePath(home)) {
    throw new Error("Account home must be an absolute directory.");
  }
  return `${home}/${profile.defaultHostDirectoryName}`;
}

export function formatProviderAccountCommand(input: {
  readonly profile: ProviderAccountProfile;
  readonly binaryPath: string;
  readonly argv: ReadonlyArray<string>;
  readonly stateDirectory?: string;
}): string {
  const binary = shellSingleQuote(input.binaryPath.trim());
  const command = `${binary} ${input.argv.join(" ")}`;
  if (input.stateDirectory === undefined) return command;
  const directory = shellSingleQuote(input.stateDirectory);
  const prefix = input.profile.stateDirectoryEnvVars
    .map((name) => `${name}=${directory}`)
    .join(" ");
  return `${prefix} ${command}`;
}

export function formatProviderAccountSignInCommand(input: {
  readonly profile: ProviderAccountProfile;
  readonly binaryPath: string;
  readonly stateDirectory?: string;
}): string {
  return formatProviderAccountCommand({
    profile: input.profile,
    binaryPath: input.binaryPath,
    argv: input.profile.signInArgv,
    ...(input.stateDirectory === undefined ? {} : { stateDirectory: input.stateDirectory }),
  });
}

export function formatProviderAccountStatusCommand(input: {
  readonly profile: ProviderAccountProfile;
  readonly binaryPath: string;
  readonly stateDirectory?: string;
}): string {
  return formatProviderAccountCommand({
    profile: input.profile,
    binaryPath: input.binaryPath,
    argv: input.profile.statusArgv,
    ...(input.stateDirectory === undefined ? {} : { stateDirectory: input.stateDirectory }),
  });
}

/**
 * Accent on a provider instance, when that driver's configuration carries one.
 * Claude is the only driver that stores an accent today.
 */
export function providerAccountAccent(instance: ProviderInstance): string | undefined {
  const configuration = instance.configuration;
  if (configuration === undefined || !("accent" in configuration)) return undefined;
  const accent = configuration.accent;
  return typeof accent === "string" ? accent : undefined;
}

export function implicitClaudeAccountOwnerId(
  instances: ReadonlyArray<ProviderInstance>,
): ProviderInstanceId | undefined {
  const candidates = instances.filter(
    (instance) =>
      instance.driverKind === "claude" &&
      instance.configuration.configDirectory === undefined &&
      instance.configuration.authentication === "subscription",
  );
  if (candidates.length === 0) return undefined;
  const [owner] = [...candidates].sort((left, right) => {
    const created = left.createdAt.localeCompare(right.createdAt);
    if (created !== 0) return created;
    return String(left.id).localeCompare(String(right.id));
  });
  return owner?.id;
}

/** Extra Claude accounts, and every API-key account, use an assigned leaf. */
export function claudeAccountUsesAssignedDirectory(
  instances: ReadonlyArray<ProviderInstance>,
  instance: ProviderInstance,
): boolean {
  if (instance.driverKind !== "claude") return false;
  if (instance.configuration.authentication === "api-key") return true;
  if (instance.configuration.configDirectory !== undefined) return true;
  const ownerId = implicitClaudeAccountOwnerId(instances);
  return ownerId !== undefined && String(instance.id) !== String(ownerId);
}

export function isAssignedProviderAccountDirectory(input: {
  readonly profile: ProviderAccountProfile;
  readonly homeDirectory: string;
  readonly instanceId: ProviderInstanceId;
  readonly directory: string;
}): boolean {
  return (
    stripTrailingSlashes(input.directory) ===
    assignedProviderAccountDirectory(input.profile, input.homeDirectory, input.instanceId)
  );
}

function stripTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charAt(end - 1) === "/") {
    end -= 1;
  }
  return path.slice(0, end);
}

function isPosixAbsolutePath(path: string): boolean {
  return path.startsWith("/");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
