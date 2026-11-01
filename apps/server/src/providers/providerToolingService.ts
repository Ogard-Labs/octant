import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type {
  ProviderInstance,
  ProviderInstanceId,
  ProviderToolingAppliedRecord,
  ProviderToolingApplyRequest,
  ProviderToolingApplyResult,
  ProviderToolingCancelResult,
  ProviderToolingListResult,
  ProviderToolingPlanResult,
  ProviderToolingRefusal,
  ProviderToolingRequest,
} from "@octant/contracts";
import {
  PROVIDER_TOOLING_NOTES,
  buildProviderToolingCommand,
  formatProviderToolingCommandLine,
  type ProviderToolingCommand,
} from "@octant/domain";
import { redactHostSecrets, noteIssuedSecret } from "../process/secretRedaction";
import type { ProviderCredentialStore } from "./credentialBrokerClient";
import { LIST_COMMANDS, readSection } from "./providerToolingListing";
import {
  resolveProviderToolingAccount,
  type ProviderToolingAccount,
} from "./providerToolingAccount";
import type { ProviderToolingRunner } from "./providerToolingProcess";

const PLAN_LIFETIME_MS = 10 * 60_000;
const MAXIMUM_PLANS = 32;
const LIST_TIMEOUT_MS = 45_000;
const COMMAND_TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const RESPONSE_LIMIT = 8 * 1024;
const SECRET_PLACEHOLDER = "<secret>";

export interface ProviderToolingServiceOptions {
  readonly readInstance: (id: ProviderInstanceId) => ProviderInstance | undefined;
  readonly runner: ProviderToolingRunner;
  readonly hostEnvironment: () => NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  /** A folder the commands run in, so no project file of the host's own is read. */
  readonly workingDirectory: string;
  /** Holds a plan's secret until the person confirms it. Absent on a host with no broker. */
  readonly secrets?: ProviderCredentialStore;
  /** Writes the journal record of a change. Receives no secret. */
  readonly record: (change: ProviderToolingAppliedRecord) => void;
  readonly now?: () => number;
  readonly uuid?: () => string;
}

interface StoredPlan {
  readonly planId: string;
  readonly digest: string;
  readonly expiresAt: number;
  readonly windowId: string;
  readonly instanceId: ProviderInstanceId;
  readonly command: ProviderToolingCommand;
  readonly hasSecret: boolean;
  used: boolean;
}

/** The kind of principal the route authenticated; only a local window may change an account's tools. */
export interface ProviderToolingCaller {
  readonly kind: "local-window" | "remote-device";
  readonly windowId: string;
}

/**
 * Adds and removes tools on a Claude Code or Codex account by running that
 * provider's own commands against the account's folder. Octant never reads or
 * writes the provider's files itself.
 *
 * A change takes two steps. `plan` validates the request, builds the exact
 * argument list, and returns it as the command line the person will read. It
 * holds a secret, if there is one, in the credential broker. `apply` runs only
 * a plan the person confirmed, once, only if what would run is still what was
 * shown. The process gets an argument list, never a shell.
 */
export class ProviderToolingService {
  readonly #options: ProviderToolingServiceOptions;
  readonly #plans = new Map<string, StoredPlan>();
  readonly #tails = new Map<string, Promise<unknown>>();
  readonly #now: () => number;
  readonly #uuid: () => string;
  #directoryReady = false;

  constructor(options: ProviderToolingServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#uuid = options.uuid ?? (() => crypto.randomUUID());
  }

