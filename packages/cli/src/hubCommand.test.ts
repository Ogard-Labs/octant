import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHostRuntimePaths } from "@octant/host-runtime";
import { readDiskEncryption } from "./diskEncryption";
import { resolveHubCliCommand, runHubCliCommand, type HubCliCommand } from "./hubCommand";
import type { LocalControlRequest, LocalControlResponse } from "./localControl";
import { createHubBootService, type ServiceCommandRunner } from "./serviceManager";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const MEMBER = "11111111-1111-4111-8111-111111111111";
const DEFAULT_GRANT = { items: ["roster", "introduce", "owners"], actProjects: [] };

describe("octant hub command parsing", () => {
  it("reads every hub command and its flags", () => {
    expect(resolveHubCliCommand(["status"], {})).toEqual({ action: "status" });
    expect(resolveHubCliCommand(["enable"], {})).toEqual({
      action: "enable",
      installService: false,
    });
    expect(resolveHubCliCommand(["enable"], { "install-service": true })).toEqual({
      action: "enable",
      installService: true,
    });
    expect(resolveHubCliCommand(["disable"], { "remove-service": true })).toEqual({
      action: "disable",
      removeService: true,
    });
    expect(resolveHubCliCommand(["join-code"], { owner: true })).toEqual({
      action: "join-code",
      owner: true,
    });
    expect(resolveHubCliCommand(["join", "CODE"], { items: "roster,Status,roster" })).toEqual({
      action: "join",
      code: "CODE",
      items: ["roster", "status"],
    });
    expect(resolveHubCliCommand(["grant"], { items: "none" })).toEqual({
      action: "grant",
      items: [],
    });
    expect(resolveHubCliCommand(["leave"], {})).toEqual({ action: "leave" });
    expect(resolveHubCliCommand(["remove", "Laptop"], {})).toEqual({
      action: "remove",
      member: "Laptop",
    });
  });

  it("rejects unknown commands, stray flags, and items outside the closed list", () => {
    expect(resolveHubCliCommand([], {})).toBeUndefined();
    expect(resolveHubCliCommand(["frobnicate"], {})).toBeUndefined();
    expect(resolveHubCliCommand(["status"], { owner: true })).toBeUndefined();
    expect(resolveHubCliCommand(["join"], {})).toBeUndefined();
    expect(resolveHubCliCommand(["join-code"], { owner: "yes" })).toBeUndefined();
    expect(resolveHubCliCommand(["enable"], { "install-service": "now" })).toBeUndefined();
    expect(resolveHubCliCommand(["grant"], { items: "roster,teleport" })).toBeUndefined();
    expect(resolveHubCliCommand(["grant"], { items: true })).toBeUndefined();
    expect(resolveHubCliCommand(["remove"], {})).toBeUndefined();
  });
});

type Responder = (request: LocalControlRequest) => LocalControlResponse;

async function fixture(
  responder: Responder,
  options: {
    readonly platform?: NodeJS.Platform;
    readonly daemonInstalled?: boolean;
    readonly ask?: (question: string) => Promise<string | undefined>;
    readonly encryption?: "encrypted" | "not-encrypted" | "unknown";
    readonly files?: Readonly<Record<string, string>>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "octant-hub-cli-"));
  roots.push(root);
  const platform = options.platform ?? "darwin";
  const probe = join(root, "daemon.plist");
  if (options.daemonInstalled === true) await writeFile(probe, "");
  const probeCommands: Array<readonly [string, readonly string[]]> = [];
  const probeRunner: ServiceCommandRunner = {
    run: async (command, args) => {
      probeCommands.push([command, args]);
      return { stdout: options.daemonInstalled === true ? "yes\n" : "no\n", stderr: "" };
    },
  };
  const bootService =
    platform === "win32"
      ? undefined
      : createHubBootService({
          paths: resolveHostRuntimePaths({
            env: { OCTANT_DATA_DIR: join(root, "data") },
            platform,
            home: join(root, "home"),
            temporaryDirectory: "/tmp",
            uid: 501,
          }),
          uid: 501,
          home: "/Users/henrik",
          userName: "henrik",
          executable: "/opt/octant/bin/octant",
          platform,
          runner: probeRunner,
          launchDaemonProbePath: probe,
        });
  const sent: LocalControlRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const administrator = vi.fn(async (_command: string, _args: readonly string[]) => ({
    stdout: "",
    stderr: "",
  }));
  const installLogin = vi.fn(async () => undefined);
  const enableLogin = vi.fn(async () => undefined);
  let clock = 0;
  const run = (command: HubCliCommand) =>
    runHubCliCommand({
      command,
      session: {
        kind: "opened",
        windowId: "w",
        send: async (request) => {
          sent.push(request);
          return responder(request);
        },
        close: async () => undefined,
      },
      stdout: { write: (chunk) => out.push(chunk), isTTY: false },
      stderr: { write: (chunk) => err.push(chunk) },
      platform,
      ...(bootService === undefined ? {} : { bootService }),
      loginService: { install: installLogin, enable: enableLogin },
      administrator: { run: administrator },
      diskEncryption: async () => options.encryption ?? "encrypted",
      ...(options.ask === undefined ? {} : { ask: options.ask }),
      readFile: async (path) => {
        const text = options.files?.[path];
        if (text === undefined) throw new Error("No such file.");
        return text;
      },
      now: () => clock,
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    });
  return {
    root,
    sent,
    out,
    err,
    administrator,
    installLogin,
    enableLogin,
    run,
    text: () => out.join(""),
    errors: () => err.join(""),
  };
}

const ok = (body: unknown): LocalControlResponse => ({ status: 200, body });

