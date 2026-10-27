import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeDesktopHostTag,
  decodeDesktopLeaseId,
  decodeDesktopRecipe,
  decodeEventActor,
  decodeUtcTimestamp,
  type DesktopLeaseId,
  type DesktopRecipe,
  type ProviderExecutionPolicy,
  decodeToolActionAuthority,
} from "@octant/contracts";
import {
  decodeComputerControlCommand,
  decodeComputerUseOwner,
} from "@octant/contracts/computer-use-plugin";
import type { DesktopLaunchPort, DesktopProvider } from "@octant/plugin-api/desktop-provider";
import { runDesktopProviderConformance } from "@octant/plugin-api/desktop-provider-conformance";
import { computerUseSelection } from "@octant/plugin-host/computer-use";
import { taintAppManagedToolResults } from "../providers/appManagedToolTaint";
import { createComputerUseToolService } from "./computerUseToolService";
import {
  createHostLocalDesktopProvider,
  HOST_LOCAL_DESKTOP_PROGRAMS,
} from "../plugins/hostLocalDesktop/hostLocalDesktopProvider";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { catchUpProjection } from "../persistence/projection";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { DEFAULT_BWRAP_PATH } from "../process/linuxConfinement";
import { createDesktopLeaseService, createLeasedComputerUsePort } from "./desktopLeaseService";
import { createHostLocalDesktopLaunch } from "./hostLocalDesktopLaunch";

/**
 * The host-local desktop under real Bubblewrap. The capsule negatives need
 * only `bwrap`; the desktop itself also needs the programs the driver runs
 * (`Xvfb`, `xdotool`, ImageMagick's `import`). Each group skips where its
 * binaries are absent.
 */

const hostTag = decodeDesktopHostTag("e3000000-0000-4000-8000-0000000000aa");
const recipe: DesktopRecipe = decodeDesktopRecipe({
  providerId: "host-local",
  screen: { width: 640, height: 480 },
  network: "none",
  leaseMinutes: 30,
  maximumLeaseMinutes: 240,
  idleMinutes: 15,
});
const START = Date.parse("2026-10-26T12:00:00.000Z");
/** A command addressed to an accessibility element, which this desktop has none of. */
const ELEMENT_CLICK = decodeComputerControlCommand({
  operation: "click",
  observationId: randomUUID(),
  elementIndex: 0,
});

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const canRunBwrap = process.platform === "linux" && executable(DEFAULT_BWRAP_PATH);
const canRunBash = canRunBwrap && (executable("/usr/bin/bash") || executable("/bin/bash"));
const canRunDesktop =
  canRunBwrap &&
  createHostLocalDesktopLaunch({
    directory: tmpdir(),
    hostTag,
    platform: "linux",
    provisioning: () => false,
  }).readiness(HOST_LOCAL_DESKTOP_PROGRAMS).status === "ready";

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(provisioning: (leaseId: DesktopLeaseId) => boolean = () => true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-host-desktop-")));
  directories.push(root);
  const directory = join(root, "data", "desktop-leases");
  const port = createHostLocalDesktopLaunch({
    directory,
    hostTag,
    platform: "linux",
    provisioning,
    stopTimeoutMs: 2_000,
  });
  return { root, directory, port };
}

/**
 * Runs `program` in a desktop capsule to completion and returns what it
 * printed. Each probe waits for one line on its standard input before it
 * runs, so it is still alive when the host records its namespace.
 */
async function capsuleOutput(
  port: DesktopLaunchPort,
  program: string,
  args: ReadonlyArray<string>,
  leaseId = decodeDesktopLeaseId(randomUUID()),
): Promise<string> {
  let output = "";
  const launched = await port.launch({
    leaseId,
    hostTag,
    program,
    args,
    output: (chunk) => {
      output += new TextDecoder().decode(chunk);
    },
    signal: new AbortController().signal,
  });
  if (launched.status !== "launched") throw new Error(`not launched: ${JSON.stringify(launched)}`);
  await launched.desktop.write(new TextEncoder().encode("go\n"));
  await launched.desktop.exited;
  await expect(port.stop(leaseId)).resolves.toEqual({ status: "released" });
  return output;
}