  async list(
    caller: ProviderToolingCaller,
    id: ProviderInstanceId,
  ): Promise<ProviderToolingListResult> {
    const denied = this.#requireLocalWindow(caller);
    if (denied !== undefined) return denied;
    const account = this.#account(id);
    if (account === undefined) return unknownAccount();
    await this.#ensureDirectory();
    const sections = await Promise.all(
      LIST_COMMANDS[account.provider].map(async (command) => {
        const run = await this.#options.runner({
          binary: account.binary,
          argv: command.argv,
          environment: account.environment,
          cwd: this.#options.workingDirectory,
          timeoutMs: LIST_TIMEOUT_MS,
          outputLimitBytes: OUTPUT_LIMIT_BYTES,
        });
        if (run.startFailed) {
          return {
            kind: command.kind,
            status: "failed" as const,
            entries: [],
            lines: [],
            message: "The provider's command line tool could not be started.",
          };
        }
        return readSection({
          provider: account.provider,
          kind: command.kind,
          exitCode: run.exitCode,
          timedOut: run.timedOut,
          output: redactHostSecrets(run.output),
        });
      }),
    );
    return {
      status: "listed",
      provider: account.provider,
      ...(account.directory === undefined ? {} : { accountDirectory: account.directory }),
      runsAsItself: account.runsAsItself,
      sections,
      notes: PROVIDER_TOOLING_NOTES[account.provider],
    };
  }

  async plan(
    caller: ProviderToolingCaller,
    id: ProviderInstanceId,
    request: ProviderToolingRequest,
  ): Promise<ProviderToolingPlanResult> {
    const denied = this.#requireLocalWindow(caller);
    if (denied !== undefined) return denied;
    const account = this.#account(id);
    if (account === undefined) return unknownAccount();
    const built = buildProviderToolingCommand(account.provider, request);
    if (built.status === "refused") {
      return {
        status: "refused",
        reason: built.reason,
        message: built.message,
        ...(built.field === undefined ? {} : { field: built.field }),
      };
    }
    const command = built.command;
    this.#purge();
    if (this.#plans.size >= MAXIMUM_PLANS) {
      return refusal(
        "unavailable",
        "Too many changes are waiting for confirmation. Confirm or dismiss one first.",
      );
    }
    const planId = this.#uuid();
    if (command.secret !== undefined) {
      if (this.#options.secrets === undefined) {
        return refusal(
          "unavailable",
          "This host cannot keep secrets. Add the server from the Octant app, or without a secret.",
        );
      }
      noteIssuedSecret(command.secret.value);
      try {
        await this.#options.secrets.set(planId, command.secret.value);
      } catch {
        return refusal("unavailable", "The secret could not be kept. Nothing was added.");
      }
    }
    const digest = digestOf(id, account, command);
    this.#plans.set(planId, {
      planId,
      digest,
      expiresAt: this.#now() + PLAN_LIFETIME_MS,
      windowId: caller.windowId,
      instanceId: id,
      // The stored command never keeps the secret: it stays in the broker.
      command: withoutSecretValue(command),
      hasSecret: command.secret !== undefined,
      used: false,
    });
    if (command.secret !== undefined) {
      // The broker keeps a secret across a restart, so a plan nobody confirms
      // or cancels must not outlive its lifetime holding one.
      const expiry = setTimeout(() => {
        const waiting = this.#plans.get(planId);
        if (waiting !== undefined && !waiting.used) void this.#discard(waiting);
      }, PLAN_LIFETIME_MS + 1000);
      expiry.unref();
    }
    return {
      status: "planned",
      planId,
      digest,
      expiresAt: new Date(this.#now() + PLAN_LIFETIME_MS).toISOString(),
      provider: account.provider,
      commandKind: command.commandKind,
      commandLine: shownCommandLine(account, command),
      summary: command.summary,
      effects: command.effects,
      usesSecret: command.secret !== undefined,
      runsAsItself: account.runsAsItself,
    };
  }

  /**
   * Drops a change that was shown and not run. A secret held for it is deleted
   * now, because the broker's store survives a restart and nothing else would
   * remove it after the person walked away.
   */
  async cancel(
    caller: ProviderToolingCaller,
    planId: string,
  ): Promise<ProviderToolingCancelResult> {
    const denied = this.#requireLocalWindow(caller);
    if (denied !== undefined) return denied;
    const plan = this.#plans.get(planId);
    if (plan === undefined || plan.windowId !== caller.windowId) {
      return refusal("unknown-plan", "That change is no longer waiting.");
    }
    if (plan.used) return refusal("used-plan", "That change was already run.");
    await this.#discard(plan);
    return { status: "cancelled" };
  }

  async apply(
    caller: ProviderToolingCaller,
    request: ProviderToolingApplyRequest,
  ): Promise<ProviderToolingApplyResult> {
    const denied = this.#requireLocalWindow(caller);
    if (denied !== undefined) return denied;
    const plan = this.#plans.get(request.planId);
    if (plan === undefined || plan.windowId !== caller.windowId) {
      return refusal("unknown-plan", "That change is no longer waiting. Review it again.");
    }
    if (plan.used) return refusal("used-plan", "That change was already run.");
    if (plan.expiresAt <= this.#now()) {
      await this.#discard(plan);
      return refusal("expired-plan", "That change expired. Review it again.");
    }
    if (plan.digest !== request.digest) {
      return refusal("changed-plan", "That is not the command that was shown. Review it again.");
    }
    const account = this.#account(plan.instanceId);
    if (account === undefined || digestOf(plan.instanceId, account, plan.command) !== plan.digest) {
      await this.#discard(plan);
      return refusal(
        "changed-plan",
        "The account changed since the command was shown. Review it again.",
      );
    }
    plan.used = true;
    return this.#serialized(String(plan.instanceId), () => this.#run(plan, account));
  }

  async #run(
    plan: StoredPlan,
    account: ProviderToolingAccount,
  ): Promise<ProviderToolingApplyResult> {
    let secretValue: string | undefined;
    try {
      const variable = plan.command.secret?.variable;
      let environment = account.environment;
      if (plan.hasSecret && variable !== undefined) {
        try {
          secretValue = await this.#options.secrets?.resolve(plan.planId);
        } catch {
          secretValue = undefined;
        }
        if (secretValue === undefined || secretValue === "") {
          return refusal("unavailable", "The secret is no longer held. Nothing was run.");
        }
        environment = { ...account.environment, [variable]: secretValue };
      }
      await this.#ensureDirectory();
      const run = await this.#options.runner({
        binary: account.binary,
        argv: plan.command.argv,
        environment,
        cwd: this.#options.workingDirectory,
        timeoutMs: COMMAND_TIMEOUT_MS,
        outputLimitBytes: OUTPUT_LIMIT_BYTES,
      });
      const output = scrub(run.output, secretValue);
      const succeeded = run.exitCode === 0 && !run.timedOut && !run.startFailed;
      this.#options.record({
        provider: account.provider,
        providerInstanceId: plan.instanceId,
        commandKind: plan.command.commandKind,
        ...(plan.command.name === undefined ? {} : { name: plan.command.name }),
        outcome: succeeded ? "succeeded" : "failed",
        usedSecret: plan.hasSecret,
      });
      if (succeeded) return { status: "applied", output };
      return {
        status: "failed",
        exitCode: run.exitCode,
        timedOut: run.timedOut,
        output,
        message: run.timedOut
          ? "The provider did not finish in time. It may have changed nothing."
          : run.startFailed
            ? "The provider's command line tool could not be started."
            : "The provider's command did not succeed.",
      };
    } finally {
      await this.#discard(plan);
    }
  }

  #account(id: ProviderInstanceId): ProviderToolingAccount | undefined {
    const instance = this.#options.readInstance(id);
    if (instance === undefined) return undefined;
    return resolveProviderToolingAccount(
      instance,
      this.#options.hostEnvironment(),
      this.#options.homeDirectory,
    );
  }

  #requireLocalWindow(caller: ProviderToolingCaller): ProviderToolingRefusal | undefined {
    return caller.kind === "local-window"
      ? undefined
      : refusal(
          "not-a-local-window",
          "Changing an account's tools requires the Octant window on this host.",
        );
  }

  async #ensureDirectory(): Promise<void> {
    if (this.#directoryReady) return;
    await mkdir(this.#options.workingDirectory, { recursive: true, mode: 0o700 });
    this.#directoryReady = true;
  }

  async #discard(plan: StoredPlan): Promise<void> {
    this.#plans.delete(plan.planId);
    if (plan.hasSecret) {
      try {
        await this.#options.secrets?.delete(plan.planId);
      } catch {
        // A secret that cannot be removed stays in the broker until its plan id is
        // deleted; nothing lists the namespace, so a restart does not clear it.
      }
    }
  }

  #purge(): void {
    const now = this.#now();
    for (const plan of this.#plans.values()) {
      if (plan.expiresAt <= now) void this.#discard(plan);
    }
  }

  #serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    this.#tails.set(key, next);
    void next
      .finally(() => {
        if (this.#tails.get(key) === next) this.#tails.delete(key);
      })
      .catch(() => undefined);
    return next;
  }
}