describe("octant hub enable", () => {
  it("turns the role on and prints the one administrator command without running it or touching the system", async () => {
    const host = await fixture(() => ok({ status: "enabled", roster: {} }));
    const before = await readdir(host.root, { recursive: true });

    expect(await host.run({ action: "enable", installService: false })).toBe(0);

    expect(host.sent.map((request) => request.path)).toEqual(["/api/desktop/hub/enable"]);
    expect(host.administrator).not.toHaveBeenCalled();
    expect(host.installLogin).not.toHaveBeenCalled();
    expect(await readdir(host.root, { recursive: true })).toEqual(before);
    expect(host.text()).toContain("sudo /bin/sh -c");
    expect(host.text()).toContain("/Library/LaunchDaemons/app.octant.server.plist");
    expect(host.text()).toContain("octant hub enable --install-service");
    expect(host.text()).toContain("sudo pmset -a autorestart 1");
  });

  it("runs the administrator command only when the person passed the flag", async () => {
    const host = await fixture(() => ok({ status: "enabled", roster: {} }));

    expect(await host.run({ action: "enable", installService: true })).toBe(0);

    expect(host.administrator).toHaveBeenCalledTimes(1);
    const [program, args = []] = host.administrator.mock.calls[0] ?? [];
    expect(program).toBe("/usr/bin/sudo");
    expect(args.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(host.installLogin).not.toHaveBeenCalled();
  });

  it("asks systemd to linger for the account on Linux and installs the user unit after the flag", async () => {
    const host = await fixture(() => ok({ status: "enabled", roster: {} }), {
      platform: "linux",
    });

    await host.run({ action: "enable", installService: false });
    expect(host.text()).toContain("sudo /usr/bin/loginctl enable-linger henrik");
    expect(host.text()).not.toContain("pmset");
    expect(host.administrator).not.toHaveBeenCalled();

    await host.run({ action: "enable", installService: true });
    expect(host.administrator).toHaveBeenCalledWith("/usr/bin/sudo", [
      "/usr/bin/loginctl",
      "enable-linger",
      "henrik",
    ]);
    expect(host.installLogin).toHaveBeenCalledTimes(1);
    expect(host.enableLogin).toHaveBeenCalledTimes(1);
  });

  it("reports a failed administrator step with the command to run by hand and exits non-zero", async () => {
    const host = await fixture(() => ok({ status: "enabled", roster: {} }));
    host.administrator.mockRejectedValueOnce(new Error("exit 1"));

    expect(await host.run({ action: "enable", installService: true })).toBe(1);

    expect(host.errors()).toContain("sudo /bin/sh -c");
    expect(host.out.join("")).not.toContain("starts at boot, with no one logged in");
  });

  it("warns when the disk is not encrypted or cannot be checked, and still succeeds", async () => {
    const off = await fixture(() => ok({ status: "enabled", roster: {} }), {
      encryption: "not-encrypted",
    });
    expect(await off.run({ action: "enable", installService: false })).toBe(0);
    expect(off.text()).toContain("disk is not encrypted");

    const unknown = await fixture(() => ok({ status: "enabled", roster: {} }), {
      encryption: "unknown",
    });
    expect(await unknown.run({ action: "enable", installService: false })).toBe(0);
    expect(unknown.text()).toContain("could not check");

    const sound = await fixture(() => ok({ status: "enabled", roster: {} }));
    await sound.run({ action: "enable", installService: false });
    expect(sound.text()).not.toContain("Warning");
  });

  it("shows the server's refusal as it is and exits non-zero", async () => {
    const host = await fixture(() => ({
      status: 409,
      body: { status: "refused", kind: "listener-not-private" },
    }));

    expect(await host.run({ action: "enable", installService: true })).toBe(1);

    expect(host.errors()).toContain("not on a private network address");
    expect(host.errors()).toContain("(listener-not-private)");
    expect(host.administrator).not.toHaveBeenCalled();
  });

  it("says the hub role is not available on Windows and sends nothing", async () => {
    const host = await fixture(() => ok({}), { platform: "win32" });

    for (const command of [
      { action: "enable", installService: false },
      { action: "disable", removeService: false },
      { action: "join-code", owner: false },
    ] as const) {
      expect(await host.run(command)).toBe(1);
    }

    expect(host.errors()).toContain("not available on Windows yet");
    expect(host.sent).toEqual([]);
  });
});

describe("octant hub disable", () => {
  it("restores the ordinary login service after removing the launch daemon when the person passed the flag", async () => {
    const host = await fixture(() => ok({ status: "disabled" }), { daemonInstalled: true });

    expect(await host.run({ action: "disable", removeService: true })).toBe(0);

    const [program, args = []] = host.administrator.mock.calls[0] ?? [];
    expect(program).toBe("/usr/bin/sudo");
    expect(args[2]).toContain("launchctl bootout system/app.octant.server");
    expect(args[2]).toContain("rm -f /Library/LaunchDaemons/app.octant.server.plist");
    expect(host.installLogin).toHaveBeenCalledTimes(1);
    expect(host.enableLogin).toHaveBeenCalledTimes(1);
    expect(host.text()).toContain("back to the ordinary login service");
  });

  it("prints the removal command and changes nothing when the person did not pass the flag", async () => {
    const host = await fixture(() => ok({ status: "disabled" }), { daemonInstalled: true });

    expect(await host.run({ action: "disable", removeService: false })).toBe(0);

    expect(host.administrator).not.toHaveBeenCalled();
    expect(host.installLogin).not.toHaveBeenCalled();
    expect(host.text()).toContain("octant hub disable --remove-service");
    expect(host.text()).toContain("octant server enable");
  });

  it("says nothing about services when no boot service is installed", async () => {
    const host = await fixture(() => ok({ status: "disabled" }));

    expect(await host.run({ action: "disable", removeService: false })).toBe(0);

    expect(host.text()).toBe("The hub role is off.\n");
  });

  it("turns lingering off for the account on Linux", async () => {
    const host = await fixture(() => ok({ status: "disabled" }), {
      platform: "linux",
      daemonInstalled: true,
    });

    await host.run({ action: "disable", removeService: true });

    expect(host.administrator).toHaveBeenCalledWith("/usr/bin/sudo", [
      "/usr/bin/loginctl",
      "disable-linger",
      "henrik",
    ]);
  });
});

describe("octant hub boot service files", () => {
  it("describes a launch daemon that runs the server as the person with KeepAlive and RunAtLoad", async () => {
    const host = await fixture(() => ok({}));
    const boot = createHubBootService({
      paths: resolveHostRuntimePaths({
        env: { OCTANT_DATA_DIR: join(host.root, "data") },
        platform: "darwin",
        home: join(host.root, "home"),
        temporaryDirectory: "/tmp",
        uid: 501,
      }),
      uid: 501,
      home: "/Users/henrik",
      userName: "henrik",
      executable: "/opt/octant/bin/octant",
      platform: "darwin",
    });

    const plan = boot.installPlan();

    expect(plan.descriptor).toContain("<key>UserName</key><string>henrik</string>");
    expect(plan.descriptor).toContain("<key>KeepAlive</key><true/>");
    expect(plan.descriptor).toContain("<key>RunAtLoad</key><true/>");
    expect(plan.descriptor).toContain(
      "<array><string>/opt/octant/bin/octant</string><string>server</string><string>run</string></array>",
    );
    expect(plan.descriptor).toContain("<key>HOME</key><string>/Users/henrik</string>");
    // The command carries the same descriptor the person can inspect above it.
    const script = plan.administratorCommand[3] ?? "";
    const encoded = /printf %s '([^']+)'/.exec(script)?.[1] ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(plan.descriptor);
    expect(script).toContain("chown root:wheel");
  });

  it("refuses an account name that could break out of the command", () => {
    expect(() =>
      createHubBootService({
        paths: resolveHostRuntimePaths({
          env: { OCTANT_DATA_DIR: "/tmp/octant-unused" },
          platform: "darwin",
          home: "/Users/x",
          temporaryDirectory: "/tmp",
          uid: 501,
        }),
        uid: 501,
        userName: "x; rm -rf /",
        executable: "/opt/octant/bin/octant",
        platform: "darwin",
      }),
    ).toThrow(/unsafe/);
  });
});

