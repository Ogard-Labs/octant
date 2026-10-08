import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// serve-avd 0.1.3 prints its quiet-mode state with JSON.stringify(state, null, 2).
const indentedScript = `
const serial = process.argv[process.argv.length - 1];
console.log(JSON.stringify({
  pid: process.pid,
  port: 9,
  device: serial,
  name: "pixel",
  url: "http://127.0.0.1:9",
  streamUrl: "http://127.0.0.1:9/helper/" + serial + "/stream.mjpeg",
  wsUrl: "ws://127.0.0.1:9/helper/" + serial + "/ws",
}, null, 2));
setInterval(() => {}, 1000);
`;

const openBrokers: ServeAvdBroker[] = [];

afterEach(async () => {
  const closing = openBrokers.splice(0);
  await Promise.all(closing.map((broker) => broker.close()));
});

function post(broker: ServeAvdBroker, body: unknown): Promise<Response> {
  return fetch(broker.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-octant-managed-device-token": broker.token,
    },
    body: JSON.stringify(body),
  });
}

function tools(source = script) {
  const launches: Array<ReadonlyArray<string>> = [];
  return {
    launches,
    launchSpec: async (_tool: string, args: ReadonlyArray<string>) => {
      launches.push(args);
      return {
        command: process.execPath,
        args: ["-e", source, "--", ...args],
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

  it("attaches when serve-avd prints its state as indented JSON across lines", async () => {
    const managed = tools(indentedScript);
    const broker = await startServeAvdBroker(managed);
    openBrokers.push(broker);
    const response = await post(broker, { serial: "emulator-5554" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      origin: "http://127.0.0.1:9",
      streamUrl: "http://127.0.0.1:9/helper/emulator-5554/stream.mjpeg",
    });
  });

  it("runs serve-avd against the server's SDK with adb mDNS discovery off", async () => {
    const sdkRoot = await mkdtemp(join(tmpdir(), "octant-avd-sdk-"));
    await mkdir(join(sdkRoot, "platform-tools"));
    await writeFile(join(sdkRoot, "platform-tools", "adb"), "");
    const environments: NodeJS.ProcessEnv[] = [];
    const broker = await startServeAvdBroker(tools(), {
      spawn: (command, args, options) => {
        environments.push(options.env);
        return spawn(command, [...args], options);
      },
    });
    openBrokers.push(broker);
    const response = await post(broker, { serial: "emulator-5554", sdkRoot });
    expect(response.status).toBe(200);
    expect(environments[0]).toMatchObject({
      ADB_MDNS: "0",
      ANDROID_HOME: sdkRoot,
      ANDROID_SDK_ROOT: sdkRoot,
    });
    await rm(sdkRoot, { recursive: true, force: true });
  });

  it("refuses an SDK location that holds no adb", async () => {
    const broker = await startServeAvdBroker(tools());
    openBrokers.push(broker);
    const relative = await post(broker, { serial: "emulator-5554", sdkRoot: "sdk" });
    expect(relative.status).toBe(400);
    const empty = await post(broker, {
      serial: "emulator-5554",
      sdkRoot: join(tmpdir(), "octant-no-such-sdk"),
    });
    expect(empty.status).toBe(400);
  });

  it("says why serve-avd did not attach", async () => {
    const missing = await startServeAvdBroker({
      launchSpec: async () => undefined,
      trackProcess: vi.fn(),
    });
    openBrokers.push(missing);
    expect(await (await post(missing, { serial: "emulator-5554" })).json()).toEqual({
      error: "managed-device-broker-unavailable",
      reason: "tool-missing",
    });
    const exited = await startServeAvdBroker(
      tools("console.error(\"No device or AVD matching 'emulator-5554'.\"); process.exit(1);"),
    );
    openBrokers.push(exited);
    expect(await (await post(exited, { serial: "emulator-5554" })).json()).toEqual({
      error: "managed-device-broker-unavailable",
      reason: "tool-exited",
    });
    const silent = await startServeAvdBroker(tools("setInterval(() => {}, 1000);"), {
      readyMs: 200,
    });
    openBrokers.push(silent);
    expect(await (await post(silent, { serial: "emulator-5554" })).json()).toEqual({
      error: "managed-device-broker-unavailable",
      reason: "timed-out",
    });
  });
});
