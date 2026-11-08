import { Schema } from "effect";
import { AgentRun, ContentIngestedPayload } from "@octant/contracts";
import {
  BrowserSessionGranted,
  BrowserSessionRevoked,
} from "@octant/contracts/browser-session-grants";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openReadOnlySqlite } from "../apps/server/src/persistence/sqlitePort";
import {
  cleanupPackagedProcess,
  runBoundedCommand,
  sanitizedPackagedEnvironment,
  spawnPackagedApplication,
  stagePackagedAppBundle,
  waitForProcessCleanup,
} from "./packaged-smoke-process";
import {
  CHILD_FIXTURE_MODEL,
  CHILD_FIXTURE_PARENT_TASK,
  startOwnedChildProvider,
} from "./packaged-browser-child-provider";
import { createOwnedChildProject } from "./packaged-browser-child-setup";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const Snapshot = Schema.Struct({
  pid: Schema.Number,
  windowId: Schema.Number,
  texts: Schema.Array(Schema.Struct({ text: Schema.String })),
});
const decodeSnapshot = Schema.decodeUnknownSync(Snapshot);
const hasText = (s: typeof Snapshot.Type, text: string) =>
  s.texts.some((row) => row.text.toLowerCase().includes(text.toLowerCase()));
const JournalRow = Schema.Struct({ event_name: Schema.String, payload_json: Schema.String });
const RequestedRun = Schema.Struct({ run: AgentRun });

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  if (address === null || typeof address === "string") throw Error("No owned app port.");
  return address.port;
}

