import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { decodeCanvasExportRenderedOutput } from "@octant/contracts/canvas-export";
import {
  ExtensionSupervisor,
  type ExtensionProcessStartInput,
  type ExtensionProcessExit,
} from "../extensions/extensionSupervisor";
import { runCanvasExportWorker } from "./canvasExportWorkerProcess";
import { canvasExportWorkerFetch } from "./canvasExportWorkerFetch";

vi.mock("./canvasExportWorkerFetch", () => ({
  canvasExportWorkerFetch: vi.fn(async () => ({
    kind: "fetch-response",
    id: 1,
    status: 200,
    headers: {},
    bodyBase64: "b2s=",
  })),
}));
const output = decodeCanvasExportRenderedOutput({
  schemaVersion: 1,
  kind: "canvas-export-output",
  format: "markdown",
  title: "Review",
  body: "hello",
  metadata: {
    canvasId: "11111111-1111-4111-8111-111111111111",
    versionId: "22222222-2222-4222-8222-222222222222",
    sequence: 1,
    byteLength: 5,
    contentDigest: `sha256:${"a".repeat(64)}`,
  },
});
const reference = {
  extensionId: "33333333-3333-4333-8333-333333333333",
  packageId: "44444444-4444-4444-8444-444444444444",
  version: "1.0.0",
  digest: `sha256:${"a".repeat(64)}`,
};

function harness(reply: (line: string, send: (value: unknown) => void) => void) {
  const launches: ExtensionProcessStartInput[] = [];
  const stopped = vi.fn();
  const supervisor = new ExtensionSupervisor({
    clock: () => new Date().toISOString(),
    authorizeLaunch: async () => true,
    process: {
      receipts: async () => [],
      start: async (input) => {
        launches.push(input);
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        let exited: ((exit: ExtensionProcessExit) => void) | undefined;
        const wait = new Promise<ExtensionProcessExit>((resolve) => {
          exited = resolve;
        });
        const stop = async () => {
          stopped();
          stdin.destroy();
          stdout.destroy();
          exited?.({ code: 0, signal: null });
        };
        stdin.on("data", (chunk: Buffer) =>
          reply(chunk.toString(), (value) => stdout.write(`${JSON.stringify(value)}\n`)),
        );
        return {
          pid: 12345,
          stdin,
          stdout,
          ready: Promise.resolve(),
          wait,
          stop,
          once: () => undefined,
        };
      },
    },
  });
  const options = {
    supervisor,
    store: {
      verifiedModuleEntry: async () => ({
        packageRoot: "/private/tmp/plugin",
        entryPoint: "/private/tmp/plugin/export.mjs",
      }),
    },
    runtime: { kind: "bun" as const, path: "/host/bun" },
    workerEntryPoint: "/host/canvasExportWorker.mjs",
    platform: "darwin" as const,
  };
  return { options, launches, stopped };
}

const input = {
  reference,
  componentId: "export",
  current: () => true,
  allowedOrigins: ["https://example.test"],
  phase: "describe" as const,
  output,
};
describe("supervised Canvas export invocations", () => {
  it("describes offline through the fixed host worker and stops its process", async () => {
    const { options, launches, stopped } = harness((_line, send) =>
      send({ kind: "description", destination: { account: "Review account" } }),
    );
    expect(await runCanvasExportWorker(options, input)).toMatchObject({
      kind: "description",
      destination: { account: "Review account" },
    });
    expect(launches[0]).toMatchObject({
      args: ["/host/canvasExportWorker.mjs", "/private/tmp/plugin/export.mjs"],
      env: {},
      sandbox: { kind: "canvas-export", packageRoot: "/private/tmp/plugin" },
    });
    expect(stopped).toHaveBeenCalledTimes(1);
  });
  it("refuses network messages during description and never invokes the network port", async () => {
    vi.mocked(canvasExportWorkerFetch).mockClear();
    const { options, stopped } = harness((_line, send) =>
      send({
        kind: "fetch",
        id: 1,
        url: "https://example.test/pages",
        method: "POST",
        headers: {},
        bodyBase64: "aGVsbG8=",
      }),
    );
    expect(await runCanvasExportWorker(options, input)).toEqual({ kind: "failed" });
    expect(canvasExportWorkerFetch).not.toHaveBeenCalled();
    expect(stopped).toHaveBeenCalledTimes(1);
  });
  it("mediates an approved export request and returns its decoded receipt once", async () => {
    const { options, stopped } = harness((line, send) => {
      if (line.includes("fetch-response"))
        send({
          kind: "delivery",
          delivery: { kind: "receipt", receipt: { kind: "remote-id", remoteId: "review-copy" } },
        });
      else
        send({
          kind: "fetch",
          id: 1,
          url: "https://example.test/pages",
          method: "POST",
          headers: { "content-type": "application/json" },
          bodyBase64: "aGVsbG8=",
        });
    });
    expect(await runCanvasExportWorker(options, { ...input, phase: "export" })).toMatchObject({
      kind: "delivery",
      delivery: { kind: "receipt" },
    });
    expect(stopped).toHaveBeenCalledTimes(1);
  });
  it("refuses changed authority and unsupported platforms before a process exists", async () => {
    const { options, launches } = harness(() => undefined);
    expect(await runCanvasExportWorker(options, { ...input, current: () => false })).toEqual({
      kind: "failed",
    });
    expect(await runCanvasExportWorker({ ...options, platform: "linux" }, input)).toEqual({
      kind: "failed",
    });
    expect(await runCanvasExportWorker({ ...options, platform: "win32" }, input)).toEqual({
      kind: "failed",
    });
    expect(launches).toHaveLength(0);
  });
  it("refuses a receipt emitted after activation is revoked", async () => {
    let active = true;
    const { options, stopped } = harness((_line, send) => {
      active = false;
      send({ kind: "description" });
    });
    expect(await runCanvasExportWorker(options, { ...input, current: () => active })).toEqual({
      kind: "failed",
    });
    expect(stopped).toHaveBeenCalledTimes(1);
  });
});