describe("octant hub join codes and joining", () => {
  it("prints the join code as a QR and as text with its lifetime", async () => {
    const host = await fixture(() =>
      ok({ status: "minted", code: "octant-join-abc", expiresAt: 5 * 60_000, owner: true }),
    );

    expect(await host.run({ action: "join-code", owner: true })).toBe(0);

    expect(host.sent[0]).toMatchObject({
      path: "/api/desktop/hub/join-codes",
      body: { owner: true },
    });
    expect(host.text()).toContain("Join code octant-join-abc");
    expect(host.text()).toContain("in about 5 minutes");
    expect(host.text()).toContain("becomes an owner");
    expect(host.text()).toContain("▀");
  });

  it("waits for approval on the hub, shows the grant with its defaults, and keeps them without a flag", async () => {
    let finishes = 0;
    const host = await fixture((request) => {
      if (request.path === "/api/desktop/hub/join") {
        return ok({
          status: "awaiting-approval",
          hubName: "Mac mini",
          hubKeyFingerprint: "ab".repeat(32),
          comparisonCode: "482913",
        });
      }
      finishes += 1;
      return finishes < 3
        ? ok({ status: "awaiting-approval" })
        : ok({ status: "joined", rosterSequence: 2, grant: DEFAULT_GRANT });
    });

    expect(await host.run({ action: "join", code: "CODE" })).toBe(0);

    expect(finishes).toBe(3);
    expect(host.text()).toContain("Comparison code 482913");
    expect(host.text()).toContain("[x] roster");
    expect(host.text()).toContain("[ ] wake");
    expect(host.text()).toContain("The defaults stay.");
    expect(host.sent.some((request) => request.path === "/api/desktop/hub/grant")).toBe(false);
  });

  it("changes the grant from the items flag and drops Act's Projects when Act is not ticked", async () => {
    const host = await fixture((request) => {
      if (request.path === "/api/desktop/hub/join") {
        return ok({
          status: "awaiting-approval",
          hubName: "Mac mini",
          hubKeyFingerprint: "ab".repeat(32),
          comparisonCode: "482913",
        });
      }
      if (request.path === "/api/desktop/hub/join/finish") {
        return ok({ status: "joined", rosterSequence: 2, grant: DEFAULT_GRANT });
      }
      return ok({ status: "changed", grant: DEFAULT_GRANT });
    });

    expect(await host.run({ action: "join", code: "CODE", items: ["roster", "status"] })).toBe(0);

    const grant = host.sent.find((request) => request.path === "/api/desktop/hub/grant");
    expect(grant?.body).toEqual({ items: ["roster", "status"], actProjects: [] });
  });

  it("asks at a terminal and takes the person's own items", async () => {
    const answers = ["n", "roster, wake"];
    const host = await fixture(
      (request) => {
        if (request.path === "/api/desktop/hub/join") {
          return ok({
            status: "awaiting-approval",
            hubName: "Mac mini",
            hubKeyFingerprint: "ab".repeat(32),
            comparisonCode: "482913",
          });
        }
        if (request.path === "/api/desktop/hub/join/finish") {
          return ok({ status: "joined", rosterSequence: 2, grant: DEFAULT_GRANT });
        }
        return ok({ status: "changed", grant: { items: ["roster", "wake"], actProjects: [] } });
      },
      { ask: async () => answers.shift() },
    );

    expect(await host.run({ action: "join", code: "CODE" })).toBe(0);

    const grant = host.sent.find((request) => request.path === "/api/desktop/hub/grant");
    expect(grant?.body).toEqual({ items: ["roster", "wake"], actProjects: [] });
  });

  it("shows a refused join as it is and exits non-zero", async () => {
    const host = await fixture(() => ({
      status: 409,
      body: { status: "refused", kind: "hub-unreachable" },
    }));

    expect(await host.run({ action: "join", code: "CODE" })).toBe(1);

    expect(host.errors()).toContain("could not reach the hub");
    expect(host.errors()).toContain("(hub-unreachable)");
  });

  it("gives up with a plain sentence when the hub never approves", async () => {
    const host = await fixture((request) =>
      request.path === "/api/desktop/hub/join"
        ? ok({
            status: "awaiting-approval",
            hubName: "Mac mini",
            hubKeyFingerprint: "ab".repeat(32),
            comparisonCode: "482913",
          })
        : ok({ status: "awaiting-approval" }),
    );

    expect(await host.run({ action: "join", code: "CODE" })).toBe(1);

    expect(host.errors()).toContain("did not approve within five minutes");
  });
});

