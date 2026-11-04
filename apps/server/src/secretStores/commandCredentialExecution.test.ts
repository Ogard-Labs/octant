import { existsSync, mkdtempSync, realpathSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it, expect, vi } from "vitest";
import { decodeCommandCredentialBinding } from "@octant/contracts/command-credentials";
import { RepositoryTestProcessPort } from "../code/repositoryTestProcessPort";
import {
  createCommandCredentialExecution,
  pinCommandExecutable,
} from "./commandCredentialExecution";
const directories: string[] = [];
afterEach(() => {
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
describe("fixed command credential execution", () => {
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
