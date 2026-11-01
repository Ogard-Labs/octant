import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TerminalService } from "../code/terminalService";
import { ServerConnection } from "./serverConnection";
import { serverTerminalLogin } from "./serverTerminal";
import {
  canRunThrowawaySshd,
  startThrowawaySshd,
  type ThrowawaySshd,
} from "./throwawaySshd.test-support";

describe.skipIf(!canRunThrowawaySshd)("a terminal in a server Project", () => {
  let sshd: ThrowawaySshd;
  let connection: ServerConnection;
  let folder = "";

  beforeAll(async () => {
    sshd = await startThrowawaySshd();
    connection = new ServerConnection({
      agentSocket: () => sshd.agentSocket,
      configFile: sshd.configFile,
    });
    folder = join(sshd.root, "site");
    mkdirSync(folder);
  }, 30_000);

  afterAll(() => sshd?.stop());

  function service() {
    const localShells = { start: vi.fn() };
    return {
      localShells,
      terminals: new TerminalService({
        port: localShells as never,
        inheritedEnvironment: {},
        credentials: { resolve: async () => "never" },
      }),
    };
  }

  const text = (terminals: TerminalService, id: string) =>
    terminals.attach(id).transcript.chunks.join("");

  it("opens a login shell in the folder on the server, and starts no shell here", async () => {
    const { terminals, localShells } = service();
    await terminals.launch({
      terminalId: "server-terminal-1",
      shell: "/bin/sh",
      cwd: folder,
      stateScope: "server",
      columns: 100,
      rows: 30,
      credentialReferences: [],
      server: serverTerminalLogin(connection, { alias: sshd.alias, user: sshd.user }, folder),
    });
    terminals.write("server-terminal-1", "pwd -P; echo done-$((40 + 2))\n");
    await vi.waitFor(() => expect(text(terminals, "server-terminal-1")).toContain("done-42"), {
      timeout: 15_000,
    });
    expect(text(terminals, "server-terminal-1")).toContain(folder);
    expect(localShells.start).not.toHaveBeenCalled();
    await terminals.terminate("server-terminal-1");
  }, 30_000);

  it("ends when the connection drops, and is not restarted", async () => {
    const { terminals } = service();
    await terminals.launch({
      terminalId: "server-terminal-2",
      shell: "/bin/sh",
      cwd: folder,
      stateScope: "server",
      columns: 100,
      rows: 30,
      credentialReferences: [],
      server: serverTerminalLogin(connection, { alias: sshd.alias, user: sshd.user }, folder),
    });
    terminals.write("server-terminal-2", "echo ready-$((1 + 1))\n");
    await vi.waitFor(() => expect(text(terminals, "server-terminal-2")).toContain("ready-2"), {
      timeout: 15_000,
    });
    sshd.dropConnections();
    await vi.waitFor(() => expect(terminals.attach("server-terminal-2").status).toBe("exited"), {
      timeout: 15_000,
    });
  }, 30_000);

  it("carries no credential from this host to the server", async () => {
    const { terminals } = service();
    await expect(
      terminals.launch({
        terminalId: "server-terminal-3",
        shell: "/bin/sh",
        cwd: folder,
        stateScope: "server",
        columns: 100,
        rows: 30,
        credentialReferences: [{ environmentName: "TOKEN", reference: "token" }],
        server: serverTerminalLogin(connection, { alias: sshd.alias, user: sshd.user }, folder),
      }),
    ).rejects.toThrow("no credentials");
  });
});