describe("octant hub status, grant, leave and remove", () => {
  const status = {
    hub: {
      enabled: true,
      roster: {
        roster: {
          members: [
            { memberId: MEMBER, name: "Laptop", role: "spoke", owner: false },
            {
              memberId: "22222222-2222-4222-8222-222222222222",
              name: "Mac mini",
              role: "hub",
              owner: true,
            },
          ],
        },
      },
    },
    spoke: { membership: "none" },
  };

  it("lists the members and the role", async () => {
    const host = await fixture(() => ok(status));

    expect(await host.run({ action: "status" })).toBe(0);

    expect(host.text()).toContain("Hub role on");
    expect(host.text()).toContain(`${MEMBER}  spoke  Laptop`);
    expect(host.text()).toContain("(owner)");
    expect(host.text()).toContain("has not joined a hub");
  });

  it("removes a member named by its name", async () => {
    const host = await fixture((request) =>
      request.method === "GET" ? ok(status) : ok({ status: "removed", sequence: 3 }),
    );

    expect(await host.run({ action: "remove", member: "laptop" })).toBe(0);

    expect(host.sent[1]).toMatchObject({
      path: "/api/desktop/hub/members/remove",
      body: { memberId: MEMBER },
    });
  });

  it("refuses to remove a member the roster does not list, without asking the server", async () => {
    const host = await fixture(() => ok(status));

    expect(await host.run({ action: "remove", member: "Phone" })).toBe(1);

    expect(host.errors()).toContain("No hub member is called Phone");
    expect(host.sent).toHaveLength(1);
  });

  it("reads the grant, and refuses a grant change on a computer that has not joined", async () => {
    const joined = {
      ...status,
      spoke: {
        membership: "member",
        hub: { memberId: MEMBER, name: "Mac mini" },
        grant: { items: ["roster", "act"], actProjects: ["p1"] },
      },
    };
    const reading = await fixture(() => ok(joined));
    expect(await reading.run({ action: "grant" })).toBe(0);
    expect(reading.text()).toContain("[x] act");

    const keeping = await fixture((request) =>
      request.method === "GET" ? ok(joined) : ok({ status: "changed", grant: DEFAULT_GRANT }),
    );
    await keeping.run({ action: "grant", items: ["roster", "act"] });
    expect(keeping.sent[1]?.body).toEqual({ items: ["roster", "act"], actProjects: ["p1"] });

    const none = await fixture(() => ok(status));
    expect(await none.run({ action: "grant", items: ["roster"] })).toBe(1);
    expect(none.errors()).toContain("has not joined a hub");
  });

  it("tells the person when the hub could not be told that this computer left", async () => {
    const told = await fixture(() => ok({ status: "left", hubNotified: true }));
    expect(await told.run({ action: "leave" })).toBe(0);
    expect(told.text()).toContain("The hub was told");

    const silent = await fixture(() => ok({ status: "left", hubNotified: false }));
    expect(await silent.run({ action: "leave" })).toBe(0);
    expect(silent.text()).toContain("could not be reached");

    const refused = await fixture(() => ({
      status: 409,
      body: { status: "refused", kind: "not-a-spoke" },
    }));
    expect(await refused.run({ action: "leave" })).toBe(1);
  });

  it("reports an unauthorized control channel with the server's message", async () => {
    const host = await fixture(() => ({
      status: 401,
      body: { category: "unauthorized", message: "Hub administration is unauthorized." },
    }));

    expect(await host.run({ action: "status" })).toBe(1);

    expect(host.errors()).toContain("Hub administration is unauthorized.");
  });
});