function refusal(
  reason: ProviderToolingRefusal["reason"],
  message: string,
): ProviderToolingRefusal {
  return { status: "refused", reason, message };
}

function unknownAccount(): ProviderToolingRefusal {
  return refusal(
    "unknown-account",
    "Only a Claude Code or Codex account has tools to manage here.",
  );
}

function withoutSecretValue(command: ProviderToolingCommand): ProviderToolingCommand {
  if (command.secret === undefined) return command;
  return { ...command, secret: { variable: command.secret.variable, value: "" } };
}

function shownCommandLine(
  account: ProviderToolingAccount,
  command: ProviderToolingCommand,
): string {
  return formatProviderToolingCommandLine({
    binary: account.binary,
    environment: [
      ...account.shownEnvironment,
      ...(command.secret === undefined
        ? []
        : [{ name: command.secret.variable, value: SECRET_PLACEHOLDER }]),
    ],
    argv: command.argv,
  });
}

/** Binds a confirmation to what would run: the account, the program, the arguments, the variables. */
function digestOf(
  id: ProviderInstanceId,
  account: ProviderToolingAccount,
  command: ProviderToolingCommand,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: String(id),
        binary: account.binary,
        shown: account.shownEnvironment,
        argv: command.argv,
        secretVariable: command.secret?.variable ?? null,
      }),
    )
    .digest("hex");
}

function scrub(output: string, secret: string | undefined): string {
  let text =
    secret === undefined || secret.length === 0
      ? output
      : output.split(secret).join(SECRET_PLACEHOLDER);
  text = redactHostSecrets(text);
  return text.length > RESPONSE_LIMIT ? `${text.slice(0, RESPONSE_LIMIT)}\n[output cut]` : text;
}
