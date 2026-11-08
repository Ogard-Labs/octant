import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import {
  ownNightlyWindowLeases,
  type NativeWindowBroker,
} from "../../apps/desktop/src/nightlyBrowserLease";
import {
  desktopPeerPreflight,
  ownDesktopPeerStatus,
  type NativeDesktopPeerStatus,
} from "../../apps/desktop/src/desktopPeerStatus";
import {
  desktopWindowProtocol,
  registerNightlyWindow,
  type NativeDesktopWindows,
} from "../../apps/desktop/src/desktopPeerWindows";

type Native = NativeDesktopPeerStatus &
  NativeDesktopWindows & {
    readonly bindEndpoint: (profile: string, version: string) => boolean;
  };
const [binding, scope, mode] = process.argv.slice(2);
const launcher = process.env.OCTANT_WINDOWS_PEER_QA_LAUNCHER;
const copy = process.env.OCTANT_WINDOWS_PEER_QA_COPY_BINDING;
const appcontainer = process.env.OCTANT_WINDOWS_PEER_QA_APPCONTAINER;
if (process.platform !== "win32" || !binding || !scope || !mode)
  throw Error("Supply owned native peer artifacts.");
function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
function nativeContract(value: unknown): value is Native {
  return (
    record(value) &&
    desktopWindowProtocol(value) !== undefined &&
    ["start", "status", "close", "bindEndpoint"].every((name) => typeof value[name] === "function")
  );
}
function load(path: string): Native {
  const value: unknown = createRequire(import.meta.url)(path);
  if (!nativeContract(value)) throw Error("Native peer public contract unavailable.");
  return value;
}