describe("octant hub offer", () => {
  const OFFER_ID = "55555555-5555-4555-8555-555555555555";
  const SPOKE_ID = "44444444-4444-4444-8444-444444444444";

  it("reads each kind of offer and refuses the rest", () => {
    expect(resolveHubCliCommand(["provision", "on"], {})).toEqual({
      action: "provision",
      enabled: true,
    });
    expect(resolveHubCliCommand(["offer", "update-channel", "preview"], {})).toEqual({
      action: "offer",
      offer: { kind: "update-channel", channel: "preview" },
    });
    expect(
      resolveHubCliCommand(["offer", "update-channel", "stable"], { mirror: "feed.json" }),
    ).toEqual({
      action: "offer",
      offer: { kind: "update-channel", channel: "stable", mirrorFeedFile: "feed.json" },
    });
    expect(resolveHubCliCommand(["offer", "plugin", "octant", "review", "sha256:x"], {})).toEqual({
      action: "offer",
      offer: { kind: "plugin", catalogId: "octant", entryId: "review", digest: "sha256:x" },
    });
    expect(resolveHubCliCommand(["offer", "routine", "routine.json"], {})).toEqual({
      action: "offer",
      offer: { kind: "routine", file: "routine.json" },
    });
    expect(resolveHubCliCommand(["apply", OFFER_ID], { project: "p" })).toEqual({
      action: "apply",
      offerId: OFFER_ID,
      projectId: "p",
    });
    expect(resolveHubCliCommand(["auto-apply", "plugin", "on"], {})).toEqual({
      action: "auto-apply",
      kind: "plugin",
      enabled: true,
    });
    // A routine and an endpoint row cannot be set to apply on arrival.
    expect(resolveHubCliCommand(["auto-apply", "routine", "on"], {})).toBeUndefined();
    expect(resolveHubCliCommand(["auto-apply", "model-endpoint", "on"], {})).toBeUndefined();
    expect(resolveHubCliCommand(["offer", "update-channel", "nightly"], {})).toBeUndefined();
    expect(resolveHubCliCommand(["offer", "secret", "x"], {})).toBeUndefined();
    expect(resolveHubCliCommand(["offer", "plugin", "a", "b"], {})).toBeUndefined();
  });

  it("sends an offer through the window-only route, with a mirrored feed read from its file", async () => {
    const host = await fixture(() => ok({ status: "offered", offerId: OFFER_ID, delivered: 1 }), {
      files: { "feed.json": '{"schemaVersion":1}' },
    });

    expect(
      await host.run({
        action: "offer",
        offer: { kind: "update-channel", channel: "preview", mirrorFeedFile: "feed.json" },
      }),
    ).toBe(0);

    expect(host.sent[0]).toMatchObject({
      path: "/api/desktop/hub/provision/offers",
      body: {
        offer: { kind: "update-channel", channel: "preview", mirror: true },
        mirrorFeed: { schemaVersion: 1 },
      },
    });
    expect(host.text()).toContain(OFFER_ID);
  });

  it("puts the kind on the fields of a profile, endpoint, or routine file, and reports a file it cannot read", async () => {
    const host = await fixture(() => ok({ status: "offered", offerId: OFFER_ID, delivered: 0 }), {
      files: { "endpoint.json": '{"displayName":"Gateway"}', "bad.json": "[1]" },
    });

    await host.run({ action: "offer", offer: { kind: "model-endpoint", file: "endpoint.json" } });
    expect(host.sent[0]).toMatchObject({
      body: { offer: { kind: "model-endpoint", displayName: "Gateway" } },
    });
    expect(await host.run({ action: "offer", offer: { kind: "routine", file: "bad.json" } })).toBe(
      1,
    );
    expect(await host.run({ action: "offer", offer: { kind: "routine", file: "none.json" } })).toBe(
      1,
    );
    expect(host.sent).toHaveLength(1);
    expect(host.errors()).toContain("could not read that offer file");
  });

  it("applies, dismisses, and sets applying on arrival through window-only routes", async () => {
    const applied = await fixture(() => ok({ status: "applied" }));
    expect(await applied.run({ action: "apply", offerId: OFFER_ID, projectId: "p" })).toBe(0);
    expect(applied.sent[0]).toMatchObject({
      path: "/api/desktop/hub/provision/apply",
      body: { offerId: OFFER_ID, projectId: "p" },
    });
    const dismissed = await fixture(() => ok({ status: "dismissed" }));
    expect(await dismissed.run({ action: "dismiss", offerId: OFFER_ID })).toBe(0);
    const auto = await fixture(() => ok({ status: "changed" }));
    expect(await auto.run({ action: "auto-apply", kind: "agent-profile", enabled: true })).toBe(0);
    expect(auto.sent[0]).toMatchObject({
      path: "/api/desktop/hub/provision/auto-apply",
      body: { kind: "agent-profile", enabled: true },
    });
    const waiting = await fixture(() => ({
      status: 409,
      body: { status: "refused", kind: "needs-person" },
    }));
    expect(await waiting.run({ action: "apply", offerId: OFFER_ID })).toBe(1);
    expect(waiting.errors()).toContain("needs-person");
  });

  it("shows the hub's offers and how each spoke took them, and a spoke's proposals", async () => {
    const hub = await fixture(() =>
      ok({
        hub: {
          enabled: true,
          roster: {
            roster: {
              standbyOrder: [],
              members: [{ memberId: SPOKE_ID, name: "Laptop", role: "spoke", owner: false }],
            },
          },
        },
        spoke: { membership: "none" },
        provision: {
          hub: {
            enabled: true,
            offers: [
              {
                offerId: OFFER_ID,
                kind: "plugin",
                mirrored: false,
                deliveries: [{ memberId: SPOKE_ID, result: "refused", reason: "kind-unsupported" }],
              },
            ],
          },
          spoke: { offering: false, autoApply: [], proposals: [] },
        },
      }),
    );

    await hub.run({ action: "status" });

    expect(hub.text()).toContain("Offers on");
    expect(hub.text()).toContain(`${OFFER_ID}  plugin`);
    expect(hub.text()).toContain("Laptop  refused (kind-unsupported)");

    const spoke = await fixture(() =>
      ok({
        hub: { enabled: false },
        spoke: {
          membership: "member",
          hub: { memberId: MEMBER, name: "Mac mini" },
          grant: DEFAULT_GRANT,
          roster: { roster: { standbyOrder: [], members: [] } },
          rosterSignedBy: "hub",
        },
        provision: {
          hub: { enabled: false, offers: [] },
          spoke: {
            offering: true,
            autoApply: ["plugin"],
            proposals: [
              {
                offerId: OFFER_ID,
                offer: { kind: "routine" },
                expiresAt: "2026-11-05T00:00:00.000Z",
              },
            ],
          },
        },
      }),
    );

    await spoke.run({ action: "status" });

    expect(spoke.text()).toContain("applying on arrival plugin");
    expect(spoke.text()).toContain(`${OFFER_ID}  routine  until 2026-11-05T00:00:00.000Z`);
  });
});

