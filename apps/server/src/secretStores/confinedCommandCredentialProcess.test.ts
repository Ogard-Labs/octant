import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import type { RepositoryTestProcessResult } from "../code/repositoryTestRunner";
import { decodeCommandCredentialBinding } from "@octant/contracts/command-credentials";
import { onePasswordCommandCredentials } from "@octant/host-runtime";
import { pinCommandExecutable } from "./commandCredentialExecution";
import { confinedCommandCredentialProcess } from "./confinedCommandCredentialProcess";
import { startEgressHarness, threadRule } from "../harness/nativeHarnessEgressProxy.test-support";
import { proxiedLaunchEnvironment } from "../process/proxiedNetworkEgress";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw Error("Fixture listener unavailable");
  return address.port;
}
async function close(server: Server) {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("confined named credential process", () => {
  it.skipIf(process.platform !== "darwin")(
    "keeps a synthetic authentication parent outside while its actual Node recipient obeys file and proxy confinement",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-confined-credential-")));
      const project = join(root, "project"),
        work = join(root, "work"),
        account = join(root, "account");
      for (const directory of [project, work, account]) mkdirSync(directory);
      let directRequests = 0;
      const destination = createServer((_request, response) => {
        directRequests++;
        response.end("direct");
      });
      const upstream = createServer((_request, response) => response.end("proxy-accepted"));
      let harness: Awaited<ReturnType<typeof startEgressHarness>> | undefined;
      const abort = new AbortController();
      let running: Promise<RepositoryTestProcessResult> | undefined;
      try {
        const directPort = await listen(destination),
          upstreamPort = await listen(upstream);
        harness = await startEgressHarness({
          rules: [threadRule("allowed.example.test", 80)],
          routes: new Map([["93.184.216.10", upstreamPort]]),
        });
        const endpoint = harness.proxy.endpoint;
        if (endpoint.kind !== "loopback") throw Error("Fixture proxy unavailable");
        const proxyUrl = proxiedLaunchEnvironment(endpoint, harness.proxy.token).HTTP_PROXY;
        if (proxyUrl === undefined) throw Error("Fixture proxy environment unavailable");
        const cli = join(account, "fixture-op"),
          authFile = `${cli}.account`,
          script = join(project, "recipient.cjs");
        writeFileSync(authFile, "synthetic-auth-parent-only");
        writeFileSync(
          cli,
          '#!/bin/sh\n[ -z "$HTTP_PROXY$HTTPS_PROXY$ALL_PROXY$http_proxy$https_proxy$all_proxy" ] || exit 91\n[ "$(cat "$0.account")" = synthetic-auth-parent-only ] || exit 92\nprintf %s $$ > "$0.pid"\nexport API_TOKEN=synthetic-sentinel\nshift 4\n"$@" &\nwait $!\n',
          { mode: 0o700 },
        );
        writeFileSync(
          script,
          `const fs=require("node:fs");(async()=>{
        const checks={credential:process.env.API_TOKEN==="synthetic-sentinel",proxyActivation:process.env.NODE_USE_ENV_PROXY==="1",privatePrefixAbsent:process.env.OCTANT_COMMAND_PROXY_URL===undefined};
        try{fs.readFileSync(${JSON.stringify(authFile)});checks.authReadRefused=false}catch{checks.authReadRefused=true}
        try{fs.writeFileSync(${JSON.stringify(join(root, "forbidden"))},"x");checks.outsideWriteRefused=false}catch{checks.outsideWriteRefused=true}
        fs.writeFileSync(${JSON.stringify(join(project, "allowed"))},"x");checks.projectWrite=true;
        const allowed=await fetch("http://allowed.example.test/check",{signal:AbortSignal.timeout(800)});checks.allowedProxy=await allowed.text()==="proxy-accepted";
        try{const refused=await fetch("http://denied.example.test/check",{signal:AbortSignal.timeout(800)});checks.deniedDestination=!refused.ok}catch{checks.deniedDestination=true}
        checks.directRefused=await new Promise(resolve=>{const socket=require("node:net").connect({host:"127.0.0.1",port:${directPort}});socket.once("connect",()=>{socket.destroy();resolve(false)});socket.once("error",error=>resolve(["EPERM","EACCES"].includes(error.code)));socket.setTimeout(800,()=>{socket.destroy();resolve(false)})});
        process.stdout.write(JSON.stringify(checks));
      })().catch(()=>process.exitCode=95);`,
        );
        const op = await pinCommandExecutable(cli),
          recipient = await pinCommandExecutable(process.execPath);
        if (op === undefined || recipient === undefined)
          throw Error("Fixture executable unavailable");
        const binding = decodeCommandCredentialBinding({
          kind: "command-credential-binding",
          bindingId: randomUUID(),
          revision: 1,
          credentialExecutable: op.executable,
          credentialExecutableDigest: op.digest,
          credentialVersion: "2.33.0",
          executableDigest: recipient.digest,
          definition: {
            label: "Synthetic confined recipient",
            projectId: randomUUID(),
            executable: recipient.executable,
            args: [script],
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
            timeoutMs: 4000,
          },
        });
        const launch = confinedCommandCredentialProcess({
          binding,
          recipientIdentity: recipient.identity,
          checkoutRoot: project,
          networkEgress: { kind: "proxied", endpoint },
          proxyUrl,
          temporaryDirectory: work,
          receiptDirectory: join(root, "receipts"),
        });
        const result = await launch.process.execute({
          argv: [recipient.executable, script],
          cwd: project,
          environment: {
            ...onePasswordCommandCredentials(binding.definition).environment,
            ...launch.environment,
          },
          isolatedRoots: [account],
          timeoutMs: 4000,
        });
        expect(result).toMatchObject({ termination: "exited", exitCode: 0 });
        expect(JSON.parse(Buffer.from(result.stdout).toString("utf8"))).toEqual({
          credential: true,
          proxyActivation: true,
          privatePrefixAbsent: true,
          authReadRefused: true,
          outsideWriteRefused: true,
          projectWrite: true,
          allowedProxy: true,
          deniedDestination: true,
          directRefused: true,
        });
        expect((await harness.proxy.close()).status).toBe("summarized");
        const entries = harness.records.summaries.flatMap((summary) => summary.entries);
        expect(entries).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ host: "allowed.example.test", decision: "allowed" }),
            expect.objectContaining({
              host: "denied.example.test",
              decision: "refused",
              reason: "no-rule",
            }),
          ]),
        );
        expect(directRequests).toBe(0);
        const ready = join(project, "recipient.ready");
        writeFileSync(
          script,
          `require("node:fs").writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`,
        );
        running = launch.process.execute(
          {
            argv: [recipient.executable, script],
            cwd: project,
            environment: {
              ...onePasswordCommandCredentials(binding.definition).environment,
              ...launch.environment,
            },
            isolatedRoots: [account],
            timeoutMs: 4000,
          },
          abort.signal,
        );
        const deadline = Date.now() + 1500;
        while (!existsSync(ready) && Date.now() < deadline) await delay(10);
        expect(existsSync(ready)).toBe(true);
        const parentPid = Number(readFileSync(`${cli}.pid`, "utf8")),
          recipientPid = Number(readFileSync(ready, "utf8"));
        for (const pid of [parentPid, recipientPid])
          expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
        abort.abort();
        expect(await running).toMatchObject({ termination: "cancelled" });
        await vi.waitFor(
          () => {
            for (const pid of [parentPid, recipientPid]) {
              let present = true;
              try {
                process.kill(pid, 0);
              } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "ESRCH")
                  present = false;
                else throw error;
              }
              expect(present).toBe(false);
            }
          },
          { timeout: 1000 },
        );
      } finally {
        abort.abort();
        await running?.catch(() => undefined);
        await harness?.proxy.close();
        await close(upstream);
        await close(destination);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});
