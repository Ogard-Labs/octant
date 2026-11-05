import { existsSync, mkdtempSync, realpathSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it, expect, vi } from "vitest";
import { decodeCommandCredentialBinding } from "@octant/contracts/command-credentials";
import {
  decodeCodeThread,
  decodeToolActionAuthority,
  type ProviderExecutionPolicy,
} from "@octant/contracts";
import {
  createNativeHarnessComposition,
  type NativeHarnessComposition,
} from "../harness/nativeHarnessComposition";
import {
  startEgressHarness,
  closeEgressHarnesses,
} from "../harness/nativeHarnessEgressProxy.test-support";
import type { ToolEgressRules } from "../harness/nativeHarnessEgressRules";
import { createCommandCredentialPreparation } from "./commandCredentialPreparation";
import { CommandCredentialBindings } from "./commandCredentialBindings";
import { ToolCallAuthorityService } from "../toolCallAuthorityService";
import { RepositoryTestProcessPort } from "../code/repositoryTestProcessPort";
import {
  createCommandCredentialExecution,
  pinCommandExecutable,
} from "./commandCredentialExecution";
const directories: string[] = [];
afterEach(async () => {
  await closeEgressHarnesses();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-command-credential-")));
  directories.push(root);
  const cli = join(root, "fixture-op");
  writeFileSync(
    cli,
    '#!/bin/sh\n[ "$1" = run ] && [ "$2" = --account ] && [ "$4" = -- ] || exit 91\n[ "$API_TOKEN" = "op://vvvvvvvvvvvvvvvvvvvvvvvvvv/iiiiiiiiiiiiiiiiiiiiiiiiii/credential" ] || exit 92\n[ -z "$OP_SESSION" ] && [ -z "$OCTANT_PRIVATE" ] || exit 93\nshift 4\nexec "$@"\n',
    { mode: 0o700 },
  );
  const op = await pinCommandExecutable(cli);
  const recipient = await pinCommandExecutable("/bin/echo");
  if (op === undefined || recipient === undefined) throw Error("Fixture executable unavailable");
  const binding = decodeCommandCredentialBinding({
    kind: "command-credential-binding",
    bindingId: randomUUID(),
    revision: 1,
    credentialExecutable: op.executable,
    credentialExecutableDigest: op.digest,
    credentialVersion: "2.33.0",
    definition: {
      label: "Synthetic recipient",
      projectId: randomUUID(),
      executable: recipient.executable,
      args: ["fixture accepted"],
      directory: "",
      accountId: "a".repeat(26),
      environment: [
        {
          name: "API_TOKEN",
          vaultId: "v".repeat(26),
          itemId: "i".repeat(26),
          fieldId: "credential",
        },
      ],
      timeoutMs: 3000,
    },
    executableDigest: recipient.digest,
  });
  const context = {
    windowId: randomUUID(),
    threadId: randomUUID(),
    projectId: String(binding.definition.projectId),
    root,
    authorityKey: "fixture",
    executionPolicy: "full-access",
    current: () => true,
    revalidate: async () => true,
  };
  return { root, binding, context };
}

function threadFor(
  f: Awaited<ReturnType<typeof fixture>>,
  executionPolicy: ProviderExecutionPolicy,
) {
  const now = "2026-11-04T00:00:00.000Z";
  return decodeCodeThread({
    id: f.context.threadId,
    projectId: f.context.projectId,
    bindingRevisionId: randomUUID(),
    repositoryId: `repo_${"a".repeat(64)}`,
    checkoutId: randomUUID(),
    title: "Fixture",
    lifecycle: "active",
    providerInstanceId: randomUUID(),
    modelId: "fixture",
    executionPolicy,
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "feature/fixture",
      remoteName: "origin",
      proposedBaseRepository: "octant/fixture",
      proposedBaseBranch: "main",
      outcomeKind: "opened-pr",
      confirmedAt: now,
    },
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
}

describe("fixed command credential execution", () => {
  it("forwards confirmed hosts only to their own proxy launch and finishes each scope once", async () => {
    const f = await fixture();
    const thread = threadFor(f, "approval-gated");
    const confirmed = {
      approvalId: randomUUID(),
      principal: { kind: "local-window" as const },
      hosts: [{ host: "allowed.example.test", port: 443 }],
    };
    const ordinaryFinish = vi.fn(() => "no-change" as const);
    const ordinary = vi
      .fn<NativeHarnessComposition["prepareCodeCommand"]>()
      .mockResolvedValueOnce({
        status: "admitted",
        callId: randomUUID(),
        confirmedHosts: confirmed,
        admitStart: () => true,
        finish: ordinaryFinish,
      })
      .mockResolvedValueOnce({
        status: "admitted",
        callId: randomUUID(),
        admitStart: () => true,
        finish: ordinaryFinish,
      });
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    const startLaunch = vi.fn<ToolEgressRules["startLaunch"]>(async (input) => {
      const harness = await startEgressHarness({ launch: input.launch });
      const finish = vi.fn(() => harness.proxy.close());
      closes.push(finish);
      return { status: "listening", launch: { proxy: harness.proxy, finish } };
    });
    const prepare = createCommandCredentialPreparation({
      readThread: () => thread,
      ordinary: { prepareCodeCommand: ordinary },
      egress: { startLaunch },
      endpoint: { kind: "loopback" },
      fullAccessProcess: { execute: vi.fn() },
      temporaryDirectory: f.root,
      receiptDirectory: join(f.root, "receipts"),
      uuid: randomUUID,
    });
    const recipient = await pinCommandExecutable(f.binding.definition.executable);
    if (recipient === undefined) throw Error("Recipient unavailable");
    const input = {
      binding: f.binding,
      context: { ...f.context, executionPolicy: "approval-gated" },
      recipientIdentity: recipient.identity,
      signal: new AbortController().signal,
    };
    const first = await prepare(input);
    if (first.status !== "admitted") throw Error("First launch refused");
    expect(startLaunch.mock.calls[0]?.[0].confirmed).toEqual(confirmed);
    expect(await first.command.finish({ started: false })).toBe(true);
    expect(await first.command.finish({ started: false })).toBe(true);
    expect(closes[0]).toHaveBeenCalledOnce();
    const second = await prepare(input);
    if (second.status !== "admitted") throw Error("Second launch refused");
    expect(startLaunch.mock.calls[1]?.[0].confirmed).toBeUndefined();
    await second.command.finish({ started: false });
    expect(ordinaryFinish).toHaveBeenCalledTimes(2);
  });
  it("withholds real recipient output when the prepared launch cannot finish its audit", async () => {
    const f = await fixture();
    const port = new RepositoryTestProcessPort({
      temporaryDirectory: f.root,
      receiptDirectory: join(f.root, "receipts"),
      confinement: { prepare: ({ executable, args }) => ({ command: executable, args }) },
    });
    const result = await createCommandCredentialExecution({
      process: port,
      broker: { commandUse: async () => ({ status: "authorized" as const, revision: "one" }) },
      prepare: async () => ({
        status: "admitted",
        command: {
          mode: "full-access",
          process: port,
          environment: {},
          admitStart: () => true,
          finish: async () => false,
        },
      }),
    })(
      f.binding,
      f.context,
      new AbortController().signal,
      () => true,
      () => undefined,
    );
    expect(result).toMatchObject({ status: "failed", effect: "possible", output: "" });
  });
  it("runs Full access through ordinary preparation once and replays the same approved process receipt", async () => {
    const f = await fixture();
    const thread = threadFor(f, "full-access");
    const ordinaryFinish = vi.fn(() => "no-change" as const);
    const ordinary = vi.fn(async () => ({
      status: "admitted" as const,
      callId: randomUUID(),
      admitStart: () => true,
      finish: ordinaryFinish,
    }));
    const startLaunch = vi.fn(async () => ({
      status: "refused" as const,
      reason: "listener-unavailable" as const,
    }));
    const port = new RepositoryTestProcessPort({
      temporaryDirectory: f.root,
      receiptDirectory: join(f.root, "receipts"),
      confinement: { prepare: ({ executable, args }) => ({ command: executable, args }) },
    });
    const prepare = createCommandCredentialPreparation({
      readThread: () => thread,
      ordinary: { prepareCodeCommand: ordinary },
      egress: { startLaunch },
      endpoint: { kind: "loopback" },
      fullAccessProcess: port,
      temporaryDirectory: f.root,
      receiptDirectory: join(f.root, "receipts"),
      uuid: randomUUID,
    });
    const service = new CommandCredentialBindings({
      now: () => performance.now(),
      uuid: randomUUID,
      canConfigure: () => true,
      context: async () => f.context,
      pin: async () => ({
        executable: f.binding.definition.executable,
        digest: f.binding.executableDigest,
        credentialExecutable: f.binding.credentialExecutable,
        credentialExecutableDigest: f.binding.credentialExecutableDigest,
        credentialVersion: f.binding.credentialVersion,
      }),
      execute: createCommandCredentialExecution({
        process: port,
        prepare,
        broker: { commandUse: async () => ({ status: "authorized" as const, revision: "one" }) },
      }),
      record: () => undefined,
      records: [],
    });
    try {
      const saved = await service.save(f.context.windowId, f.binding.definition);
      if (saved.kind !== "command-credential-view" || saved.bindings[0] === undefined)
        throw Error("Binding not saved");
      const review = await service.review(
        f.context.windowId,
        f.context.threadId,
        saved.bindings[0].bindingId,
        randomUUID(),
      );
      if (review.kind !== "command-credential-view" || review.requests[0] === undefined)
        throw Error("Review unavailable");
      const request = review.requests[0].requestId;
      const first = await service.approve(f.context.windowId, request);
      expect(first).toMatchObject({ status: "exited", exitCode: 0, output: "fixture accepted\n" });
      expect(await service.approve(f.context.windowId, request)).toEqual(first);
      expect(ordinary).toHaveBeenCalledOnce();
      expect(ordinaryFinish).toHaveBeenCalledOnce();
      expect(startLaunch).not.toHaveBeenCalled();
    } finally {
      service.close();
    }
  });
  it("starts no authentication parent or proxy when ordinary command policy refuses credential use", async () => {
    const f = await fixture();
    const execute = vi.fn();
    const startLaunch = vi.fn(async () => ({
      status: "refused" as const,
      reason: "listener-unavailable" as const,
    }));
    const prepare = createCommandCredentialPreparation({
      readThread: () => threadFor(f, "approval-gated"),
      ordinary: {
        prepareCodeCommand: async () => ({ status: "refused", reason: "approval-denied" }),
      },
      egress: { startLaunch },
      endpoint: { kind: "loopback" },
      fullAccessProcess: { execute },
      temporaryDirectory: f.root,
      receiptDirectory: join(f.root, "receipts"),
      uuid: randomUUID,
    });
    const result = await createCommandCredentialExecution({
      process: { execute },
      prepare,
      broker: { commandUse: async () => ({ status: "authorized" as const, revision: "one" }) },
    })(
      f.binding,
      { ...f.context, executionPolicy: "approval-gated" },
      new AbortController().signal,
      () => true,
      () => undefined,
    );
    expect(result).toMatchObject({ status: "refused", effect: "none", output: "" });
    expect(execute).not.toHaveBeenCalled();
    expect(startLaunch).not.toHaveBeenCalled();
  });
  it.each(["authority", "posture", "window"])(
    "starts no authentication parent when %s changes during ordinary command approval",
    async (changed) => {
      const f = await fixture();
      const now = "2026-11-04T00:00:00.000Z";
      const thread = threadFor(f, "approval-gated");
      let authority = decodeToolActionAuthority({
        hostId: randomUUID(),
        mode: "code",
        projectId: thread.projectId,
        rootId: randomUUID(),
        worktreeId: randomUUID(),
        providerInstanceId: thread.providerInstanceId,
        extension: { kind: "core" },
      });
      let posture: ProviderExecutionPolicy = "approval-gated",
        windowCurrent = true;
      let answer: ((value: "approved") => void) | undefined;
      const asked = vi.fn(
        () =>
          new Promise<"approved">((resolve) => {
            answer = resolve;
          }),
      );
      const composition = createNativeHarnessComposition({
        authority: {
          resolve: () => authority,
          service: new ToolCallAuthorityService({
            resolveGrantedAuthority: () => authority,
            resolveLiveFacts: () => ({
              providerAppManagedTools: "supported",
              host: { computerUseEnabled: false },
              executionPolicy: posture,
              approvalSatisfied: false,
              externalContentIngested: false,
            }),
          }),
        },
        isChildAuthorityCurrent: () => true,
        isHarnessProvider: () => false,
        readCodeExecutionPolicy: () => posture,
        approvals: { ask: asked },
        hostId: authority.hostId,
        readThreadTaint: () => false,
        recordExternalContentIngestion: () => ({ kind: "ignored", reason: "not-tainting" }),
        uuid: randomUUID,
        clock: () => now,
      });
      const spawn = vi.fn(() => {
        throw Error("Unexpected authentication parent spawn");
      });
      const port = new RepositoryTestProcessPort({
        temporaryDirectory: f.root,
        receiptDirectory: join(f.root, "receipts"),
        spawn,
        confinement: { prepare: ({ executable, args }) => ({ command: executable, args }) },
      });
      const execution = createCommandCredentialExecution({
        process: port,
        broker: { commandUse: async () => ({ status: "authorized" as const, revision: "one" }) },
        prepare: async ({ signal }) => {
          const policy = await composition.prepareCodeCommand({
            thread,
            checkoutRoot: f.root,
            windowId: f.context.windowId,
            command: "'/bin/echo' 'fixture accepted'",
            signal,
          });
          return policy.status === "refused"
            ? { status: "refused" }
            : {
                status: "admitted",
                command: {
                  mode: "full-access",
                  process: port,
                  environment: {},
                  admitStart: policy.admitStart,
                  finish: async (result) => policy.finish(result) !== "unavailable",
                },
              };
        },
      })(
        f.binding,
        { ...f.context, executionPolicy: "approval-gated", current: () => windowCurrent },
        new AbortController().signal,
        () => windowCurrent,
        () => undefined,
      );
      await vi.waitFor(() => expect(asked).toHaveBeenCalledOnce());
      if (changed === "authority")
        authority = decodeToolActionAuthority({ ...authority, rootId: randomUUID() });
      if (changed === "posture") posture = "plan";
      if (changed === "window") windowCurrent = false;
      if (answer === undefined) throw Error("Ordinary approval did not wait");
      answer("approved");
      expect(await execution).toMatchObject({ effect: "none", output: "" });
      expect(spawn).not.toHaveBeenCalled();
    },
  );
  it("refuses a previously saved runtime-variable mapping before starting the credential tool", async () => {
    const f = await fixture();
    const binding = decodeCommandCredentialBinding({
      ...f.binding,
      definition: {
        ...f.binding.definition,
        environment: [{ ...f.binding.definition.environment[0], name: "ELECTRON_RUN_AS_NODE" }],
      },
    });
    const execute = vi.fn();
    const commandUse = vi.fn();
    expect(
      await createCommandCredentialExecution({ process: { execute }, broker: { commandUse } })(
        binding,
        f.context,
        new AbortController().signal,
        () => true,
        () => undefined,
      ),
    ).toMatchObject({ status: "refused", effect: "none", output: "" });
    expect(execute).not.toHaveBeenCalled();
    expect(commandUse).not.toHaveBeenCalled();
  });
  it("refuses a recipient replaced while the authentication parent waits before launching it", async () => {
    const f = await fixture();
    const cli = f.binding.credentialExecutable;
    const executable = join(f.root, "recipient");
    writeFileSync(executable, "#!/bin/sh\nprintf 'original recipient\\n'\n", { mode: 0o700 });
    writeFileSync(
      cli,
      '#!/bin/sh\n: > "$0.ready"\nn=0\nwhile [ ! -f "$0.release" ]; do\n n=$((n+1))\n [ "$n" -lt 200 ] || exit 94\n sleep 0.01\ndone\nshift 4\nexec "$@"\n',
      { mode: 0o700 },
    );
    const op = await pinCommandExecutable(cli);
    const recipient = await pinCommandExecutable(executable);
    if (op === undefined || recipient === undefined) throw Error("Fixture executable unavailable");
    const binding = decodeCommandCredentialBinding({
      ...f.binding,
      credentialExecutableDigest: op.digest,
      executableDigest: recipient.digest,
      definition: { ...f.binding.definition, executable: recipient.executable, args: [] },
    });
    const port = new RepositoryTestProcessPort({
      temporaryDirectory: f.root,
      receiptDirectory: join(f.root, "receipts"),
      confinement: { prepare: ({ executable, args }) => ({ command: executable, args }) },
    });
    const execution = createCommandCredentialExecution({
      process: port,
      broker: {
        commandUse: async () => ({ status: "authorized" as const, revision: "linked-one" }),
      },
    })(
      binding,
      f.context,
      new AbortController().signal,
      () => true,
      () => undefined,
    );
    try {
      const deadline = Date.now() + 1500;
      while (!existsSync(`${cli}.ready`) && Date.now() < deadline) await delay(10);
      expect(existsSync(`${cli}.ready`)).toBe(true);
      const replacement = join(f.root, "replacement");
      writeFileSync(replacement, "#!/bin/sh\nprintf 'replacement recipient executed\\n'\n", {
        mode: 0o700,
      });
      renameSync(replacement, executable);
      writeFileSync(`${cli}.release`, "");
      const result = await execution;
      expect(result).toMatchObject({
        status: "exited",
        exitCode: 126,
        effect: "completed",
        output: "",
      });
      expect(result.output).not.toContain("replacement recipient executed");
    } finally {
      writeFileSync(`${cli}.release`, "");
      await execution;
    }
  });
  it("runs only the pinned synthetic CLI and recipient with reference-only environment through the real owned process port", async () => {
    const f = await fixture();
    vi.stubEnv("OP_SESSION", "fixture-ambient-session");
    vi.stubEnv("OCTANT_PRIVATE", "fixture-private");
    const started = vi.fn();
    const broker = {
      commandUse: vi.fn(async () => ({ status: "authorized" as const, revision: "linked-one" })),
    };
    const port = new RepositoryTestProcessPort({
      temporaryDirectory: f.root,
      receiptDirectory: join(f.root, "receipts"),
      confinement: { prepare: ({ executable, args }) => ({ command: executable, args }) },
    });
    const result = await createCommandCredentialExecution({ process: port, broker })(
      f.binding,
      f.context,
      new AbortController().signal,
      () => true,
      started,
    );
    expect(result).toMatchObject({
      status: "exited",
      exitCode: 0,
      effect: "completed",
      output: "fixture accepted\n",
    });
    expect(started).toHaveBeenCalledOnce();
    expect(broker.commandUse).toHaveBeenCalledTimes(3);
  });
  it("excludes inherited runtime loaders before the credential tool and bootstrap start", async () => {
    const f = await fixture();
    const injected = join(f.root, "injected");
    const loader = join(f.root, "loader.cjs");
    writeFileSync(
      loader,
      `require("node:fs").writeFileSync(${JSON.stringify(injected)}, "loaded");`,
    );
    vi.stubEnv("NODE_OPTIONS", `--require=${loader}`);
    vi.stubEnv("NODE_PATH", f.root);
    vi.stubEnv("BUN_OPTIONS", `--preload=${loader}`);
    vi.stubEnv("ELECTRON_RUN_AS_NODE", "0");
    vi.stubEnv("LD_PRELOAD", loader);
    vi.stubEnv("LD_LIBRARY_PATH", f.root);
    vi.stubEnv("DYLD_INSERT_LIBRARIES", loader);
    const port = new RepositoryTestProcessPort({
      temporaryDirectory: f.root,
      receiptDirectory: join(f.root, "receipts"),
      confinement: { prepare: ({ executable, args }) => ({ command: executable, args }) },
    });
    const result = await createCommandCredentialExecution({
      process: port,
      broker: { commandUse: async () => ({ status: "authorized" as const, revision: "one" }) },
    })(
      f.binding,
      f.context,
      new AbortController().signal,
      () => true,
      () => undefined,
    );
    expect(result).toMatchObject({ status: "exited", exitCode: 0, output: "fixture accepted\n" });
    expect(existsSync(injected)).toBe(false);
  });
  it("cancels the same owned process group after the bootstrap starts the recipient", async () => {
    const f = await fixture();
    const executable = join(f.root, "waiting-recipient");
    writeFileSync(
      executable,
      '#!/bin/sh\n: > "$0.ready"\ntrap "exit 0" TERM\nwhile :; do sleep 0.05; done\n',
      { mode: 0o700 },
    );
    const recipient = await pinCommandExecutable(executable);
    if (recipient === undefined) throw Error("Fixture executable unavailable");
    const binding = decodeCommandCredentialBinding({
      ...f.binding,
      executableDigest: recipient.digest,
      definition: { ...f.binding.definition, executable: recipient.executable, args: [] },
    });
    const controller = new AbortController();
    const port = new RepositoryTestProcessPort({
      temporaryDirectory: f.root,
      receiptDirectory: join(f.root, "receipts"),
      confinement: { prepare: ({ executable, args }) => ({ command: executable, args }) },
    });
    const execution = createCommandCredentialExecution({
      process: port,
      broker: { commandUse: async () => ({ status: "authorized" as const, revision: "one" }) },
    })(
      binding,
      f.context,
      controller.signal,
      () => true,
      () => undefined,
    );
    try {
      const deadline = Date.now() + 1500;
      while (!existsSync(`${executable}.ready`) && Date.now() < deadline) await delay(10);
      expect(existsSync(`${executable}.ready`)).toBe(true);
      controller.abort();
      expect(await execution).toMatchObject({ status: "cancelled", effect: "possible" });
    } finally {
      controller.abort();
      await execution;
    }
  });
  it("starts no child when the linked-store revision changes during actual launch preparation", async () => {
    const f = await fixture();
    let changed = false;
    const spawn = vi.fn();
    const started = vi.fn();
    const broker = {
      commandUse: vi.fn(async () =>
        changed
          ? { status: "changed" as const }
          : { status: "authorized" as const, revision: "linked-one" },
      ),
    };
    const port = new RepositoryTestProcessPort({
      temporaryDirectory: f.root,
      spawn,
      confinement: {
        prepare: ({ executable, args }) => {
          changed = true;
          return { command: executable, args };
        },
      },
    });
    const result = await createCommandCredentialExecution({ process: port, broker })(
      f.binding,
      f.context,
      new AbortController().signal,
      () => true,
      started,
    );
    expect(result).toMatchObject({ status: "cancelled", effect: "none" });
    expect(spawn).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(broker.commandUse).toHaveBeenCalledTimes(3);
  });
  it("refuses a replaced CLI without discovering another PATH candidate", async () => {
    const f = await fixture();
    writeFileSync(f.binding.credentialExecutable, "#!/bin/sh\nexit 0\n");
    const execute = vi.fn();
    const broker = {
      commandUse: vi.fn(async () => ({ status: "authorized" as const, revision: "one" })),
    };
    expect(
      await createCommandCredentialExecution({ process: { execute }, broker })(
        f.binding,
        f.context,
        new AbortController().signal,
        () => true,
        () => undefined,
      ),
    ).toMatchObject({ effect: "none", status: "unavailable" });
    expect(execute).not.toHaveBeenCalled();
    expect(broker.commandUse).not.toHaveBeenCalled();
  });
});