describe("octant hub wake", () => {
  const SPOKE_ID = "44444444-4444-4444-8444-444444444444";
  const status = (wake: Record<string, unknown>) => ({
    hub: {
      enabled: true,
      roster: {
        roster: {
          standbyOrder: [],
          members: [{ memberId: SPOKE_ID, name: "Laptop", role: "spoke", owner: false }],
        },
      },
    },
    spoke: { membership: "none" },
    wake,
  });

  it("reads wake on and off and nothing else", () => {
    expect(resolveHubCliCommand(["wake", "on"], {})).toEqual({ action: "wake", enabled: true });
    expect(resolveHubCliCommand(["wake", "off"], {})).toEqual({ action: "wake", enabled: false });
    expect(resolveHubCliCommand(["wake"], {})).toBeUndefined();
    expect(resolveHubCliCommand(["wake", "maybe"], {})).toBeUndefined();
    expect(resolveHubCliCommand(["wake", "on", "extra"], {})).toBeUndefined();
    expect(resolveHubCliCommand(["wake", "on"], { force: true })).toBeUndefined();
  });

  it("turns the wake service on and off through the window-only route", async () => {
    const on = await fixture(() => ok({ status: "changed", enabled: true }));
    expect(await on.run({ action: "wake", enabled: true })).toBe(0);
    expect(on.sent[0]).toMatchObject({ path: "/api/desktop/hub/wake", body: { enabled: true } });
    expect(on.text()).toContain("Wake");

    const off = await fixture(() => ok({ status: "changed", enabled: false }));
    expect(await off.run({ action: "wake", enabled: false })).toBe(0);
    expect(off.sent[0]).toMatchObject({ body: { enabled: false } });

    const refused = await fixture(() => ({
      status: 409,
      body: { status: "refused", kind: "hub-role-off" },
    }));
    expect(await refused.run({ action: "wake", enabled: true })).toBe(1);
    expect(refused.errors()).toContain("hub-role-off");
  });

  it("shows the switch, each spoke's upcoming wakes and the last result in the hub status", async () => {
    const host = await fixture(() =>
      ok(
        status({
          hub: {
            enabled: true,
            spokes: [
              {
                memberId: SPOKE_ID,
                upcoming: 2,
                lastResult: { at: 0, result: "unreachable" },
              },
            ],
          },
          spoke: { sharing: false, reported: 0 },
        }),
      ),
    );

    expect(await host.run({ action: "status" })).toBe(0);

    expect(host.text()).toContain("Wake service on");
    expect(host.text()).toContain(
      "Laptop  2 wake(s) ahead, last unreachable 1970-01-01T00:00:00.000Z",
    );
  });

  it("shows on a spoke whether it shares routine times, without ever printing a routine", async () => {
    const host = await fixture(() =>
      ok({
        hub: { enabled: false },
        spoke: {
          membership: "member",
          hub: { memberId: MEMBER, name: "Mac mini" },
          grant: DEFAULT_GRANT,
          roster: { roster: { standbyOrder: [], members: [] } },
          rosterSignedBy: "hub",
        },
        wake: {
          hub: { enabled: false, spokes: [] },
          spoke: { sharing: true, reported: 3, hardwareAddress: "aa:bb:cc:00:11:22" },
        },
      }),
    );

    expect(await host.run({ action: "status" })).toBe(0);

    expect(host.text()).toContain("tells the hub when its routines are due (3 now)");
    expect(host.text()).toContain("shares the hardware address you entered");
    expect(host.text()).not.toContain("aa:bb:cc:00:11:22");
  });
});

describe("octant hub push", () => {
  const SPOKE_ID = "44444444-4444-4444-8444-444444444444";
  const status = (push: Record<string, unknown>) => ({
    hub: {
      enabled: true,
      roster: {
        roster: {
          standbyOrder: [],
          members: [{ memberId: SPOKE_ID, name: "Laptop", role: "spoke", owner: false }],
        },
      },
    },
    spoke: { membership: "none" },
    push,
  });

  it("reads push on and off and nothing else", () => {
    expect(resolveHubCliCommand(["push", "on"], {})).toEqual({ action: "push", enabled: true });
    expect(resolveHubCliCommand(["push", "off"], {})).toEqual({ action: "push", enabled: false });
    expect(resolveHubCliCommand(["push"], {})).toBeUndefined();
    expect(resolveHubCliCommand(["push", "maybe"], {})).toBeUndefined();
    expect(resolveHubCliCommand(["push", "on", "extra"], {})).toBeUndefined();
    expect(resolveHubCliCommand(["push", "on"], { force: true })).toBeUndefined();
  });

  it("turns the push sender on and off through the window-only route", async () => {
    const on = await fixture(() => ok({ status: "changed", enabled: true }));
    expect(await on.run({ action: "push", enabled: true })).toBe(0);
    expect(on.sent[0]).toMatchObject({ path: "/api/desktop/hub/push", body: { enabled: true } });
    expect(on.text()).toContain("push sender is on");

    const off = await fixture(() => ok({ status: "changed", enabled: false }));
    expect(await off.run({ action: "push", enabled: false })).toBe(0);
    expect(off.sent[0]).toMatchObject({ body: { enabled: false } });

    const refused = await fixture(() => ({
      status: 409,
      body: { status: "refused", kind: "hub-role-off" },
    }));
    expect(await refused.run({ action: "push", enabled: true })).toBe(1);
    expect(refused.errors()).toContain("hub-role-off");
  });

  it("shows the switch, each spoke's forward counts and the last result in the hub status", async () => {
    const host = await fixture(() =>
      ok(
        status({
          hub: {
            enabled: true,
            spokes: [
              {
                memberId: SPOKE_ID,
                forwarded: 4,
                refused: 1,
                lastResult: { at: 0, result: "forwarded" },
              },
            ],
          },
          spoke: { handing: false },
        }),
      ),
    );

    expect(await host.run({ action: "status" })).toBe(0);

    expect(host.text()).toContain("Push sender on");
    expect(host.text()).toContain(
      "Laptop  4 forwarded, 1 refused, last forwarded 1970-01-01T00:00:00.000Z",
    );
  });

  it("shows on a spoke whether it hands its notifications to the hub", async () => {
    const host = await fixture(() =>
      ok({
        hub: { enabled: false },
        spoke: {
          membership: "member",
          hub: { memberId: MEMBER, name: "Mac mini" },
          grant: DEFAULT_GRANT,
          roster: { roster: { standbyOrder: [], members: [] } },
          rosterSignedBy: "hub",
        },
        push: { hub: { enabled: false, spokes: [] }, spoke: { handing: true } },
      }),
    );

    expect(await host.run({ action: "status" })).toBe(0);

    expect(host.text()).toContain("hands its sealed phone notifications to the hub");
  });
});