function kind(value: unknown, expected: string): boolean {
  return record(value) && value.kind === expected;
}
function check(value: boolean, message: string) {
  if (!value) throw Error(`Owned peer proof failed: ${message}`);
}
const native = load(binding);
const version = mode === "server-new" ? "1.2.4" : "1.2.3";
const lateWindow = "55555555-5555-4555-8555-555555555555";
if (mode === "refused") {
  check(
    native.bindEndpoint(scope, version) === false,
    "a restricting-SID or low-integrity process cannot bind the native peer",
  );
  check(
    kind(await native.status(), "refused"),
    "a refused principal receives no native peer authority",
  );
  console.log(JSON.stringify({ nativePrincipalRefused: true }));
} else {
  check(native.bindEndpoint(scope, version), "the real unconfined owner binds its native scope");
  const lines = createInterface({ input: process.stdin });
  let cancel = () => lines.close();
  const lifetime = setTimeout(() => {
    process.exitCode = 2;
    cancel();
  }, 25_000);
  const stop = new Promise<void>((resolve) => {
    lines.once("close", resolve);
    process.once("SIGTERM", () => {
      cancel();
      resolve();
    });
    process.once("SIGINT", () => {
      cancel();
      resolve();
    });
  });
  if (mode.startsWith("server")) {
    const status = ownDesktopPeerStatus(native);
    let holdExits = false;
    const heldExits: unknown[] = [];
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let forward: ((event: unknown) => void) | undefined;
    const broker: NativeWindowBroker = {
      listenWindows: (callback) => {
        forward = callback;
        return native.listenWindows((event) => {
          if (record(event) && event.kind === "peer-exited") {
            console.log(JSON.stringify({ peerExited: event.peer }));
            if (holdExits) {
              heldExits.push(event);
              return;
            }
          } else if (record(event) && record(event.request)) {
            console.log(JSON.stringify({ request: event.request }));
            if (
              event.request.windowId === lateWindow &&
              typeof event.request.requestId === "number"
            ) {
              const requestId = event.request.requestId;
              // Controlled late native reply exercises the real operation bound,
              // not a production delay or a new native test entry point.
              const timer = setTimeout(() => {
                timers.delete(timer);
                const accepted = native.replyWindow(requestId, {
                  kind: "refused",
                  reason: "unavailable",
                });
                console.log(JSON.stringify({ lateReplyAccepted: accepted }));
              }, 2700);
              timers.add(timer);
              return;
            }
          }
          callback(event);
        });
      },
      replyWindow: native.replyWindow,
      stopWindows: native.stopWindows,
    };
    const leases = ownNightlyWindowLeases({
      native: broker,
      host: () => ({
        origin: "http://127.0.0.1:13773",
        instanceId: "11111111-1111-4111-8111-111111111111",
        desktopBridgeSecret: "fixture-only",
      }),
      // This is native transport + production lease integration, not an HTTP
      // host proof. The real packaged pair exercises the actual server route.
      fetch: async (_input, init) => {
        const body: unknown = JSON.parse(String(init?.body));
        if (!record(body) || !record(body.source)) throw Error("Invalid fixture lease body.");
        return init?.method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json(
              { generation: body.source.generation, leaseMs: 15_000, hostFeatures: [] },
              { status: init?.method === "POST" ? 201 : 200 },
            );
      },
      closeOwnerContexts: async () => {},
    });
    lines.on("line", (line) => {
      if (line === "hold-exits") holdExits = true;
      else if (line === "release-exits") {
        holdExits = false;
        for (const event of heldExits.splice(0)) forward?.(event);
      } else if (line === "close") lines.close();
      console.log(JSON.stringify({ command: line }));
    });
    try {
      check(
        (await status.ready).kind === "started" && kind(await leases.ready, "started"),
        "native status and window listeners start",
      );
      console.log(JSON.stringify({ serverReady: true }));
      await stop;
    } finally {
      for (const timer of timers) clearTimeout(timer);
      check((await leases.close()).kind === "closed", "production lease cleanup confirms closure");
      check((await status.close()).kind === "closed", "native status cleanup joins its workers");
      clearTimeout(lifetime);
      lines.close();
    }
  } else if (mode === "client-exit") {
    try {
      const registered = await registerNightlyWindow(
        native,
        "22222222-2222-4222-8222-222222222222",
        1,
      );
      check(registered.kind === "registered", "a separate real process registers a native lease");
      console.log(JSON.stringify({ clientReady: true }));
      await stop;
      // Deliberately let environment/process teardown, not an explicit close,
      // retire this live connection and its held process incarnation.
    } finally {
      clearTimeout(lifetime);
      lines.close();
    }
  } else if (mode === "controller") {
    if (!launcher || !copy || !appcontainer)
      throw Error("Supply the owned launcher, AppContainer probe and copied public binding.");
    const children: {
      readonly child: ChildProcessWithoutNullStreams;
      readonly exit: Promise<number | null>;
      readonly records: Readonly<Record<string, unknown>>[];
    }[] = [];
    const checks: string[] = [];
    let stdinFault = false;
    cancel = () => {
      lines.close();
      for (const { child } of children) {
        child.stdin.end();
        if (child.exitCode === null && child.signalCode === null) child.kill();
      }
    };
    const entry = fileURLToPath(import.meta.url);
    function start(command: string, args: ReadonlyArray<string>) {
      const child = spawn(command, [...args], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const records: Readonly<Record<string, unknown>>[] = [];
      const output = createInterface({ input: child.stdout });
      output.on("line", (line) => {
        if (line.length > 8192 || records.length >= 128) return;
        try {
          const value: unknown = JSON.parse(line);
          if (record(value)) records.push(value);
        } catch {
          /* non-receipt runtime output grants nothing */
        }
      });
      let errorTail = "";
      child.stderr.on("data", (bytes: Buffer) => {
        errorTail = (errorTail + bytes.toString("utf8")).slice(-4096);
      });
      child.stderr.on("end", () => {
        const failure = errorTail.match(
          /(?:error: |Error: )(Owned peer proof failed: [A-Za-z0-9 /'-]{1,200})/,
        );
        if (failure) records.push({ fixtureFailure: failure[1] });
      });
      child.stdin.on("error", (error: unknown) => {
        if (!record(error) || error.code !== "EPIPE") stdinFault = true;
      });
      const exit = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      void exit.catch(() => undefined);
      const value = { child, exit, records };
      children.push(value);
      return value;
    }
    async function until(predicate: () => boolean, message: string) {
      const deadline = performance.now() + 5000;
      while (!predicate() && performance.now() < deadline)
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      if (!predicate())
        for (const child of children)
          for (const receipt of child.records)
            if (receipt.fixtureFailure) console.log(JSON.stringify(receipt));
      check(predicate(), message);
    }
    async function command(child: ReturnType<typeof start>, text: string) {
      child.child.stdin.write(`${text}\n`);
      await until(
        () => child.records.some((value) => value.command === text),
        `server observes ${text}`,
      );
    }
    const handle = "33333333-3333-4333-8333-333333333333";
    const replacementHandle = "44444444-4444-4444-8444-444444444444";
    let replacement: Native | undefined;
    try {
      const facts = start(launcher, ["--facts"]);
      facts.child.stdin.end();
      check(
        (await facts.exit) === 0 &&
          facts.records.some(
            (value) =>
              value.currentTokenRestrictingSidList === false &&
              value.currentTokenAppContainer === false &&
              typeof value.currentIntegrityRid === "number" &&
              value.currentIntegrityRid >= 8192,
          ),
        "the actual positive fixture has no restricting SID list or AppContainer and retains medium-or-higher integrity",
      );
      for (const receipt of facts.records) console.log(JSON.stringify(receipt));
      const server = start(process.execPath, [entry, binding, scope, "server"]);
      await until(
        () => server.records.some((value) => value.serverReady === true),
        "the actual native server is ready",
      );
      check(
        (await desktopPeerPreflight(native)).kind === "ready",
        "mutual kernel status authentication succeeds",
      );
      const first = await registerNightlyWindow(native, handle, 1);
      check(
        first.kind === "registered",
        "actual native registration returns a valid production bootstrap",
      );
      checks.push("mutual kernel status and production window registration");
      await command(server, "hold-exits");
      const firstRequest = server.records.find(
        (value) => record(value.request) && value.request.operation === "register",
      );
      if (!firstRequest || !record(firstRequest.request))
        throw Error("First native request unavailable.");
      const firstPeer = firstRequest.request.peer;
      check(
        kind(await native.close(), "closed"),
        "the old connection closes while its EOF delivery is held",
      );
      await until(
        () => server.records.some((value) => value.peerExited === firstPeer),
        "native EOF names the exact old connection",
      );
      replacement = load(copy);
      check(
        replacement.bindEndpoint(scope, version),
        "an independently loaded binding uses the same actual process principal",
      );
      const second = await registerNightlyWindow(replacement, replacementHandle, 2);
      check(
        second.kind === "registered",
        "a same-process replacement registers before old EOF is consumed",
      );
      const request = server.records.find(
        (value) =>
          record(value.request) &&
          value.request.generation === 2 &&
          value.request.operation === "register",
      );
      if (!request || !record(request.request)) throw Error("Replacement request unavailable.");
      check(
        typeof request.request.peer === "string" &&
          /^[0-9a-f]{64}$/.test(request.request.peer) &&
          request.request.peer !== firstPeer,
        "same PID/birth connections have distinct kernel-bound native lease incarnations",
      );
      await command(server, "release-exits");
      check(
        kind(await replacement.renewWindow(replacementHandle, 2), "renewed"),
        "old queued EOF cannot revoke the replacement production lease",
      );
      checks.push(
        "same-process reconnect survives delayed old EOF with production lease enforcement",
      );
      const began = performance.now();
      const late = await replacement.openWindow(lateWindow, 3);
      check(
        record(late) &&
          late.kind === "refused" &&
          late.reason === "deadline-exceeded" &&
          performance.now() - began < 3500,
        "a withheld native response refuses within the actual operation bound",
      );
      await until(
        () => server.records.some((value) => value.lateReplyAccepted === false),
        "an answer after native expiry cannot settle the old request",
      );
      check(
        server.records.some(
          (value) =>
            record(value.request) &&
            value.request.windowId === lateWindow &&
            value.request.generation === 3,
        ),
        "the actual native server observed the exact request before its deadline expired",
      );
      check(
        kind(await replacement.renewWindow(replacementHandle, 2), "renewed"),
        "a late answer neither settles a following renewal nor revokes another live lease",
      );
      checks.push(
        "actual withheld-response deadline and late-answer correlation preserve other windows",
      );
      const client = start(process.execPath, [entry, binding, scope, "client-exit"]);
      await until(
        () => client.records.some((value) => value.clientReady === true),
        "a separate process is registered",
      );
      const processRequest = server.records.find(
        (value) =>
          record(value.request) &&
          value.request.windowId === "22222222-2222-4222-8222-222222222222",
      );
      if (!processRequest || !record(processRequest.request))
        throw Error("Process request unavailable.");
      const exitingPeer = processRequest.request.peer;
      client.child.stdin.end();
      check((await client.exit) === 0, "the exact owned peer process joins");
      await until(
        () => server.records.some((value) => value.peerExited === exitingPeer),
        "kernel process exit retires that peer's lease incarnation",
      );
      checks.push("separate process exit revokes its exact native incarnation");
      for (const boundary of ["--restricting-sid", "--low-integrity"]) {
        const denied = start(launcher, [
          boundary,
          process.execPath,
          entry,
          binding,
          scope,
          "refused",
          String(process.pid),
        ]);
        denied.child.stdin.end();
        check(
          (await denied.exit) === 0 &&
            denied.records.some((value) => value.nativePrincipalRefused === true) &&
            denied.records.some((value) => value.ownedPeerJobJoined === true),
          "an actual copied child token is refused and its entire owned job joins",
        );
        if (boundary === "--low-integrity")
          check(
            denied.records.some((value) => value.lowSubjectCannotStealParentHandles === true),
            "the actual low-integrity subject cannot obtain process duplication authority over the privileged peer",
          );
      }
      checks.push(
        "real restricting-SID and low-integrity normal API refusals without changing original tokens",
      );
      const container = start(appcontainer, [scope, String(process.pid)]);
      container.child.stdin.end();
      check(
        (await container.exit) === 0 &&
          container.records.some(
            (value) =>
              value.actualAppContainer === true &&
              value.appContainerPeerRefused === true &&
              value.appContainerCannotStealParentHandles === true,
          ) &&
          container.records.some(
            (value) =>
              value.ownedAppContainerJobJoined === true &&
              value.ownedAppContainerProfileRemoved === true &&
              value.ownedAppContainerStorageAbsent === true &&
              value.ownedAppContainerPathsAbsent === true,
          ),
        "an actual AppContainer cannot use the peer or steal its handles, and its unique profile/job/public fixture are removed",
      );
      checks.push(
        "actual AppContainer peer and parent-handle refusal with owned profile/storage/path cleanup",
      );
      check(
        kind(await replacement.revokeWindow(replacementHandle, 2), "revoked"),
        "native explicit revocation reaches the production lease owner",
      );
      check(
        kind(await replacement.close(), "closed"),
        "the replacement native client confirms closure",
      );
      await command(server, "close");
      server.child.stdin.end();
      check((await server.exit) === 0, "the actual native status/window host joins");
      check(!stdinFault, "owned child stdio reports no unexpected failure");
      console.log(
        JSON.stringify({
          nativePeerChecks: checks,
          runtime: process.versions,
          ownedPeerProcessesJoined: true,
        }),
      );
    } finally {
      for (const child of children) {
        child.child.stdin.end();
        if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill();
        await child.exit.catch(() => undefined);
      }
      await replacement?.close();
      await native.close();
      clearTimeout(lifetime);
      lines.close();
    }
  } else throw Error("Unknown owned peer scenario.");
}
