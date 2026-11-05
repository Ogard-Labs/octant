import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { decodeCommandCredentialBinding } from "@octant/contracts/command-credentials";
import * as confinement from "../process/seatbeltProfile";
import { buildBubblewrapLaunch } from "../process/linuxConfinement";
import { pinCommandExecutable } from "./commandCredentialExecution";
import { confinedCommandCredentialProcess } from "./confinedCommandCredentialProcess";

const state = vi.hoisted(() => ({ home: undefined as string | undefined }));
vi.mock("node:os", async (original) => {
  const actual = await original<typeof import("node:os")>();
  return { ...actual, homedir: () => state.home ?? actual.homedir() };
});

it("masks both credential CLI config roots when the recipient's Linux read roots include its home", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-credential-linux-mask-")));
  const home = join(root, "home"),
    project = join(root, "project"),
    work = join(root, "work"),
    sockets = join(root, "egress");
  for (const path of [home, project, work, sockets, join(home, ".op"), join(home, ".config", "op")])
    mkdirSync(path, { recursive: true });
  state.home = home;
  const bwrap = join(root, "bwrap"),
    cli = join(root, "fixture-op");
  writeFileSync(bwrap, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  // Only construction is exercised: the fake auth parent never starts bwrap.
  writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  let prepared: confinement.ConfinedProcessLaunch | undefined;
  const spy = vi.spyOn(confinement, "makeProcessConfinementLive").mockReturnValue({
    prepare: (input) => {
      prepared = buildBubblewrapLaunch(input, { bwrapPath: bwrap });
      return prepared;
    },
  });
  try {
    const op = await pinCommandExecutable(cli),
      recipient = await pinCommandExecutable("/bin/echo");
    if (op === undefined || recipient === undefined) throw Error("Fixture executable unavailable");
    const binding = decodeCommandCredentialBinding({
      kind: "command-credential-binding",
      bindingId: randomUUID(),
      revision: 1,
      credentialExecutable: op.executable,
      credentialExecutableDigest: op.digest,
      credentialVersion: "2.33.0",
      executableDigest: recipient.digest,
      definition: {
        label: "Synthetic mask check",
        projectId: randomUUID(),
        executable: recipient.executable,
        args: ["check"],
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
        timeoutMs: 2000,
      },
    });
    const launch = confinedCommandCredentialProcess({
      binding,
      recipientIdentity: recipient.identity,
      checkoutRoot: project,
      networkEgress: {
        kind: "proxied",
        endpoint: { kind: "unix-socket", path: join(sockets, "proxy.sock") },
      },
      proxyUrl: "http://octant:synthetic@127.0.0.1:3128",
      temporaryDirectory: work,
      receiptDirectory: join(root, "receipts"),
    });
    const result = await launch.process.execute({
      argv: [recipient.executable, "check"],
      cwd: project,
      environment: launch.environment,
      additionalReadRoots: [home],
      timeoutMs: 2000,
    });
    expect(result).toMatchObject({ termination: "exited", exitCode: 0 });
    if (prepared === undefined) throw Error("Linux preparation did not run");
    for (const path of [join(home, ".op"), join(home, ".config", "op")]) {
      expect(
        prepared.args.some(
          (argument, index) => argument === "--tmpfs" && prepared?.args[index + 1] === path,
        ),
      ).toBe(true);
    }
  } finally {
    spy.mockRestore();
    state.home = undefined;
    rmSync(root, { recursive: true, force: true });
  }
});

it("lets a recipient started in a checkout subdirectory write anywhere in that checkout", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-credential-checkout-root-")));
  const checkout = join(root, "checkout"),
    packageDirectory = join(checkout, "packages", "client"),
    work = join(root, "work"),
    sockets = join(root, "egress");
  for (const path of [packageDirectory, work, sockets]) mkdirSync(path, { recursive: true });
  const cli = join(root, "fixture-op");
  // Only the confinement input is inspected: the fake auth parent exits at once.
  writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  let prepared:
    | Parameters<ReturnType<typeof confinement.makeProcessConfinementLive>["prepare"]>[0]
    | undefined;
  const spy = vi.spyOn(confinement, "makeProcessConfinementLive").mockReturnValue({
    prepare: (input) => {
      prepared = input;
      return { command: "/bin/true", args: [] };
    },
  });
  try {
    const op = await pinCommandExecutable(cli),
      recipient = await pinCommandExecutable("/bin/echo");
    if (op === undefined || recipient === undefined) throw Error("Fixture executable unavailable");
    const binding = decodeCommandCredentialBinding({
      kind: "command-credential-binding",
      bindingId: randomUUID(),
      revision: 1,
      credentialExecutable: op.executable,
      credentialExecutableDigest: op.digest,
      credentialVersion: "2.33.0",
      executableDigest: recipient.digest,
      definition: {
        label: "Synthetic subdirectory build",
        projectId: randomUUID(),
        executable: recipient.executable,
        args: ["build"],
        directory: "packages/client",
        accountId: "a".repeat(26),
        environment: [
          {
            name: "API_TOKEN",
            vaultId: "v".repeat(26),
            itemId: "i".repeat(26),
            fieldId: "credential",
          },
        ],
        timeoutMs: 2000,
      },
    });
    const launch = confinedCommandCredentialProcess({
      binding,
      recipientIdentity: recipient.identity,
      checkoutRoot: checkout,
      networkEgress: {
        kind: "proxied",
        endpoint: { kind: "unix-socket", path: join(sockets, "proxy.sock") },
      },
      proxyUrl: "http://octant:synthetic@127.0.0.1:3128",
      temporaryDirectory: work,
      receiptDirectory: join(root, "receipts"),
    });
    await launch.process.execute({
      argv: [recipient.executable, "build"],
      cwd: packageDirectory,
      environment: launch.environment,
      timeoutMs: 2000,
    });
    if (prepared === undefined) throw Error("Confinement preparation did not run");
    expect(prepared.boundRoot).toBe(packageDirectory);
    expect(prepared.extraBoundRoots).toContain(checkout);
    expect(prepared.readRoots).toContain(checkout);
  } finally {
    spy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