describe("octant hub failover commands", () => {
  const STANDBY = "33333333-3333-4333-8333-333333333333";
  const roster = (extra: Record<string, unknown> = {}) => ({
    roster: {
      standbyOrder: [STANDBY],
      members: [
        { memberId: MEMBER, name: "Mac mini", role: "hub", owner: false },
        { memberId: STANDBY, name: "Laptop", role: "standby-hub", owner: false },
      ],
    },
    ...extra,
  });
  const hubStatus = { hub: { enabled: true, roster: roster() }, spoke: { membership: "none" } };

  it("reads the failover commands and their flags", () => {
    expect(resolveHubCliCommand(["standby"], {})).toEqual({
      action: "standby",
      members: [],
      clear: false,
    });
    expect(resolveHubCliCommand(["standby", "Laptop", "Desk"], {})).toEqual({
      action: "standby",
      members: ["Laptop", "Desk"],
      clear: false,
    });
    expect(resolveHubCliCommand(["standby"], { clear: true })).toEqual({
      action: "standby",
      members: [],
      clear: true,
    });
    expect(resolveHubCliCommand(["standby", "Laptop"], { clear: true })).toBeUndefined();
    expect(resolveHubCliCommand(["promote"], {})).toEqual({ action: "promote", confirm: false });
    expect(resolveHubCliCommand(["promote"], { confirm: true })).toEqual({
      action: "promote",
      confirm: true,
    });
    expect(resolveHubCliCommand(["promote", "Laptop"], {})).toBeUndefined();
    expect(resolveHubCliCommand(["accept-hub", "Laptop"], {})).toEqual({
      action: "accept-hub",
      member: "Laptop",
    });
    expect(resolveHubCliCommand(["accept-hub"], {})).toBeUndefined();
    expect(resolveHubCliCommand(["stand-in", "join-code"], {})).toEqual({
      action: "stand-in",
      step: "join-code",
    });
    expect(resolveHubCliCommand(["stand-in", "remove", "Desk"], {})).toEqual({
      action: "stand-in",
      step: "remove",
      member: "Desk",
    });
    expect(resolveHubCliCommand(["stand-in"], {})).toBeUndefined();
    expect(resolveHubCliCommand(["stand-in", "remove"], {})).toBeUndefined();
  });

  it("lists the standby order in the hub status and when asked", async () => {
    const host = await fixture(() => ok(hubStatus));

    expect(await host.run({ action: "status" })).toBe(0);
    expect(host.text()).toContain("Standby order:");
    expect(host.text()).toContain(`1. Laptop  ${STANDBY}`);

    const listed = await fixture(() => ok(hubStatus));
    expect(await listed.run({ action: "standby", members: [], clear: false })).toBe(0);
    expect(listed.text()).toContain(`1. Laptop  ${STANDBY}`);
    expect(listed.sent).toHaveLength(1);
  });

  it("sets the standby order by name, and shows why the hub refused it", async () => {
    const setting = await fixture((request) =>
      request.method === "GET" ? ok(hubStatus) : ok({ status: "ordered", roster: {} }),
    );
    expect(await setting.run({ action: "standby", members: ["laptop"], clear: false })).toBe(0);
    expect(setting.sent[1]).toMatchObject({
      path: "/api/desktop/hub/standby-order",
      body: { memberIds: [STANDBY] },
    });

    const refused = await fixture((request) =>
      request.method === "GET"
        ? ok(hubStatus)
        : { status: 409, body: { status: "refused", kind: "standby-not-granted" } },
    );
    expect(await refused.run({ action: "standby", members: ["laptop"], clear: false })).toBe(1);
    expect(refused.errors()).toContain("has not ticked Standby");

    const cleared = await fixture((request) =>
      request.method === "GET" ? ok(hubStatus) : ok({ status: "ordered", roster: {} }),
    );
    expect(await cleared.run({ action: "standby", members: [], clear: true })).toBe(0);
    expect(cleared.sent[1]?.body).toEqual({ memberIds: [] });
  });

  it("promotes only after a typed confirmation or --confirm", async () => {
    const unconfirmed = await fixture(() => ok({ status: "promoted" }));
    expect(await unconfirmed.run({ action: "promote", confirm: false })).toBe(1);
    expect(unconfirmed.sent).toHaveLength(0);
    expect(unconfirmed.errors()).toContain("--confirm");

    const declined = await fixture(() => ok({ status: "promoted" }), { ask: async () => "no" });
    expect(await declined.run({ action: "promote", confirm: false })).toBe(1);
    expect(declined.sent).toHaveLength(0);

    const typed = await fixture(() => ok({ status: "promoted" }), { ask: async () => "promote" });
    expect(await typed.run({ action: "promote", confirm: false })).toBe(0);
    expect(typed.sent[0]).toMatchObject({
      path: "/api/desktop/hub/promote",
      body: { confirmed: true },
    });

    const flagged = await fixture(() => ok({ status: "promoted" }));
    expect(await flagged.run({ action: "promote", confirm: true })).toBe(0);
  });

  it("shows a standby standing in and a member following one", async () => {
    const spoke = (extra: Record<string, unknown>) => ({
      hub: { enabled: false },
      spoke: {
        membership: "member",
        hub: { memberId: MEMBER, name: "Mac mini" },
        grant: DEFAULT_GRANT,
        roster: roster(),
        rosterSignedBy: "standby",
        ...extra,
      },
    });
    const standing = await fixture(() =>
      ok(spoke({ standIn: { startedAt: 0, baseSequence: 4, added: 1, removed: 2 } })),
    );
    expect(await standing.run({ action: "status" })).toBe(0);
    expect(standing.text()).toContain("standing in for the hub since 1970-01-01T00:00:00.000Z");
    expect(standing.text()).toContain("added 1, removed 2");

    const following = await fixture(() => ok(spoke({})));
    expect(await following.run({ action: "status" })).toBe(0);
    expect(following.text()).toContain("follows the standby that is standing in");
  });

  it("accepts a promoted hub by name and removes a member while standing in", async () => {
    const spokeStatus = {
      hub: { enabled: false },
      spoke: {
        membership: "member",
        hub: { memberId: MEMBER, name: "Mac mini" },
        grant: DEFAULT_GRANT,
        roster: roster(),
        rosterSignedBy: "hub",
      },
    };
    const accepting = await fixture((request) =>
      request.method === "GET" ? ok(spokeStatus) : ok({ status: "accepted", sequence: 9 }),
    );
    expect(await accepting.run({ action: "accept-hub", member: "laptop" })).toBe(0);
    expect(accepting.sent[1]).toMatchObject({
      path: "/api/desktop/hub/accept-new-hub",
      body: { hubMemberId: STANDBY },
    });

    const removing = await fixture((request) =>
      request.method === "GET" ? ok(spokeStatus) : ok({ status: "removed", sequence: 9 }),
    );
    expect(await removing.run({ action: "stand-in", step: "remove", member: "Mac mini" })).toBe(0);
    expect(removing.sent[1]).toMatchObject({
      path: "/api/desktop/hub/stand-in/members/remove",
      body: { memberId: MEMBER },
    });
  });
});

