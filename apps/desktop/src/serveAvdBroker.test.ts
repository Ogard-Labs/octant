import { afterEach, describe, expect, it, vi } from "vitest";
import { startServeAvdBroker, type ServeAvdBroker } from "./serveAvdBroker";

const script = `
const serial = process.argv[process.argv.length - 1];
console.log(JSON.stringify({
  device: serial,
  url: "http://127.0.0.1:9",
  streamUrl: "http://127.0.0.1:9/helper/" + serial + "/stream.mjpeg",
  port: 9,
  pid: process.pid,
}));
setInterval(() => {}, 1000);
`;

const openBrokers: ServeAvdBroker[] = [];

afterEach(async () => {
  const closing = openBrokers.splice(0);
  await Promise.all(closing.map((broker) => broker.close()));
});

function tools() {
  const launches: Array<ReadonlyArray<string>> = [];
  return {
    launches,
    launchSpec: async (_tool: string, args: ReadonlyArray<string>) => {
      launches.push(args);
      return {
        command: process.execPath,
        args: ["-e", script, "--", ...args],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      };
    },
    trackProcess: vi.fn(),
  };
}

describe("serve-avd broker", () => {
  it("attaches a booted emulator serial and reuses that process", async () => {
    const managed = tools();
    const broker = await startServeAvdBroker(managed);
    openBrokers.push(broker);
    const first = await fetch(broker.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-managed-device-token": broker.token,
      },
      body: JSON.stringify({ serial: "emulator-5554" }),
    });
    expect(await first.json()).toEqual({
      origin: "http://127.0.0.1:9",
      streamUrl: "http://127.0.0.1:9/helper/emulator-5554/stream.mjpeg",
    });
    const second = await fetch(broker.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-managed-device-token": broker.token,
      },
      body: JSON.stringify({ serial: "emulator-5554" }),
    });
    expect(second.status).toBe(200);
    expect(managed.launches).toHaveLength(1);
    expect(managed.launches[0]?.at(-1)).toBe("emulator-5554");
    expect(managed.launches[0]).toContain("--no-preview");
  });

  it("refuses a name that would boot an AVD, a missing token, and a missing tool", async () => {
    const broker = await startServeAvdBroker({
      launchSpec: async () => undefined,
      trackProcess: vi.fn(),
    });
    openBrokers.push(broker);
    const named = await fetch(broker.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-managed-device-token": broker.token,
      },
      body: JSON.stringify({ serial: "Pixel_9" }),
    });
    expect(named.status).toBe(400);
    const anonymous = await fetch(broker.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serial: "emulator-5554" }),
    });
    expect(anonymous.status).toBe(401);
    const missing = await fetch(broker.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-managed-device-token": broker.token,
      },
      body: JSON.stringify({ serial: "emulator-5554" }),
    });
    expect(missing.status).toBe(503);
  });
});
