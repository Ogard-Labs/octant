import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ServerConnection,
  serverRemoteCommand,
  serverSshArguments,
  serverSshEnvironment,
} from "./serverConnection";
import {
  canRunThrowawaySshd,
  startThrowawaySshd,
  type ThrowawaySshd,
} from "./throwawaySshd.test-support";

describe("a server connection's arguments", () => {
  it("names no key, forwards nothing, and accepts no new host key", () => {
    const args = serverSshArguments({ alias: "web1", user: "deploy" }, "true", {
      terminal: false,
    });
    expect(args).not.toContain("-i");
    expect(args).not.toContain("-A");
    expect(args).not.toContain("-F");
    for (const option of [
      "BatchMode=yes",
      "StrictHostKeyChecking=yes",
      "ForwardAgent=no",
      "ClearAllForwardings=yes",
      "PermitLocalCommand=no",
      "ControlPath=none",
    ]) {
      expect(args).toContain(option);
    }
    expect(args.slice(-5)).toEqual(["-l", "deploy", "--", "web1", "true"]);
  });

  it("shares a connection only through the socket it is given", () => {
    const args = serverSshArguments({ alias: "web1", user: "deploy" }, "true", {
      terminal: false,
      controlSocket: "/tmp/octant-ssh-x/0123456789abcdef",
    });
    expect(args).toContain("ControlMaster=auto");
    expect(args).toContain("ControlPath=/tmp/octant-ssh-x/0123456789abcdef");
    expect(args).not.toContain("ControlPath=none");
  });

  it("hands ssh the person's agent and none of this host's secrets", () => {
    const environment = serverSshEnvironment(
      {
        PATH: "/usr/bin",
        HOME: "/Users/person",
        OCTANT_DESKTOP_BRIDGE_SECRET: "secret",
        OPENAI_API_KEY: "sk-test",
      },
      "/tmp/agent.sock",
    );
    expect(environment).toEqual({
      PATH: "/usr/bin",
      HOME: "/Users/person",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    });
  });

  it("runs nothing when the shared connection's folder cannot be made", async () => {
    const connection = new ServerConnection({
      agentSocket: () => undefined,
      sshPath: "/nonexistent/ssh",
      controlDirectory: () => {
        throw new Error("read-only /tmp");
      },
    });
    const call = await connection.run(
      { alias: "web1", user: "deploy" },
      { script: "true", timeoutMs: 1_000, maxOutputBytes: 64 },
    );
    expect(call.status).toBe("unreachable");
  });

  it("runs nothing for a word that cannot travel or a call too long to send", async () => {
    const connection = new ServerConnection({
      agentSocket: () => undefined,
      sshPath: "/nonexistent/ssh",
    });
    const send = (args: ReadonlyArray<string>) =>
      connection.run(
        { alias: "web1", user: "deploy" },
        { script: "true", args, timeoutMs: 1_000, maxOutputBytes: 64 },
      );
    expect(await send(["a\0b"])).toMatchObject({
      status: "unreachable",
      message: expect.stringContaining("NUL"),
    });
    expect(await send(["!".repeat(40_000)])).toMatchObject({
      status: "unreachable",
      message: expect.stringContaining("too long"),
    });
  });
});

