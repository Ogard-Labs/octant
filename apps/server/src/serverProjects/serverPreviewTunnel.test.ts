import { afterEach, describe, expect, it } from "vitest";
import { connect, createServer } from "node:net";
import { ServerPreviewTunnels, serverPreviewSshArguments } from "./serverPreviewTunnel";

const server = { alias: "web", user: "deploy" };
const owned: ServerPreviewTunnels[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((tunnel) => tunnel.close()));
});
function fixture() {
  let current = true;
  const records: unknown[] = [];
  const tunnels = new ServerPreviewTunnels({
    address: () => (current ? { server, identity: "binding-1" } : undefined),
    ownerCurrent: () => true,
    agentSocket: () => undefined,
    record: (record) => {
      records.push(record);
      return true;
    },
  });
  owned.push(tunnels);
  return {
    tunnels,
    records,
    revoke: () => {
      current = false;
    },
  };
}
describe("owned server previews", () => {
  it("uses a dedicated stdio forward while retaining command-channel trust restrictions", () => {
    const args = serverPreviewSshArguments(server, 5173);
    for (const option of [
      "ClearAllForwardings=yes",
      "BatchMode=yes",
      "StrictHostKeyChecking=yes",
      "ForwardAgent=no",
      "ControlPath=none",
      "ControlMaster=no",
    ])
      expect(args).toContain(option);
    expect(args.slice(-6)).toEqual(["-W", "127.0.0.1:5173", "-l", "deploy", "--", "web"]);
  });
  it("refuses an unavailable Project before listening or recording", async () => {
    const { tunnels, records, revoke } = fixture();
    revoke();
    expect(await tunnels.start("project", "window", 5173, 0)).toMatchObject({ kind: "refused" });
    expect(records).toEqual([]);
  });
  it("reports a port collision without replacing the listener", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (address === null || typeof address === "string") throw new Error("missing address");
    const { tunnels } = fixture();
    try {
      expect(await tunnels.start("project", "window", 5173, address.port)).toMatchObject({
        kind: "refused",
        reason: "port-unavailable",
      });
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });
  it("keeps the selected endpoint, refuses another owner and closes on binding removal", async () => {
    const { tunnels, revoke, records } = fixture();
    const opened = await tunnels.start("project", "window", 5173, 0);
    expect(opened.kind).toBe("tunnel");
    if (opened.kind !== "tunnel") return;
    expect(opened.view).toMatchObject({ remotePort: 5173, status: "listening" });
    expect(await tunnels.start("project", "other-window", 3000, 0)).toMatchObject({
      kind: "refused",
      reason: "already-owned",
    });
    revoke();
    await tunnels.reconcile();
    expect(tunnels.read("project", "window")).toMatchObject({ status: "revoked" });
    expect(records).toHaveLength(2);
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = connect(opened.view.localPort, "127.0.0.1");
        socket.on("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.on("error", reject);
      }),
    ).rejects.toThrow();
  });
});