/** The PID namespace the host recorded for a desktop, without its init's identity. */
function recordedNamespace(directory: string, leaseId: DesktopLeaseId): string {
  const record = readFileSync(
    join(directory, "desktops", String(leaseId), "pid-namespace"),
    "utf8",
  );
  return /^pid:\[[0-9]+\]/.exec(record)?.[0] ?? "";
}

/** The PID namespace of the child `pid` started in its own namespace. */
function otherNamespaceOf(pid: number | undefined): string | undefined {
  for (const name of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1] === String(pid)) {
        return readlinkSync(`/proc/${name}/ns/pid`);
      }
    } catch {
      // exited
    }
  }
  return undefined;
}

/** Processes still running in a PID namespace; a zombie waiting to be reaped runs nothing. */
function namespaceMembers(namespace: string): number {
  let members = 0;
  for (const name of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      if (readlinkSync(`/proc/${name}/ns/pid`) !== namespace) continue;
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z") members += 1;
    } catch {
      // exited, or another user's
    }
  }
  return members;
}

describe("host-local desktop capsule under real Bubblewrap", () => {
  it.runIf(canRunBwrap)(
    "keeps the checkout, home, keyring, session bus, SSH agent, and OCTANT values out of a desktop",
    async () => {
      const { root, directory, port } = fixture();
      const checkout = join(root, "checkout");
      mkdirSync(checkout);
      writeFileSync(join(checkout, "secret.txt"), "checkout secret");
      const leaseId = decodeDesktopLeaseId(randomUUID());
      const inbox = join(directory, "desktops", String(leaseId), "inbox");
      const home = homedir();
      // When the temporary directory sits under the home directory, the
      // lease directory's own path is all of home a desktop may see.
      const towardLease = relative(home, root).startsWith("..")
        ? ""
        : (relative(home, root).split(sep)[0] ?? "");
      const saved = { ...process.env };
      process.env.OCTANT_PROBE_SECRET = "octant-secret";
      process.env.SSH_AUTH_SOCK = join(root, "agent.sock");
      process.env.DBUS_SESSION_BUS_ADDRESS = "unix:path=/run/user/1000/bus";
      let output: string;
      try {
        output = await capsuleOutput(
          port,
          "sh",
          [
            "-c",
            [
              "read -r go",
              'cat "$1/secret.txt" 2>/dev/null && echo "read-checkout"',
              'echo "home:$(ls -A "$2" 2>/dev/null | tr "\\n" " ")"',
              'test -e "$2/.local/share/keyrings" && echo "keyring-visible"',
              "test -e /run/user && echo run-user-visible",
              "test -e /run/dbus && echo system-bus-visible",
              'echo "env:$(env | cut -d= -f1 | sort | tr "\\n" " ")"',
              'touch "$HOME/written" && echo home-writable',
              'touch "$3/dropped" 2>/dev/null || echo inbox-read-only',
              'echo "net:$(tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d " " | tr "\\n" " ")"',
            ].join("\n"),
            "probe",
            checkout,
            home,
            inbox,
          ],
          leaseId,
        );
      } finally {
        process.env = saved;
      }

      expect(output).not.toContain("read-checkout");
      expect(output).toContain(`home:${towardLease === "" ? "" : `${towardLease} `}\n`);
      expect(output).not.toContain("keyring-visible");
      expect(output).not.toContain("run-user-visible");
      expect(output).not.toContain("system-bus-visible");
      const environment = /env:(.*)\n/.exec(output)?.[1]?.trim().split(" ") ?? [];
      expect(environment.filter((name) => !["PWD", "SHLVL", "_"].includes(name)).sort()).toEqual([
        "HOME",
        "LANG",
        "PATH",
        "TMPDIR",
      ]);
      expect(output).toContain("home-writable");
      expect(output).toContain("inbox-read-only");
      expect(output).toContain("net:lo \n");
      expect(existsSync(join(directory, "desktops", String(leaseId)))).toBe(false);
    },
  );

  it.runIf(canRunBash)("cannot connect to a server on the host's loopback", async () => {
    const { port } = fixture();
    const server = createServer((socket) => socket.end("octant"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port: listening } = server.address() as AddressInfo;
    try {
      const output = await capsuleOutput(port, "bash", [
        "-c",
        'read -r go; if exec 3<>"/dev/tcp/127.0.0.1/$1"; then echo connected; else echo refused; fi 2>/dev/null',
        "probe",
        String(listening),
      ]);
      expect(output.trim()).toBe("refused");
    } finally {
      server.close();
    }
  });

  it.runIf(canRunBwrap)(
    "never stops a process in another namespace that reuses a dead desktop's namespace number",
    async () => {
      const { directory, port } = fixture();
      const leaseId = decodeDesktopLeaseId(randomUUID());
      const launched = await port.launch({
        leaseId,
        hostTag,
        program: "sh",
        args: ["-c", "read -r go"],
        output: () => undefined,
        signal: new AbortController().signal,
      });
      if (launched.status !== "launched") throw new Error("not launched");
      // The host dies: its desktop dies with it, and its lease directory and
      // receipt are left for the next start to clean up.
      const [receiptName] = readdirSync(join(directory, "receipts"));
      const receipt = JSON.parse(
        readFileSync(join(directory, "receipts", receiptName ?? ""), "utf8"),
      ) as { readonly pid: number };
      process.kill(-receipt.pid, "SIGKILL");
      await launched.desktop.exited;
      // Namespace numbers are reused once freed. Another program's namespace
      // now carries the number recorded for the dead desktop.
      const other = spawn(
        DEFAULT_BWRAP_PATH,
        [
          "--unshare-all",
          "--die-with-parent",
          "--ro-bind",
          "/",
          "/",
          "--proc",
          "/proc",
          "sleep",
          "60",
        ],
        { stdio: "ignore" },
      );
      try {
        let reused: string | undefined;
        for (let tries = 0; tries < 100 && reused === undefined; tries += 1) {
          await new Promise((resolve) => setTimeout(resolve, 20));
          reused = otherNamespaceOf(other.pid);
        }
        if (reused === undefined) throw new Error("the other program never entered a namespace");
        const record = join(directory, "desktops", String(leaseId), "pid-namespace");
        writeFileSync(record, readFileSync(record, "utf8").replace(/pid:\[[0-9]+\]/, reused));

        const again = createHostLocalDesktopLaunch({
          directory,
          hostTag,
          platform: "linux",
          provisioning: () => false,
          stopTimeoutMs: 2_000,
        });
        await expect(again.stop(leaseId)).resolves.toEqual({ status: "released" });
        await expect(again.inspect(leaseId)).resolves.toEqual({ status: "gone" });
        expect(namespaceMembers(reused)).toBeGreaterThan(0);
        expect(other.exitCode).toBeNull();
      } finally {
        other.kill("SIGKILL");
      }
    },
  );

  it.runIf(canRunBwrap)(
    "lands a delivered file read-only in a running desktop's inbox and nowhere else",
    async () => {
      const { directory, port } = fixture();
      const leaseId = decodeDesktopLeaseId(randomUUID());
      const lease = join(directory, "desktops", String(leaseId));
      const inbox = join(lease, "inbox");
      const bytes = new TextEncoder().encode("built app\n");
      await expect(port.deliver(leaseId, "app.bin", bytes)).resolves.toEqual({
        status: "refused",
        reason: "not-running",
      });

      let output = "";
      const launched = await port.launch({
        leaseId,
        hostTag,
        program: "sh",
        args: [
          "-c",
          [
            "read -r go",
            'cat "$1/app.bin"',
            'ls "$1" | tr "\\n" " "; echo',
            'echo again >> "$1/app.bin" 2>/dev/null || echo file-read-only',
            'rm -f "$1/app.bin" 2>/dev/null; test -e "$1/app.bin" && echo still-there',
          ].join("\n"),
          "probe",
          inbox,
        ],
        output: (chunk) => {
          output += new TextDecoder().decode(chunk);
        },
        signal: new AbortController().signal,
      });
      if (launched.status !== "launched") throw new Error("not launched");
      for (const name of ["", ".", "..", "../escape.bin", "dist/app.bin", "a\0b"]) {
        await expect(port.deliver(leaseId, name, bytes)).resolves.toEqual({
          status: "refused",
          reason: "invalid-name",
        });
      }
      await expect(
        port.deliver(leaseId, "app.bin", new TextEncoder().encode("old")),
      ).resolves.toEqual({ status: "delivered" });
      // A second transfer under the same name replaces the first.
      await expect(port.deliver(leaseId, "app.bin", bytes)).resolves.toEqual({
        status: "delivered",
      });
      expect(readdirSync(lease).sort()).toEqual(["home", "host-tag", "inbox", "pid-namespace"]);
      expect(statSync(join(inbox, "app.bin")).mode & 0o777).toBe(0o444);
      await launched.desktop.write(new TextEncoder().encode("go\n"));
      await launched.desktop.exited;

      expect(output).toBe("built app\napp.bin \nfile-read-only\nstill-there\n");
      await expect(port.stop(leaseId)).resolves.toEqual({ status: "released" });
      await expect(port.deliver(leaseId, "app.bin", bytes)).resolves.toEqual({
        status: "refused",
        reason: "not-running",
      });
      expect(existsSync(lease)).toBe(false);
    },
  );

  it.runIf(process.platform === "linux")(
    "refuses to launch for a lease the host is not provisioning",
    async () => {
      const { port, directory } = fixture(() => false);
      await expect(
        port.launch({
          leaseId: decodeDesktopLeaseId(randomUUID()),
          hostTag,
          program: "sh",
          args: ["-c", "true"],
          output: () => undefined,
          signal: new AbortController().signal,
        }),
      ).resolves.toEqual({ status: "refused", reason: "not-provisioning" });
      expect(existsSync(join(directory, "desktops"))).toBe(false);
    },
  );
});

function openJournal(connection: SqliteConnection) {
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => new Date(START).toISOString(),
  });
  for (const projection of runtime.projections.all()) {
    catchUpProjection({
      connection,
      journal,
      projection,
      clock: () => new Date(START).toISOString(),
    });
  }
  return { journal, projection: runtime.desktopLeaseProjection };
}