describe("the text a server's login shell is handed", () => {
  const HOSTILE = [
    'x\\\'; touch "$MARK"; #',
    "it's",
    "\\",
    "\\\\'",
    '$(touch "$MARK")',
    '\`touch "$MARK"\`',
    "a\nb\n",
    "!!",
    "",
    "-n",
    "%s\\c",
    "ünï",
    "x".repeat(20_000),
  ];

  it("holds nothing a shell could act on, whatever the argument", () => {
    const wire = serverRemoteCommand("printf ok", HOSTILE);
    expect(wire).not.toMatch(/\n|!|\\'|\\\\|\`/);
    // Past the fixed decoder, only plain bytes, quotes, and octal escapes.
    const words = wire.slice(wire.indexOf("' octant ") + 9);
    expect(/^(?:'(?:[\w./ -]|\\0[0-7]{3})*' ?)+$/.test(words)).toBe(true);
  });

  // What sshd does with the text: the login shell's `-c`. Fish and the csh
  // family read single quotes differently; the shells here run on every
  // machine that has them, and all of them in the release's container check.
  const shells = ["sh", "bash", "dash", "zsh", "ksh", "fish", "tcsh", "csh"]
    .map((name) => spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }))
    .map((found) => found.stdout.trim())
    .filter((path) => path.length > 0);

  it.each(shells)("%s hands every argument to the script unchanged and runs none", (shell) => {
    const scratch = mkdtempSync(join(tmpdir(), "octant-login-shell-"));
    const mark = join(scratch, "ran");
    try {
      const out = spawnSync(
        shell,
        ["-c", serverRemoteCommand(`for a in "$@"; do printf '%s\\0' "$a"; done`, HOSTILE)],
        { env: { PATH: process.env.PATH, MARK: mark, HOME: scratch }, encoding: "utf8" },
      );
      expect(out.stdout === HOSTILE.map((word) => `${word}\0`).join("")).toBe(true);
      expect(existsSync(mark)).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!canRunThrowawaySshd)("a call on a throwaway server", () => {
  let sshd: ThrowawaySshd;
  let connection: ServerConnection;

  beforeAll(async () => {
    sshd = await startThrowawaySshd();
    connection = new ServerConnection({
      agentSocket: () => sshd.agentSocket,
      configFile: sshd.configFile,
    });
  }, 30_000);

  afterAll(() => sshd?.stop());

  const server = () => ({ alias: sshd.alias, user: sshd.user });

  it("runs a script there with its arguments and exit status", async () => {
    const call = await connection.run(server(), {
      script: `printf '%s|%s' "$1" "$2"; exit 3`,
      args: ["one word", "it's"],
      timeoutMs: 10_000,
      maxOutputBytes: 1_024,
    });
    expect(call).toMatchObject({ status: "ran", exitCode: 3 });
    if (call.status !== "ran") return;
    expect(call.output.toString()).toBe("one word|it's");
  });

  it("forwards no agent to the server", async () => {
    const call = await connection.run(server(), {
      script: `printf '[%s]' "$SSH_AUTH_SOCK"`,
      timeoutMs: 10_000,
      maxOutputBytes: 1_024,
    });
    expect(call.status === "ran" && call.output.toString()).toBe("[]");
  });

  it("refuses a server whose host key the person has not accepted", async () => {
    const call = await connection.run(
      { alias: sshd.unknownHostAlias, user: sshd.user },
      { script: "touch reached", timeoutMs: 10_000, maxOutputBytes: 1_024 },
    );
    expect(call.status).toBe("unreachable");
    expect(existsSync(join(sshd.root, "reached"))).toBe(false);
  });

  it("is unreachable where nothing listens", async () => {
    const call = await connection.run(
      { alias: sshd.closedAlias, user: sshd.user },
      { script: "true", timeoutMs: 10_000, maxOutputBytes: 1_024 },
    );
    expect(call.status).toBe("unreachable");
  });

  it("is unreachable when the connection drops mid-call", async () => {
    const pending = connection.run(server(), {
      script: "sleep 20",
      timeoutMs: 30_000,
      maxOutputBytes: 1_024,
    });
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    sshd.dropConnections();
    expect((await pending).status).toBe("unreachable");
  }, 40_000);

  it("is unreachable when the server ends the session itself, whatever ssh prints", async () => {
    // The session's own sshd process is the login shell's parent; killing it
    // closes the connection from the server's side, as a restart would.
    const call = await connection.run(server(), {
      script: `kill -9 "$(ps -o ppid= -p "$PPID" | tr -d ' ')" "$PPID"; sleep 5`,
      timeoutMs: 15_000,
      maxOutputBytes: 1_024,
    });
    expect(call.status).toBe("unreachable");
  });

  it("reuses one login for calls to the same server, and logs in again after a drop", async () => {
    const connectionOf = async () => {
      const call = await connection.run(server(), {
        script: `printf '%s' "$SSH_CONNECTION"`,
        timeoutMs: 10_000,
        maxOutputBytes: 1_024,
      });
      return call.status === "ran" ? call.output.toString() : call.status;
    };
    const first = await connectionOf();
    expect(first).toMatch(/^127\.0\.0\.1 \d+ /);
    expect(await connectionOf()).toBe(first);
    sshd.dropConnections();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await connectionOf();
    expect(after).toMatch(/^127\.0\.0\.1 \d+ /);
    expect(after).not.toBe(first);
  }, 40_000);

  it("keeps a script's own exit status apart from a lost connection", async () => {
    const call = await connection.run(server(), {
      script: "exit 255",
      timeoutMs: 10_000,
      maxOutputBytes: 1_024,
    });
    expect(call).toMatchObject({ status: "ran", exitCode: 254 });
  });

  it("hangs up a timed-out terminal call's process on the server", async () => {
    const marker = join(sshd.root, "still-running");
    const call = await connection.run(server(), {
      script: `echo $$ > "$1"; sleep 30`,
      args: [marker],
      terminal: true,
      timeoutMs: 1_500,
      maxOutputBytes: 1_024,
    });
    expect(call.status).toBe("timed-out");
    const pid = Number(readFileSync(marker, "utf8").trim());
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 20_000);
});
