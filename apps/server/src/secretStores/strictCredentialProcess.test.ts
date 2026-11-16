import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { decodeCommandCredentialBinding } from "@octant/contracts/command-credentials";
import { decodeSandboxPolicySelection } from "@octant/contracts/sandbox-policy";
import { onePasswordCommandCredentials } from "@octant/host-runtime";
import { configureSandboxRestrictionsAuthority } from "../process/sandboxRuntimePolicy";
import {
  startEgressHarness,
  closeEgressHarnesses,
} from "../harness/nativeHarnessEgressProxy.test-support";
import { proxiedLaunchEnvironment } from "../process/proxiedNetworkEgress";
import { confinedCommandCredentialProcess } from "./confinedCommandCredentialProcess";
import { pinCommandExecutable } from "./commandCredentialExecution";

it.skipIf(process.platform !== "linux" || !existsSync("/usr/bin/bwrap"))(
  "keeps a fixed credential recipient inside its selected native boundary while its authentication parent stays outside",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-strict-credential-")));
    const project = join(root, "project"),
      account = join(root, "account"),
      work = join(root, "work"),
      authority = join(root, "authority");
    for (const directory of [project, account, work, authority])
      mkdirSync(directory, { mode: 0o700 });
    const server = createServer((socket) => socket.destroy());
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("Missing endpoint");
      const recipientPath = join(project, "recipient");
      execFileSync("cc", [
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        fileURLToPath(new URL("./fixtures/credentialRecipient.c", import.meta.url)),
        "-o",
        recipientPath,
      ]);
      const cli = join(account, "op"),
        auth = join(account, "authentication");
      writeFileSync(auth, "synthetic-authentication-parent");
      writeFileSync(
        cli,
        `#!/bin/sh\n[ -z "$HTTP_PROXY$HTTPS_PROXY$ALL_PROXY" ] || exit 91\n[ "$(cat '${auth}')" = synthetic-authentication-parent ] || exit 92\nexport API_TOKEN=synthetic-recipient-only\nshift 4\nexec "$@"\n`,
        { mode: 0o700 },
      );
      const op = await pinCommandExecutable(cli),
        recipient = await pinCommandExecutable(recipientPath);
      if (op === undefined || recipient === undefined) throw new Error("Missing pinned executable");
      const projectId = randomUUID();
      const selection = decodeSandboxPolicySelection({
        policy: {
          schemaVersion: 1,
          revision: 1,
          filesystem: { readOnlyRoots: [], readWriteRoots: [], protectedPaths: [] },
          network: "deny",
          hostServices: "blocked",
          credentials: "existing-policy",
        },
        context: {
          root: project,
          hostId: "host",
          projectId,
          checkoutId: "checkout",
          sessionId: "credential-process",
          provider: "codex",
        },
      });
      configureSandboxRestrictionsAuthority({
        active: () => selection,
        validateSelection: (value) => value === selection,
        beginTurn: () => ({ status: "refused", message: "unused" }),
        storageDirectory: () => authority,
        deny: () => undefined,
        registerCleanup: () => () => undefined,
      });
      const binding = decodeCommandCredentialBinding({
        kind: "command-credential-binding",
        bindingId: randomUUID(),
        revision: 1,
        credentialExecutable: op.executable,
        credentialExecutableDigest: op.digest,
        credentialVersion: "2.33.0",
        executableDigest: recipient.digest,
        definition: {
          label: "Synthetic recipient",
          projectId,
          executable: recipient.executable,
          args: [auth, join(root, "forbidden"), join(project, "allowed"), String(address.port)],
          directory: "",
          accountId: "a".repeat(26),
          timeoutMs: 4000,
          environment: [
            {
              name: "API_TOKEN",
              vaultId: "v".repeat(26),
              itemId: "i".repeat(26),
              fieldId: "credential",
            },
          ],
        },
      });
      const harness = await startEgressHarness({
        endpoint: { kind: "unix-socket", parentDirectory: authority },
      });
      const proxyUrl = proxiedLaunchEnvironment(
        harness.proxy.endpoint,
        harness.proxy.token,
      ).HTTP_PROXY;
      if (proxyUrl === undefined) throw new Error("Missing scoped proxy");
      const launch = confinedCommandCredentialProcess({
        binding,
        recipientIdentity: recipient.identity,
        checkoutRoot: project,
        networkEgress: { kind: "proxied", endpoint: harness.proxy.endpoint },
        proxyUrl,
        temporaryDirectory: work,
        receiptDirectory: join(root, "receipts"),
        sandboxPolicy: selection,
      });
      const result = await launch.process.execute({
        argv: [recipient.executable, ...binding.definition.args],
        cwd: project,
        environment: {
          ...onePasswordCommandCredentials(binding.definition).environment,
          ...launch.environment,
        },
        isolatedRoots: [account],
        timeoutMs: 4000,
      });
      expect(result).toMatchObject({ termination: "exited", exitCode: 0 });
      expect(JSON.parse(Buffer.from(result.stdout).toString())).toEqual({
        credential: true,
        accountDenied: true,
        outsideDenied: true,
        projectWrite: true,
        directDenied: true,
      });
      expect(readFileSync(join(project, "allowed"), "utf8")).toBe("allowed");
      expect(existsSync(join(root, "forbidden"))).toBe(false);
    } finally {
      configureSandboxRestrictionsAuthority(undefined);
      await closeEgressHarnesses();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  },
);
