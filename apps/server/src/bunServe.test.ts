import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { request } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface RawResponse {
  readonly handlerCalled: string | undefined;
  readonly listenerTrust: string | undefined;
  readonly sourceClass: string | undefined;
  readonly sourceKeyLength: string | undefined;
  readonly status: number | undefined;
}

let child: ChildProcessWithoutNullStreams;
let serverUrl: URL;

beforeAll(async () => {
  child = spawn("bun", [
    fileURLToPath(new URL("./bunServe.integration-fixture.ts", import.meta.url)),
  ]);
  serverUrl = new URL(await firstOutputLine(child));
});

afterAll(async () => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
});

function rawRequest(
  url: URL,
  options: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly chunks?: readonly string[];
    readonly method?: "GET" | "HEAD" | "POST";
  },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      url,
      { method: options.method ?? "GET", headers: options.headers },
      (response) => {
        response.resume();
        response.on("end", () => {
          const handlerHeader = response.headers["x-octant-handler"];
          const listenerTrust = response.headers["x-octant-listener-trust"];
          const sourceClass = response.headers["x-octant-source-class"];
          const sourceKeyLength = response.headers["x-octant-source-key-length"];
          resolve({
            handlerCalled: Array.isArray(handlerHeader) ? handlerHeader[0] : handlerHeader,
            listenerTrust: Array.isArray(listenerTrust) ? listenerTrust[0] : listenerTrust,
            sourceClass: Array.isArray(sourceClass) ? sourceClass[0] : sourceClass,
            sourceKeyLength: Array.isArray(sourceKeyLength) ? sourceKeyLength[0] : sourceKeyLength,
            status: response.statusCode,
          });
        });
      },
    );
    outgoing.on("error", reject);
    for (const chunk of options.chunks ?? []) outgoing.write(chunk);
    outgoing.end();
  });
}

describe("bunServe", () => {
  it.each(["GET", "HEAD"] as const)(
    "rejects a declared %s body before invoking the Fetch handler",
    async (method) => {
      const response = await rawRequest(new URL("/declared", serverUrl), {
        method,
        headers: { "content-length": "5" },
        chunks: ["12345"],
      });

      expect(response).toEqual({ handlerCalled: undefined, status: 413 });
    },
  );

  it.each(["GET", "HEAD"] as const)(
    "rejects a chunked %s body before invoking the Fetch handler",
    async (method) => {
      const response = await rawRequest(new URL("/chunked", serverUrl), {
        method,
        headers: { "transfer-encoding": "chunked" },
        chunks: ["1234", "5"],
      });

      expect(response).toEqual({ handlerCalled: undefined, status: 413 });
    },
  );

  it.each(["GET", "HEAD"] as const)("dispatches a bodyless %s request", async (method) => {
    const response = await rawRequest(new URL("/safe", serverUrl), { method });

    expect(response).toEqual({
      handlerCalled: "called",
      listenerTrust: "loopback",
      sourceClass: "loopback",
      sourceKeyLength: "64",
      status: 204,
    });
  });

  it("rejects a declared POST body before invoking the Fetch handler", async () => {
    const response = await rawRequest(new URL("/declared-post", serverUrl), {
      method: "POST",
      headers: { "content-length": "5" },
      chunks: ["12345"],
    });

    expect(response).toEqual({
      handlerCalled: undefined,
      listenerTrust: undefined,
      sourceClass: undefined,
      sourceKeyLength: undefined,
      status: 413,
    });
  });

  it("ignores forwarded identity headers when deriving trusted Bun facts", async () => {
    const response = await rawRequest(new URL("/safe", serverUrl), {
      method: "GET",
      headers: {
        "x-forwarded-for": "8.8.8.8",
        "x-real-ip": "8.8.8.8",
        forwarded: "for=8.8.8.8",
      },
    });

    expect(response).toEqual({
      handlerCalled: "called",
      listenerTrust: "loopback",
      sourceClass: "loopback",
      sourceKeyLength: "64",
      status: 204,
    });
  });
});

function firstOutputLine(process: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const newline = output.indexOf("\n");
      if (newline === -1) return;
      process.stdout.off("data", onData);
      resolve(output.slice(0, newline).trim());
    };
    process.stdout.on("data", onData);
    process.once("error", reject);
    process.once("exit", (code) => reject(new Error(`Bun fixture exited before ready (${code}).`)));
  });
}
