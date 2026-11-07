import { createHash, randomUUID } from "node:crypto";
import { constants, statSync, type Stats } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { onePasswordCommandCredentials, resolveOnePasswordExecutable } from "@octant/host-runtime";
import {
  commandCredentialDefinitionAllowed,
  commandCredentialPostureAllowed,
} from "@octant/domain/command-credential-policy";
import {
  decodeCommandCredentialHostRequest,
  type CommandCredentialBinding,
  type CommandCredentialReceipt,
} from "@octant/contracts/command-credentials";
import type { RepositoryTestProcessInput } from "../code/repositoryTestProcessPort";
import type { RepositoryTestProcessResult } from "../code/repositoryTestRunner";
import type { CommandCredentialContext } from "./commandCredentialBindings";
import type { SecretStoreBrokerClient } from "./secretStoreBrokerClient";
import { COMMAND_CREDENTIAL_RECIPIENT_BOOTSTRAP } from "../process/pinnedRecipientBootstrap";
export interface PreparedCredentialCommand {
  readonly mode: "full-access" | "confined";
  readonly process: {
    execute: (
      input: RepositoryTestProcessInput,
      signal?: AbortSignal,
    ) => Promise<RepositoryTestProcessResult>;
  };
  readonly environment: Readonly<Record<string, string>>;
  readonly admitStart: () => boolean;
  readonly finish: (input: {
    readonly started: boolean;
    readonly exitCode?: number;
  }) => Promise<boolean>;
}
const identity = (details: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs">) =>
  `${details.dev}:${details.ino}:${details.size}:${details.mtimeMs}:${details.ctimeMs}`;
export async function pinCommandExecutable(
  candidate: string,
): Promise<
  { readonly executable: string; readonly digest: string; readonly identity: string } | undefined
> {
  if (!isAbsolute(candidate)) return undefined;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const executable = await realpath(candidate);
    await access(executable, constants.X_OK);
    handle = await open(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size > 64 * 1024 * 1024) return undefined;
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let size = 0;
    while (true) {
      const part = await handle.read(buffer, 0, buffer.length, null);
      if (part.bytesRead === 0) break;
      size += part.bytesRead;
      if (size > 64 * 1024 * 1024) return undefined;
      hash.update(buffer.subarray(0, part.bytesRead));
    }
    const digest = hash.digest("hex");
    const after = await handle.stat();
    if (identity(before) !== identity(after)) return undefined;
    return { executable, digest, identity: identity(after) };
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}
export function createCommandCredentialExecution(options: {
  readonly process: {
    execute: (
      input: RepositoryTestProcessInput,
      signal?: AbortSignal,
    ) => Promise<RepositoryTestProcessResult>;
  };
  readonly broker: Pick<SecretStoreBrokerClient, "commandUse"> | undefined;
  readonly prepare?: (input: {
    readonly binding: CommandCredentialBinding;
    readonly context: CommandCredentialContext;
    readonly recipientIdentity: string;
    readonly signal: AbortSignal;
  }) => Promise<
    | { readonly status: "admitted"; readonly command: PreparedCredentialCommand }
    | { readonly status: "refused" }
  >;
}) {
  return async (
    binding: CommandCredentialBinding,
    context: CommandCredentialContext,
    signal: AbortSignal,
    current: () => boolean,
    onStart: () => void,
  ): Promise<Omit<CommandCredentialReceipt, "kind" | "requestId">> => {
    let started = false;
    const none = {
      status: "unavailable" as const,
      effect: "none" as const,
      output: "",
      truncated: false,
    };
    if (
      !current() ||
      signal.aborted ||
      !commandCredentialPostureAllowed(context.executionPolicy) ||
      (context.executionPolicy !== "full-access" && options.prepare === undefined) ||
      !commandCredentialDefinitionAllowed(binding.definition)
    )
      return { ...none, status: "refused" };
    try {
      const op = await pinCommandExecutable(binding.credentialExecutable);
      if (
        op === undefined ||
        op.executable !== binding.credentialExecutable ||
        op.digest !== binding.credentialExecutableDigest ||
        options.broker?.commandUse === undefined
      )
        return none;
      const recipient = await pinCommandExecutable(binding.definition.executable);
      if (
        recipient === undefined ||
        recipient.executable !== binding.definition.executable ||
        recipient.digest !== binding.executableDigest
      )
        return { ...none, status: "refused" };
      // This is the already trusted host runtime, not another PATH candidate.
      // Its identity is checked again at parent launch; recipient bounds stay unchanged.
      const runtime = await realpath(process.execPath);
      await access(runtime, constants.X_OK);
      const runtimeDetails = await stat(runtime);
      if (!runtimeDetails.isFile()) return none;
      const runtimeIdentity = identity(runtimeDetails);
      const root = await realpath(context.root);
      const directory = await realpath(resolve(root, binding.definition.directory));
      const path = relative(root, directory);
      if (
        path === ".." ||
        path.startsWith(`..${sep}`) ||
        isAbsolute(path) ||
        (await stat(directory)).isDirectory() !== true
      )
        return { ...none, status: "refused" };
      const rootIdentity = identity(await stat(root));
      const directoryIdentity = identity(await stat(directory));
      const request = decodeCommandCredentialHostRequest({
        requestId: randomUUID(),
        bindingId: binding.bindingId,
        accountId: binding.definition.accountId,
        environment: binding.definition.environment,
      });
      const first = await options.broker.commandUse(request);
      if (first.status !== "authorized") return { ...none, status: "refused" };
      const launch = onePasswordCommandCredentials({
        ...binding.definition,
        executable: runtime,
        args: [
          "-e",
          COMMAND_CREDENTIAL_RECIPIENT_BOOTSTRAP,
          "--",
          recipient.executable,
          recipient.digest,
          recipient.identity,
          ...binding.definition.args,
        ],
      });
      const final = await options.broker.commandUse({
        ...request,
        expectedRevision: first.revision,
      });
      if (
        final.status !== "authorized" ||
        final.revision !== first.revision ||
        !current() ||
        signal.aborted
      )
        return { ...none, status: "refused" };
      const opIdentity = op.identity;
      const opPath = op.executable;
      const prepared = await options.prepare?.({
        binding,
        context,
        recipientIdentity: recipient.identity,
        signal,
      });
      if (prepared?.status === "refused") return { ...none, status: "refused" };
      const command = prepared?.command;
      const admitStart = async () => {
        const linked = await options.broker?.commandUse?.({
          ...request,
          expectedRevision: first.revision,
        });
        if (linked?.status !== "authorized" || linked.revision !== first.revision) return false;
        if (!(await context.revalidate())) return false;
        try {
          return (
            current() &&
            !signal.aborted &&
            commandCredentialPostureAllowed(context.executionPolicy) &&
            identity(statSync(opPath)) === opIdentity &&
            identity(statSync(runtime)) === runtimeIdentity &&
            identity(statSync(recipient.executable)) === recipient.identity &&
            identity(statSync(root)) === rootIdentity &&
            identity(statSync(directory)) === directoryIdentity &&
            (command?.admitStart() ?? true)
          );
        } catch {
          return false;
        }
      };
      let result: RepositoryTestProcessResult;
      try {
        result = await (command?.process ?? options.process).execute(
          {
            argv:
              command?.mode === "confined"
                ? [recipient.executable, ...binding.definition.args]
                : [opPath, ...launch.args],
            cwd: directory,
            environment: {
              ...launch.environment,
              NO_COLOR: "1",
              TERM: "dumb",
              ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
              ...command?.environment,
            },
            timeoutMs: binding.definition.timeoutMs,
            admitStart,
            onStarted: () => {
              started = true;
              onStart();
            },
          },
          signal,
        );
      } catch (error) {
        await command?.finish({ started });
        throw error;
      }
      if (
        command !== undefined &&
        !(await command.finish({
          started,
          ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        }))
      )
        return { ...none, status: "failed", effect: started ? "possible" : "none" };
      const raw = Buffer.concat([Buffer.from(result.stdout), Buffer.from(result.stderr)]);
      const bytes = raw.subarray(0, 24 * 1024);
      const output = bytes.toString("utf8");
      return {
        status: result.cleanupUncertain ? "failed" : result.termination,
        effect: started
          ? result.termination === "exited" && !result.cleanupUncertain
            ? "completed"
            : "possible"
          : "none",
        ...(result.exitCode === null ? {} : { exitCode: result.exitCode }),
        output,
        truncated: raw.byteLength > bytes.byteLength || result.outputTruncated === true,
      };
    } catch {
      return {
        status: "failed",
        effect: started ? "possible" : "none",
        output: "",
        truncated: false,
      };
    }
  };
}

export function commandCredentialRecipientPin(process: {
  readonly execute: (input: RepositoryTestProcessInput) => Promise<RepositoryTestProcessResult>;
}) {
  return async (executable: string) => {
    const recipient = await pinCommandExecutable(executable);
    if (recipient === undefined) return undefined;
    const selected = await resolveOnePasswordExecutable();
    if (selected === undefined) return undefined;
    const op = await pinCommandExecutable(selected);
    if (op === undefined) return undefined;
    const version = await process.execute({
      argv: [op.executable, "--version"],
      cwd: "/",
      environment: { NO_COLOR: "1", TERM: "dumb" },
      timeoutMs: 3000,
      admitStart: () => {
        try {
          return identity(statSync(op.executable)) === op.identity;
        } catch {
          return false;
        }
      },
    });
    const text = Buffer.from(version.stdout).toString("utf8").trim();
    if (
      version.termination !== "exited" ||
      version.exitCode !== 0 ||
      version.outputTruncated ||
      !/^2\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(text)
    )
      return undefined;
    const after = await pinCommandExecutable(op.executable);
    if (after?.digest !== op.digest) return undefined;
    return {
      ...recipient,
      credentialExecutable: op.executable,
      credentialExecutableDigest: op.digest,
      credentialVersion: text,
    };
  };
}