async function exited(child: ChildProcess, bound: number) {
  const deadline = Date.now() + bound;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline)
    await pause(50);
  return child.exitCode !== null || child.signalCode !== null;
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw Error("Use isolated hosted Apple Silicon macOS.");
  const native = process.env.OCTANT_QA_NATIVE_CONTROLLER;
  if (native === undefined) throw Error("Supply the built owned native controller.");
  const artifacts = resolve(
    process.env.OCTANT_QA_OUTPUT ?? "/tmp/octant-packaged-browser-child-native",
  );
  const root = await mkdtemp(join(tmpdir(), "octant-browser-child-native."));
  const owner = new AbortController();
  const abort = () => owner.abort();
  const deadline = setTimeout(abort, 180_000);
  process.once("SIGTERM", abort);
  process.once("SIGINT", abort);
  let app: ReturnType<typeof spawnPackagedApplication> | undefined;
  let bundle: string | undefined;
  let watchdog: ChildProcess | undefined;
  let provider: Awaited<ReturnType<typeof startOwnedChildProvider>> | undefined;
  let port: number | undefined;
  let evidence: Readonly<Record<string, unknown>> | undefined;
  let failure: { readonly error: unknown } | undefined;
  const cleanupFailures: unknown[] = [];
  const until = async (name: string, check: () => boolean | Promise<boolean>, bound = 15_000) => {
    const end = Date.now() + bound;
    do {
      owner.signal.throwIfAborted();
      if (await check()) return;
      await pause(100);
    } while (Date.now() < end);
    throw Error(`The actual packaged ${name} was not observed.`);
  };
  try {
    await mkdir(artifacts, { recursive: true });
    await mkdir(join(root, "home"));
    await mkdir(join(root, "tmp"));
    await mkdir(join(root, "work"));
    const providerInstanceId = randomUUID();
    provider = await startOwnedChildProvider({
      signal: owner.signal,
      providerInstanceId,
      lifetimeMs: 180_000,
    });
    const localProvider = provider;
    port = await freePort();
    const serverUrl = `http://127.0.0.1:${port}`;
    bundle = stagePackagedAppBundle(resolve("out/Octant.app"));
    const env = {
      ...sanitizedPackagedEnvironment(
        { HOME: join(root, "home"), TMPDIR: join(root, "tmp") },
        join(root, "data"),
      ),
      OCTANT_SERVER_PORT: String(port),
      ...(process.env.RUNNER_TRACKING_ID === undefined
        ? {}
        : { RUNNER_TRACKING_ID: process.env.RUNNER_TRACKING_ID }),
    };
    await runBoundedCommand(native, ["preflight"], process.env, 5000);
    owner.signal.throwIfAborted();
    app = spawnPackagedApplication({ executable: join(bundle, "Contents/MacOS/Octant"), env });
    const ownApp = app;
    const pid = ownApp.child.pid;
    if (pid === undefined) throw Error("The packaged app has no owned PID.");
    watchdog = spawn(
      process.execPath,
      [
        "-e",
        String.raw`
const owner=Number(process.env.OCTANT_SMOKE_OWNER_PID), group=Number(process.env.OCTANT_SMOKE_APP_PID);
if(!Number.isSafeInteger(owner)||owner<2||!Number.isSafeInteger(group)||group<2)process.exit(1);
const until=Date.now()+210000;
const alive=pid=>{try{process.kill(pid,0);return true}catch(error){return error?.code!=="ESRCH"}};
const signal=s=>{try{process.kill(-group,s)}catch{}};
const timer=setInterval(()=>{if(alive(owner)&&alive(group)&&alive(-group)&&Date.now()<until)return;clearInterval(timer);if(!alive(-group))process.exit(0);signal("SIGTERM");setTimeout(()=>{signal("SIGKILL");process.exit(0)},1000)},100);
`,
      ],
      {
        detached: true,
        env: {
          ...env,
          OCTANT_SMOKE_OWNER_PID: String(process.pid),
          OCTANT_SMOKE_APP_PID: String(pid),
        },
        stdio: "ignore",
      },
    );
    let sequence = 0;
    const act = async (mode: string, target: string, value?: string) => {
      owner.signal.throwIfAborted();
      if (ownApp.child.exitCode !== null || ownApp.child.signalCode !== null)
        throw Error("The owned app exited.");
      const capture = join(artifacts, `${++sequence}-${mode}.png`);
      const child = spawn(
        native,
        [mode, String(pid), capture, target, ...(value === undefined ? [] : [value])],
        {
          env: process.env,
          signal: owner.signal,
          timeout: 8000,
          killSignal: "SIGKILL",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "",
        error = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-131072);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        error = (error + chunk.toString()).slice(-1500);
      });
      child.on("error", () => {
        error = "The owned native command was cancelled or could not start.";
      });
      const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
      owner.signal.throwIfAborted();
      if (code !== 0) {
        await writeFile(join(artifacts, "native-command-failure.txt"), error);
        throw Error(`The owned native ${mode} refused.`);
      }
      const snapshot = decodeSnapshot(JSON.parse(output));
      if (snapshot.pid !== pid) throw Error("The native observation belongs to another PID.");
      await writeFile(capture.replace(/\.png$/, ".json"), output);
      return snapshot;
    };
    const observe = async (name: string, check: (snapshot: typeof Snapshot.Type) => boolean) =>
      until(name, async () => check(await act("observe", name)));
    const journal = (event: string): ReadonlyArray<unknown> => {
      const database = openReadOnlySqlite(join(root, "data", "octant.sqlite3"));
      try {
        return database
          .all(
            "SELECT event_name, payload_json FROM event_journal WHERE event_name IN ('agent.run-requested@1', 'browser.session-granted@1', 'browser.session-revoked@1', 'thread.external-content-ingested@1') ORDER BY global_sequence",
          )
          .map((row) => Schema.decodeUnknownSync(JournalRow)(row))
          .filter((row) => row.event_name === event)
          .map((row) => JSON.parse(row.payload_json));
      } finally {
        database.close();
      }
    };
    await observe("welcome", (s) => hasText(s, "Welcome to Octant"));
    await act("click", "Skip setup");
    await observe("setup-skipped", (s) => !hasText(s, "Welcome to Octant") && s.texts.length > 0);
    await until(
      "host readiness",
      async () =>
        (
          await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(500) }).catch(
            () => undefined,
          )
        )?.ok === true,
    );
    let secret: string | undefined;
    await until("private bridge projection", async () => {
      const value = await readFile(join(root, "data", "octant-bridge-secret"), "utf8").catch(
        () => "",
      );
      if (!/^[A-Za-z0-9_-]{43}$/.test(value.trim())) return false;
      secret = value.trim();
      return true;
    });
    if (secret === undefined) throw Error("No owned bridge projection.");
    const setup = await createOwnedChildProject({
      serverUrl,
      desktopBridgeSecret: secret,
      folder: join(root, "work"),
      providerUrl: localProvider.baseUrl,
      providerInstanceId,
    });
    secret = undefined;
    if (localProvider.evidence().probes !== 1)
      throw Error("The real provider driver did not verify its tool capability.");
    await act("click", "Work");
    await observe("owned Project", (s) => hasText(s, "Owned Browser fixture"));
    await act("click", "Owned Browser fixture");
    await observe("owned parent", (s) => hasText(s, CHILD_FIXTURE_PARENT_TASK));
    await act("click", CHILD_FIXTURE_PARENT_TASK);
    await observe("parent composer", (s) => hasText(s, "Reply"));
    await act("fill", "Reply", CHILD_FIXTURE_PARENT_TASK);
    await act("enter", CHILD_FIXTURE_PARENT_TASK);
    await until(
      "managed child waiting without permission",
      () => localProvider.evidence().childTurns === 2 && localProvider.evidence().held,
      25_000,
    );
    if (
      !localProvider
        .evidence()
        .childObservations[0]?.includes("browser-session-permission-required")
    )
      throw Error("The real child did not refuse Browser access without a grant.");
    const requested = journal("agent.run-requested@1")
      .map((value) => Schema.decodeUnknownSync(RequestedRun)(value).run)
      .find((run) => String(run.parentThreadId) === setup.threadId);
    if (
      requested === undefined ||
      requested.executionKind !== "octant-managed" ||
      requested.authority.network !== false ||
      String(requested.routingReceipt?.selectedProviderInstanceId) !== providerInstanceId ||
      requested.routingReceipt?.selectedModelId !== CHILD_FIXTURE_MODEL
    )
      throw Error("The actual dispatcher did not bind the requested Work child and local model.");
    await act("settings", "Settings");
    await observe("Settings search", (s) => hasText(s, "Search settings"));
    await act("fill", "Search settings", "Browser session permissions");
    await act("enter", "Browser session permissions");
    await observe("Browser permission controls", (s) => hasText(s, "New session permission"));
    await act("click", "New session permission");
    await observe("session review", (s) => hasText(s, "Choose a caller"));
    await act("click", "Choose a caller");
    await act("choose-native-menu-item", "Owned Browser child", "Child · Owned Browser child");
    await act("click", "Choose a profile");
    await act("choose-native-menu-item", "Personal", "Personal");
    await act("fill", "https://example.com", localProvider.origin);
    await act("click", "Review permission");
    await observe(
      "exact reviewed grant",
      (s) => hasText(s, "Grant session permission") && hasText(s, localProvider.origin),
    );
    if (!localProvider.evidence().held || localProvider.evidence().childTurns !== 2)
      throw Error("Review unexpectedly resumed the child.");
    await act("click", "Grant session permission");
    let granted: typeof BrowserSessionGranted.Type | undefined;
    await until("native grant journal", () => {
      granted = journal("browser.session-granted@1")
        .map((value) => Schema.decodeUnknownSync(BrowserSessionGranted)(value))
        .at(-1);
      return granted !== undefined;
    });
    if (
      granted === undefined ||
      granted.windowId === undefined ||
      String(granted.windowId) === setup.setupWindowId ||
      granted.grant.target.grantee.kind !== "child" ||
      String(granted.grant.target.grantee.runId) !== String(requested.id) ||
      String(granted.grant.target.authority.projectId) !== setup.projectId ||
      granted.grant.profile.kind !== "personal" ||
      granted.grant.origins.length !== 1 ||
      granted.grant.origins[0] !== localProvider.origin ||
      !localProvider.evidence().held
    )
      throw Error("The grant was not journaled for the exact child by the actual native window.");
    localProvider.advance("after-grant");
    await until(
      "explicit child Browser retry",
      () => localProvider.evidence().childTurns === 3 && localProvider.evidence().held,
      25_000,
    );
    if (!localProvider.evidence().childObservations[1]?.includes("Example Domain"))
      throw Error("The actual native Browser did not return the approved public fixture.");
    const taint = journal("thread.external-content-ingested@1")
      .map((value) => Schema.decodeUnknownSync(ContentIngestedPayload)(value))
      .find((value) => String(value.threadId) === String(requested.id));
    if (taint === undefined)
      throw Error("The real child Browser observation was not persisted as outside content.");
    await observe("grant revoke control", (s) => hasText(s, "Revoke"));
    await act("click", "Revoke");
    const grantId = String(granted.grant.grantId);
    await until("native revocation journal", () =>
      journal("browser.session-revoked@1")
        .map((value) => Schema.decodeUnknownSync(BrowserSessionRevoked)(value))
        .some((value) => String(value.grant.grantId) === grantId),
    );
    localProvider.advance("after-revoke");
    await until("revoked child refusal", () => localProvider.evidence().childTurns === 4, 15_000);
    if (
      !localProvider
        .evidence()
        .childObservations[2]?.includes("browser-session-permission-required")
    )
      throw Error("The real child reopened Browser authority after revocation.");
    evidence = {
      source: "c0af367e35911cca367bec197bdc771a94fa1a03",
      stage: "normal-packaged-managed-child",
      result: "passed",
      processId: pid,
      projectId: setup.projectId,
      parentThreadId: setup.threadId,
      childRunId: requested.id,
      actualNativeGrantWindowId: granted.windowId,
      setupAuthorityRevoked: true,
      fixtureProjectSetup: "authenticated API, not folder-picker acceptance",
      realManagedDispatcher: true,
      normalSettingsReviewGrantRevoke: true,
      explicitRetry: true,
      childOutsideContentJournaled: true,
      providerRequests: localProvider.evidence().requests,
      personalCredentials: false,
      signedInPackagedAcceptance: "not-run; public trusted HTTPS and an empty Personal profile",
      remainingAcceptance:
        "signed-in packaged account, paired controls, expiry/model/authority/restart/cancel scenarios",
    };
  } catch (error) {
    failure = { error };
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGTERM", abort);
    process.removeListener("SIGINT", abort);
    try {
      await provider?.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (app !== undefined && app.child.pid !== undefined && bundle !== undefined) {
      const ownApp = app,
        ownPid = app.child.pid,
        ownBundle = bundle,
        ownPort = port;
      try {
        await cleanupPackagedProcess({
          child: {
            pid: ownPid,
            get exitCode() {
              return ownApp.child.exitCode;
            },
            get signalCode() {
              return ownApp.child.signalCode;
            },
          },
          requestQuit: () =>
            runBoundedCommand(
              "/usr/bin/osascript",
              [
                "-e",
                `tell application "${ownBundle.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" to quit`,
              ],
              process.env,
              3000,
            ).then(() => undefined),
          waitForExit: (_child, timeout) => exited(ownApp.child, timeout),
          signalGroup: (group, signal) => {
            if (group !== ownPid) throw Error("Unowned process group.");
            try {
              process.kill(-group, signal);
            } catch (error) {
              if (
                !(
                  typeof error === "object" &&
                  error !== null &&
                  "code" in error &&
                  error.code === "ESRCH"
                )
              )
                throw error;
            }
          },
          waitForServerCleanup: () =>
            waitForProcessCleanup(
              async () => {
                if (
                  ownPort !== undefined &&
                  (await fetch(`http://127.0.0.1:${ownPort}/health`, {
                    signal: AbortSignal.timeout(300),
                  }).catch(() => undefined)) !== undefined
                )
                  throw Error("The owned app listener remains available.");
              },
              { timeoutMs: 3000 },
            ),
          assertNoProcesses: async () => {
            const rows = execFileSync("/bin/ps", ["-axo", "pid=,pgid="], {
              encoding: "utf8",
              timeout: 3000,
            });
            if (rows.split("\n").some((row) => Number(row.trim().split(/\s+/)[1]) === ownPid))
              throw Error("An owned native process remains.");
            if (watchdog !== undefined && !(await exited(watchdog, 2000)))
              throw Error("The finite watchdog did not exit.");
          },
          gracefulTimeoutMs: 3000,
          forceTimeoutMs: 2000,
        });
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (bundle?.startsWith(join(tmpdir(), "octant-packaged-app.")))
      try {
        await rm(dirname(bundle), { recursive: true, force: true });
      } catch (error) {
        cleanupFailures.push(error);
      }
  }
  if (failure !== undefined || cleanupFailures.length > 0)
    throw new AggregateError(
      [...(failure === undefined ? [] : [failure.error]), ...cleanupFailures],
      failure?.error instanceof Error
        ? failure.error.message
        : "Owned packaged child verification or cleanup failed.",
    );
  owner.signal.throwIfAborted();
  if (evidence === undefined)
    throw Error("Normal packaged managed-child acceptance is incomplete.");
  await writeFile(
    join(artifacts, "packaged-child-evidence.json"),
    JSON.stringify({ ...evidence, cleanup: "verified" }, null, 2),
  );
  console.log(
    "Normal packaged managed-child dispatcher, Settings grant/retry/revoke and taint checks passed.",
  );
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : "The owned packaged child check failed.");
  process.exitCode = 1;
});
