import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  quoteForServer,
  ServerConnection,
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

  it("quotes a word so the server's shell reads it whole", () => {
    expect(quoteForServer("it's $HOME")).toBe(`'it'\\''s $HOME'`);
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
