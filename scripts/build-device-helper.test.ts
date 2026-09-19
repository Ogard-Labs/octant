import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDeviceHelper,
  DEVICE_HELPER_SOURCES,
  deviceHelperBuildArgs,
  shouldBuildDeviceHelper,
} from "./build-device-helper";

const repositoryRoot = resolve(import.meta.dirname, "..");
const sourceDirectory = resolve(repositoryRoot, "apps/desktop/native/device-helper");
// A well-formed identifier no Simulator on any host carries.
const absentSimulator = "00000000-0000-4000-8000-0000000000FF";
let fixtureRoot = "";
let helperPath = "";

type JsonObject = Record<string, unknown>;

function frame(value: JsonObject): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

function responseReader(child: ChildProcessWithoutNullStreams) {
  let buffered = Buffer.alloc(0);
  const ready: JsonObject[] = [];
  const waiting: Array<(value: JsonObject) => void> = [];
  child.stdout.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32BE(0);
      if (buffered.length < length + 4) return;
      const value = JSON.parse(buffered.subarray(4, length + 4).toString("utf8")) as JsonObject;
      buffered = buffered.subarray(length + 4);
      const next = waiting.shift();
      if (next === undefined) ready.push(value);
      else next(value);
    }
  });
  return () =>
    new Promise<JsonObject>((resolveResponse) => {
      const value = ready.shift();
      if (value === undefined) waiting.push(resolveResponse);
      else resolveResponse(value);
    });
}

beforeAll(async () => {
  if (!shouldBuildDeviceHelper()) return;
  fixtureRoot = await mkdtemp(join(tmpdir(), "octant-device-helper-test-"));
  helperPath = join(fixtureRoot, "octant-device-helper");
  await buildDeviceHelper(undefined, helperPath);
}, 120_000);

afterAll(async () => {
  if (fixtureRoot === "") return;
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe("device helper build", () => {
  it("skips the Swift device helper off macOS so Linux builds do not require swiftc", () => {
    expect(shouldBuildDeviceHelper("darwin")).toBe(true);
    expect(shouldBuildDeviceHelper("linux")).toBe(false);
    expect(shouldBuildDeviceHelper("win32")).toBe(false);
  });

  it("pins an optimized Apple Silicon macOS 14 executable built from the listed sources only", async () => {
    expect(deviceHelperBuildArgs("/repo/helper", "/repo/dist/helper")).toEqual([
      "swiftc",
      "-O",
      "-target",
      "arm64-apple-macos14.0",
      "-o",
      "/repo/dist/helper",
      ...DEVICE_HELPER_SOURCES.map((source) => `/repo/helper/${source}`),
    ]);
    for (const source of DEVICE_HELPER_SOURCES) {
      await expect(access(resolve(sourceDirectory, source))).resolves.toBeUndefined();
    }
    if (!shouldBuildDeviceHelper()) return;
    expect((await stat(helperPath)).mode & 0o111).toBe(0o111);
  });

  it("ships the license of the vendored wire models beside them", async () => {
    await expect(
      access(resolve(sourceDirectory, "vendor/simulator-hid/LICENSE")),
    ).resolves.toBeUndefined();
  });
});

describe.skipIf(!shouldBuildDeviceHelper())("device helper protocol", () => {
  it("refuses to start without one well-formed Simulator identifier", async () => {
    const child = spawn(helperPath, ["not-a-udid"], { stdio: ["pipe", "pipe", "pipe"] });
    const [exitCode] = (await once(child, "exit")) as [number | null];
    expect(exitCode).toBe(64);
  });

  it("refuses bad requests before it reaches for any Simulator, and exits when its owner goes away", async () => {
    const child = spawn(helperPath, [absentSimulator], { stdio: ["pipe", "pipe", "pipe"] });
    const read = responseReader(child);

    child.stdin.write(frame({ id: 1, op: "tap", x: 1.5, y: 0.5 }));
    expect(await read()).toMatchObject({ id: 1, ok: false, code: "malformed" });

    child.stdin.write(frame({ id: 2, op: "text", text: "a@b" }));
    const refusedText = await read();
    expect(refusedText).toMatchObject({ id: 2, ok: false, code: "unsupported-character" });
    // Typed text never reaches a log, so a refusal must not quote it.
    expect(JSON.stringify(refusedText)).not.toContain("a@b");

    child.stdin.write(frame({ id: 3, op: "key", key: "nope" }));
    expect(await read()).toMatchObject({ id: 3, ok: false, code: "unsupported-key" });

    child.stdin.write(frame({ id: 4, op: "launch-missiles" }));
    expect(await read()).toMatchObject({ id: 4, ok: false, code: "malformed" });

    child.stdin.end();
    const [exitCode] = (await once(child, "exit")) as [number | null];
    expect(exitCode).toBe(0);
  });

  it("names why it cannot reach a Simulator that does not exist", async () => {
    const child = spawn(helperPath, [absentSimulator], { stdio: ["pipe", "pipe", "pipe"] });
    const read = responseReader(child);
    child.stdin.write(frame({ id: 1, op: "tap", x: 0.5, y: 0.5 }));
    const response = await read();
    expect(response).toMatchObject({ id: 1, ok: false });
    // A Mac with Xcode knows the device is absent; one without cannot load
    // the Simulator framework at all. Both are refusals, never a silent pass.
    expect(["no-such-device", "toolchain-unavailable"]).toContain(response.code);
    child.stdin.end();
    await once(child, "exit");
  }, 30_000);
});