describe("octant hub certificate", () => {
  it("reads the certificate flags and refuses an acknowledgement with anything but --enable", () => {
    expect(resolveHubCliCommand(["certificate"], {})).toEqual({
      action: "certificate",
      mode: "status",
      acknowledgeTransparency: false,
    });
    expect(
      resolveHubCliCommand(["certificate"], { enable: true, "acknowledge-transparency": true }),
    ).toEqual({ action: "certificate", mode: "enable", acknowledgeTransparency: true });
    expect(resolveHubCliCommand(["certificate"], { disable: true })).toEqual({
      action: "certificate",
      mode: "disable",
      acknowledgeTransparency: false,
    });
    expect(resolveHubCliCommand(["certificate"], { enable: true, disable: true })).toBeUndefined();
    expect(
      resolveHubCliCommand(["certificate"], { status: true, "acknowledge-transparency": true }),
    ).toBeUndefined();
    expect(resolveHubCliCommand(["certificate"], { enable: "yes" })).toBeUndefined();
  });

  it("asks nothing of the host and prints the transparency note when --enable comes without the acknowledgement", async () => {
    const host = await fixture(() => ok({ status: "enabled" }));

    expect(
      await host.run({ action: "certificate", mode: "enable", acknowledgeTransparency: false }),
    ).toBe(1);

    expect(host.sent).toEqual([]);
    expect(host.errors()).toContain("certificate-transparency logs");
  });

  it("turns the certificate on with the acknowledgement and then asks for it", async () => {
    const host = await fixture((request) =>
      ok(
        (request.body as { action?: string } | undefined)?.action === "enable"
          ? { status: "enabled" }
          : { status: "renewed", notAfter: 1 },
      ),
    );

    expect(
      await host.run({ action: "certificate", mode: "enable", acknowledgeTransparency: true }),
    ).toBe(0);

    expect(host.sent.map((request) => request.body)).toEqual([
      { action: "enable", acknowledgedCertificateTransparency: true },
      { action: "renew" },
    ]);
    expect(host.text()).toContain("Tailscale certificate on");
  });

  it("says why the host could not get a certificate", async () => {
    const host = await fixture((request) =>
      (request.body as { action?: string } | undefined)?.action === "enable"
        ? ok({ status: "enabled" })
        : { status: 409, body: { status: "refused", kind: "https-not-enabled" } },
    );

    expect(
      await host.run({ action: "certificate", mode: "enable", acknowledgeTransparency: true }),
    ).toBe(1);

    expect(host.errors()).toContain("HTTPS certificates are not turned on");
    expect(host.errors()).toContain("(https-not-enabled)");
  });

  it.each([
    ["invalid-certificate", "did not check out"],
    ["could-not-apply", "could not restart with that certificate"],
  ])("says why the certificate was not installed (%s)", async (kind, sentence) => {
    const host = await fixture((request) =>
      (request.body as { action?: string } | undefined)?.action === "enable"
        ? ok({ status: "enabled" })
        : { status: 409, body: { status: "refused", kind } },
    );

    expect(
      await host.run({ action: "certificate", mode: "enable", acknowledgeTransparency: true }),
    ).toBe(1);

    expect(host.errors()).toContain(sentence);
    expect(host.errors()).toContain(`(${kind})`);
  });

  it("turns the certificate off and reports its state", async () => {
    const off = await fixture(() => ok({ status: "disabled" }));
    expect(
      await off.run({ action: "certificate", mode: "disable", acknowledgeTransparency: false }),
    ).toBe(0);
    expect(off.sent[0]?.body).toEqual({ action: "disable" });

    const state = await fixture(() =>
      ok({ enabled: true, domain: "mini.tail1234.ts.net", renewal: "current" }),
    );
    expect(
      await state.run({ action: "certificate", mode: "status", acknowledgeTransparency: false }),
    ).toBe(0);
    expect(state.sent[0]?.method).toBe("GET");
    expect(state.text()).toContain("Tailscale certificate on");
    expect(state.text()).toContain("mini.tail1234.ts.net");
  });
});

describe("disk encryption reading", () => {
  const runnerReturning = (stdout: Record<string, string>): ServiceCommandRunner => ({
    run: async (command) => {
      const text = stdout[command];
      if (text === undefined) throw new Error("missing");
      return { stdout: text, stderr: "" };
    },
  });

  it("reads FileVault on macOS", async () => {
    const read = (text: string) =>
      readDiskEncryption({
        platform: "darwin",
        dataDirectory: "/d",
        runner: runnerReturning({ "/usr/bin/fdesetup": text }),
      });
    expect(await read("FileVault is On.\n")).toBe("encrypted");
    expect(await read("FileVault is Off.\n")).toBe("not-encrypted");
    expect(await read("unexpected")).toBe("unknown");
  });

  it("looks for a dm-crypt layer under the data folder's device on Linux", async () => {
    const read = (layers: string, source = "/dev/mapper/root\n") =>
      readDiskEncryption({
        platform: "linux",
        dataDirectory: "/d",
        runner: runnerReturning({ "/usr/bin/findmnt": source, "/usr/bin/lsblk": layers }),
      });
    expect(await read("lvm\ncrypt\npart\ndisk\n")).toBe("encrypted");
    expect(await read("part\ndisk\n")).toBe("not-encrypted");
    expect(await read("part\n", "tmpfs\n")).toBe("unknown");
  });

  it("reports unknown when the tools are missing", async () => {
    expect(
      await readDiskEncryption({
        platform: "linux",
        dataDirectory: "/d",
        runner: runnerReturning({}),
      }),
    ).toBe("unknown");
  });
});