/** One host process over a data directory: its journal, launch port, driver, and lease service. */
function hostOver(
  connection: SqliteConnection,
  directory: string,
  checkout?: string,
  executionPolicy: ProviderExecutionPolicy = "full-access",
) {
  const { journal, projection } = openJournal(connection);
  const port = createHostLocalDesktopLaunch({
    directory,
    hostTag,
    platform: "linux",
    provisioning: (leaseId) => projection.get(leaseId)?.lease.state === "provisioning",
    stopTimeoutMs: 2_000,
  });
  const provider = createHostLocalDesktopProvider(port);
  const service = createDesktopLeaseService({
    journal,
    projection,
    hostTag,
    platform: "linux",
    hasScreen: false,
    providers: () => [{ provider, effective: true }],
    recipe: () => recipe,
    thread: () => ({ active: true, executionPolicy }),
    callerMayOpen: () => true,
    computerUseEnabled: () => true,
    confirm: async () => "approved",
    threadRoot: async () => checkout,
    confirmTransfer: async () => "approved",
    systemActor: decodeEventActor({ kind: "system", actorId: randomUUID() }),
    now: () => Date.now(),
    uuid: randomUUID,
  });
  return { service, projection, journal };
}

describe("host-local desktop under real Bubblewrap and Xvfb", () => {
  it.runIf(canRunDesktop)(
    "streams frames and takes input, then leaves no process on release",
    async () => {
      const { directory, port } = fixture();
      const provider = createHostLocalDesktopProvider(port);
      const leaseId = decodeDesktopLeaseId(randomUUID());
      const acquired = await provider.acquire({
        leaseId,
        hostTag,
        recipe,
        expiresAt: decodeUtcTimestamp(new Date(Date.now() + 30 * 60_000).toISOString()),
        signal: new AbortController().signal,
      });
      expect(acquired.status).toBe("acquired");
      if (acquired.status !== "acquired") return;
      const namespace = recordedNamespace(directory, leaseId);
      expect(namespaceMembers(namespace)).toBeGreaterThan(1);

      const opened = await provider.screen(acquired.handle);
      if (opened.status !== "ready") throw new Error("no screen");
      const frame = await opened.screen.frame();
      expect(frame).toMatchObject({ status: "frame", frame: { width: 640, height: 480 } });
      for (const event of [
        { kind: "pointer", action: "move", x: 100, y: 100 },
        { kind: "pointer", action: "down", button: "left", x: 100, y: 100 },
        { kind: "pointer", action: "up", button: "left", x: 100, y: 100 },
        { kind: "key", action: "down", key: "a" },
        { kind: "key", action: "up", key: "a" },
        { kind: "text", text: "héllo; $(id)" },
        { kind: "scroll", x: 10, y: 10, deltaX: 0, deltaY: 240 },
      ] as const) {
        await expect(opened.screen.input(event)).resolves.toEqual({ status: "delivered" });
      }

      await expect(provider.release(acquired.handle)).resolves.toEqual({ status: "released" });
      await expect(provider.verifyGone(acquired.handle)).resolves.toEqual({ status: "gone" });
      expect(namespaceMembers(namespace)).toBe(0);
      expect(existsSync(join(directory, "desktops", String(leaseId)))).toBe(false);
      expect(readdirSync(join(directory, "receipts"))).toEqual([]);
    },
  );

  it.runIf(canRunDesktop)(
    "leaves no process once a restarted host reconciles its leases",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-host-desktop-")));
      directories.push(root);
      const directory = join(root, "desktop-leases");
      const connection = openSqlite(join(root, "octant.sqlite3"));
      applyMigrations(connection, MIGRATIONS, () => new Date(START).toISOString());

      const before = hostOver(connection, directory);
      const acquired = await before.service.acquire({
        owner: { mode: "code", threadId: randomUUID() },
        actor: decodeEventActor({ kind: "local-user", actorId: randomUUID() }),
      });
      expect(acquired.status).toBe("acquired");
      if (acquired.status !== "acquired") return;
      const leaseId = acquired.lease.leaseId;
      const namespace = recordedNamespace(directory, leaseId);
      expect(namespaceMembers(namespace)).toBeGreaterThan(1);

      const after = hostOver(connection, directory);
      await expect(after.service.start()).resolves.toEqual({
        released: 1,
        stillRunning: 0,
        orphansDestroyed: 0,
      });
      expect(after.projection.get(leaseId)?.lease).toMatchObject({
        state: "released",
        endReason: "host-restart",
      });
      expect(namespaceMembers(namespace)).toBe(0);
      expect(existsSync(join(directory, "desktops", String(leaseId)))).toBe(false);
      connection.close();
    },
  );

  it.runIf(canRunDesktop)(
    "sends a checkout file through the lease service into the running desktop's inbox",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-host-desktop-")));
      directories.push(root);
      const directory = join(root, "desktop-leases");
      const checkout = join(root, "checkout");
      mkdirSync(join(checkout, "dist"), { recursive: true });
      writeFileSync(join(checkout, "dist", "app.bin"), "built app");
      const connection = openSqlite(join(root, "octant.sqlite3"));
      applyMigrations(connection, MIGRATIONS, () => new Date(START).toISOString());
      const { service } = hostOver(connection, directory, checkout);
      const caller = {
        owner: { mode: "code" as const, threadId: randomUUID() },
        actor: decodeEventActor({ kind: "local-user", actorId: randomUUID() }),
      };
      const acquired = await service.acquire(caller);
      if (acquired.status !== "acquired") throw new Error("not acquired");
      const leaseId = acquired.lease.leaseId;

      await expect(
        service.transfer({ ...caller, leaseId, path: "dist/app.bin" }),
      ).resolves.toMatchObject({ status: "delivered", artifact: { name: "app.bin", size: 9 } });
      const landed = join(directory, "desktops", String(leaseId), "inbox", "app.bin");
      expect(readFileSync(landed, "utf8")).toBe("built app");
      expect(statSync(landed).mode & 0o777).toBe(0o444);

      await expect(service.release({ ...caller, leaseId })).resolves.toMatchObject({
        status: "released",
      });
      expect(existsSync(join(directory, "desktops", String(leaseId)))).toBe(false);
      connection.close();
    },
  );

  it.runIf(canRunDesktop)(
    "keeps the desktop-provider seam's promises over the real launch port",
    async () => {
      const { port } = fixture();
      await expect(
        runDesktopProviderConformance({
          create: (scenario): DesktopProvider => {
            const provider = createHostLocalDesktopProvider(port);
            return {
              ...provider,
              // A host-local desktop has no clock to move; the only extension
              // it cannot take is one for a desktop that is no longer running.
              extend: async (handle, expiresAt) => {
                if (scenario.providerDeclinesExtension) await port.stop(handle.leaseId);
                return provider.extend(handle, expiresAt);
              },
              // A destroy that never reaches the desktop leaves it running.
              release: async (handle) =>
                scenario.desktopOutlivesDestroy ? { status: "released" } : provider.release(handle),
            };
          },
          recipe,
          unsupportedCommand: ELEMENT_CLICK,
        }),
      ).resolves.toMatchObject({ stoppedWhenCancelled: true, reportedAbsenceOnlyWhenAbsent: true });
      const leftover = await port.listOwned(hostTag);
      for (const leaseId of leftover.status === "listed" ? leftover.leaseIds : []) {
        await port.stop(leaseId);
      }
    },
  );

  it.runIf(canRunDesktop && executable("/usr/bin/xev"))(
    "lets a scripted agent turn send, launch, observe, click, type into, and screenshot a GUI app",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-host-desktop-")));
      directories.push(root);
      const directory = join(root, "desktop-leases");
      const checkout = join(root, "checkout");
      mkdirSync(join(checkout, "dist"), { recursive: true });
      // The app under test: a window that logs every event it receives into the desktop's home.
      const app = '#!/bin/sh\nexec xev -geometry 320x200+0+0 > "$HOME/events" 2>/dev/null\n';
      writeFileSync(join(checkout, "dist", "notes-app"), app);
      const connection = openSqlite(join(root, "octant.sqlite3"));
      applyMigrations(connection, MIGRATIONS, () => new Date(START).toISOString());
      const { service, projection } = hostOver(connection, directory, checkout, "approval-gated");
      const threadId = randomUUID();
      const person = decodeEventActor({ kind: "local-user", actorId: randomUUID() });
      const acquired = await service.acquire({ owner: { mode: "code", threadId }, actor: person });
      if (acquired.status !== "acquired") throw new Error("not acquired");
      const leaseId = acquired.lease.leaseId;

      const owner = decodeComputerUseOwner({
        windowId: randomUUID(),
        threadId,
        mode: "code",
        providerInstanceId: randomUUID(),
        modelId: "scripted",
        executionPolicy: "approval-gated",
        leaseId,
      });
      const authority = decodeToolActionAuthority({
        hostId: randomUUID(),
        mode: "code",
        projectId: randomUUID(),
        providerInstanceId: owner.providerInstanceId,
        extension: { kind: "core" },
      });
      const asked: Array<string> = [];
      const ingested: Array<string> = [];
      const computer = createComputerUseToolService({
        leases: createLeasedComputerUsePort(service, projection),
        settings: () => ({ enabled: true, automaticUpdates: true }),
        authority: () => authority,
        ownerIsCurrent: () => true,
        toolConstraints: () => [],
        externalContentIngested: () => ingested.length > 0,
        threadTitle: () => "Notes app",
        record: () => undefined,
      });
      const bound = computer.toolSet(owner, computerUseSelection("scripted"), true, async (q) => {
        asked.push(q);
        return "approved";
      });
      if (bound === undefined) throw new Error("the send did not bind its desktop");
      const tools = taintAppManagedToolResults({
        tools: bound,
        threadId,
        recordExternalContentIngestion: (input) => {
          ingested.push(String(input.contentReference));
          return { kind: "ignored", reason: "not-tainting" };
        },
        uuid: randomUUID,
      });
      const turn = (input: Record<string, unknown>) =>
        tools.execute({ name: "octant_computer", inputJson: JSON.stringify(input) });
      const observe = async () => {
        const observed = await turn({ operation: "observe", appId: "notes-app", windowId: 1 });
        if (
          typeof observed.result !== "object" ||
          observed.result === null ||
          !("observationId" in observed.result) ||
          typeof observed.result.observationId !== "string"
        )
          throw new Error(`no observation: ${JSON.stringify(observed.result)}`);
        return { observationId: observed.result.observationId, images: observed.images ?? [] };
      };

      try {
        await expect(turn({ operation: "send-file", path: "dist/notes-app" })).resolves.toEqual({
          result: {
            kind: "sent",
            name: "notes-app",
            size: app.length,
            sha256: createHash("sha256").update(app).digest("hex"),
          },
          isError: false,
        });
        expect(asked[0]).toContain("dist/notes-app");
        await expect(turn({ operation: "apps" })).resolves.toMatchObject({
          result: { kind: "apps", apps: [{ appId: "notes-app" }] },
        });
        await expect(turn({ operation: "launch", appId: "notes-app" })).resolves.toMatchObject({
          result: { kind: "windows", windows: [{ windowId: 1 }] },
        });

        // The window takes a moment to map; observe until the screen changes.
        const first = await observe();
        let shown = first;
        for (let attempt = 0; attempt < 15; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          shown = await observe();
          if (JSON.stringify(shown.images) !== JSON.stringify(first.images)) break;
        }
        await turn({ operation: "click", observationId: shown.observationId, x: 40, y: 40 });
        await turn({
          operation: "type",
          observationId: shown.observationId,
          text: "hi",
        });
        await turn({ operation: "press", observationId: shown.observationId, key: "Enter" });

        // What the window itself received: the click, each typed key, and Enter.
        const events = join(directory, "desktops", String(leaseId), "home", "events");
        const received = () => (existsSync(events) ? readFileSync(events, "utf8") : "");
        for (let attempt = 0; attempt < 50 && !received().includes("Return"); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        expect(received()).toContain("ButtonPress event");
        expect(received()).toMatch(/KeyPress event[^]*keysym 0x[0-9a-f]+, h\)/);
        expect(received()).toMatch(/KeyPress event[^]*keysym 0x[0-9a-f]+, i\)/);
        expect(received()).toMatch(/KeyPress event[^]*keysym 0x[0-9a-f]+, Return\)/);

        const screenshot = await observe();
        expect(screenshot.images).toEqual([
          { mimeType: "image/png", data: expect.stringMatching(/^iVBORw0KGgo/) },
        ]);

        // Per-app approval held under taint: every action after the first result asked again.
        expect(ingested.length).toBeGreaterThan(0);
        expect(
          asked.filter((question) => question.startsWith("Allow this one action in notes-app")),
        ).not.toHaveLength(0);
        const journaled = connection
          .prepare(
            "SELECT event_name, actor_kind, payload_json FROM event_journal WHERE aggregate_id = ? AND event_name IN (?, ?) ORDER BY global_sequence",
          )
          .all(String(leaseId), "desktop.artifact-sent@1", "desktop.operated@1") as Array<{
          event_name: string;
          actor_kind: string;
          payload_json: string;
        }>;
        expect(
          journaled.map((row) => [
            row.actor_kind,
            row.event_name === "desktop.operated@1"
              ? (JSON.parse(row.payload_json) as { operation: string }).operation
              : "sent",
          ]),
        ).toEqual([
          ["agent", "sent"],
          ["agent", "launch"],
          ["agent", "click"],
          ["agent", "type"],
          ["agent", "press"],
        ]);
        expect(journaled.map((row) => row.payload_json).join("")).not.toContain('"hi"');
      } finally {
        await tools.close?.();
        await computer.close();
        await service.release({ owner: { mode: "code", threadId }, actor: person, leaseId });
        connection.close();
      }
      expect(existsSync(join(directory, "desktops", String(leaseId)))).toBe(false);
    },
    // Every action waits on an approval and a screen grab inside a capsule.
    120_000,
  );

  it.runIf(canRunDesktop && executable("/usr/bin/xev"))(
    "lets a person watch and operate a running app from a Desktop tab, journaled as the person and asked nothing",
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "octant-host-desktop-")));
      directories.push(root);
      const directory = join(root, "desktop-leases");
      const checkout = join(root, "checkout");
      mkdirSync(join(checkout, "dist"), { recursive: true });
      const app = '#!/bin/sh\nexec xev -geometry 320x200+0+0 > "$HOME/events" 2>/dev/null\n';
      writeFileSync(join(checkout, "dist", "notes-app"), app);
      const connection = openSqlite(join(root, "octant.sqlite3"));
      applyMigrations(connection, MIGRATIONS, () => new Date(START).toISOString());
      // Approval-gated: a person's own input is still asked nothing.
      const { service } = hostOver(connection, directory, checkout, "approval-gated");
      const threadId = randomUUID();
      const tab = {
        owner: { mode: "code" as const, threadId },
        actor: decodeEventActor({ kind: "local-user", actorId: randomUUID() }),
        scopeId: randomUUID(),
      };
      const acquired = await service.acquire(tab);
      if (acquired.status !== "acquired") throw new Error("not acquired");
      const leaseId = acquired.lease.leaseId;
      try {
        await expect(
          service.transfer({ ...tab, leaseId, path: "dist/notes-app" }),
        ).resolves.toMatchObject({ status: "delivered" });
        const agent = decodeEventActor({
          kind: "agent",
          actorId: randomUUID(),
          providerInstanceId: randomUUID(),
          threadId,
        });
        await expect(
          service.control({
            owner: tab.owner,
            actor: agent,
            leaseId,
            command: decodeComputerControlCommand({ operation: "launch", appId: "notes-app" }),
          }),
        ).resolves.toMatchObject({ status: "answered", result: { kind: "windows" } });

        const opened = await service.openView({ ...tab, leaseId });
        if (opened.status !== "viewing") throw new Error(`no view: ${JSON.stringify(opened)}`);
        const view = { ...tab, leaseId, viewId: opened.viewId };
        const frame = await service.frame(view);
        expect(frame).toMatchObject({ status: "frame", frame: { width: 640, height: 480 } });

        // The window takes a moment to map before it takes the pointer.
        const events = join(directory, "desktops", String(leaseId), "home", "events");
        const received = () => (existsSync(events) ? readFileSync(events, "utf8") : "");
        for (let attempt = 0; attempt < 50 && !received().includes("MapNotify"); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        for (const event of [
          { kind: "pointer", action: "move", x: 40, y: 40 },
          { kind: "pointer", action: "down", button: "left", x: 40, y: 40 },
          { kind: "pointer", action: "up", button: "left", x: 40, y: 40 },
          { kind: "text", text: "hi" },
          { kind: "key", action: "down", key: "Enter" },
          { kind: "key", action: "up", key: "Enter" },
        ] as const) {
          await expect(service.input({ ...view, event })).resolves.toEqual({ status: "delivered" });
        }
        for (let attempt = 0; attempt < 50 && !received().includes("Return"); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        expect(received()).toContain("ButtonPress event");
        expect(received()).toMatch(/KeyPress event[^]*keysym 0x[0-9a-f]+, h\)/);
        expect(received()).toMatch(/KeyPress event[^]*keysym 0x[0-9a-f]+, Return\)/);

        const journaled = connection
          .prepare(
            "SELECT actor_kind, payload_json FROM event_journal WHERE aggregate_id = ? AND event_name = ? ORDER BY global_sequence",
          )
          .all(String(leaseId), "desktop.operated@1") as Array<{
          actor_kind: string;
          payload_json: string;
        }>;
        expect(
          journaled.map((row) => [
            row.actor_kind,
            (JSON.parse(row.payload_json) as { operation: string }).operation,
          ]),
        ).toEqual([
          ["agent", "launch"],
          ["local-user", "click"],
          ["local-user", "type"],
          ["local-user", "press"],
        ]);
        expect(journaled.map((row) => row.payload_json).join("")).not.toContain('"hi"');
      } finally {
        await service.release({ ...tab, leaseId });
        connection.close();
      }
      expect(existsSync(join(directory, "desktops", String(leaseId)))).toBe(false);
    },
    120_000,
  );
});
