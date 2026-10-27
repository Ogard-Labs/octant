/**
 * A recorded E2B for the E2B desktop driver's tests: E2B's control plane and
 * the in-sandbox daemon, answering as E2B's published API documents them.
 *
 * Sources, read 2026-10-27: the OpenAPI document in E2B's public repository
 * (`spec/openapi.yml`, server `https://api.e2b.app`, `X-API-Key` auth), the
 * envd OpenAPI document and process service definition (`spec/envd/envd.yaml`,
 * `spec/envd/process/process.proto`), and E2B's JavaScript SDK, which reaches
 * envd at `https://sandbox.e2b.app` with `E2b-Sandbox-Id`, `E2b-Sandbox-Port`,
 * and `X-Access-Token` headers over Connect's JSON codec. Bodies below are the
 * documented schemas (`Sandbox`, `SandboxDetail`, `ListedSandbox`, `Error`,
 * `EntryInfo`) with the field names E2B uses.
 *
 * Inside a sandbox it plays a small Linux: it runs the few programs the
 * driver starts (by the name each script is started under), keeps files, and
 * records screen input, so tests can see what reached the desktop. It never
 * opens a socket. The API key is a test value, never a real credential.
 */
import type { DesktopHttpsFetch } from "../../computerUse/desktopHttpsPort";

export const RECORDED_E2B_API_KEY = "e2b_recorded_test_key_not_a_credential";

export interface RecordedE2bScenario {
  /** E2B holds a sandbox's timeout below what is asked, as a plan's longest sandbox does. */
  readonly holdsTimeoutAt?: number;
  /** E2B answers a kill but the sandbox keeps running. */
  readonly outlivesKill?: boolean;
  /** The domain create reports the sandbox on. */
  readonly domain?: string | null;
  /** Sandboxes per listing page, at most 100 as E2B allows. */
  readonly pageSize?: number;
}

export interface RecordedRequest {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
}

interface RecordedSandbox {
  readonly sandboxID: string;
  readonly templateID: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly startedAt: number;
  readonly accessToken: string;
  readonly createBody: unknown;
  endAt: number;
  display?: { readonly width: number; readonly height: number };
  readonly files: Map<string, Uint8Array>;
  readonly processes: Set<number>;
  readonly input: Array<ReadonlyArray<string>>;
  killed: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** A PNG signature and IHDR naming `width` by `height`; nothing reads further. */
export function recordedPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function envelope(message: unknown, flags = 0): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(message));
  const out = new Uint8Array(5 + json.byteLength);
  out[0] = flags;
  new DataView(out.buffer).setUint32(1, json.byteLength);
  out.set(json, 5);
  return out;
}

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

const error = (code: number, message: string) => Response.json({ code, message }, { status: code });

export class RecordedE2b {
  readonly #scenario: RecordedE2bScenario;
  readonly #now: () => number;
  readonly #sandboxes = new Map<string, RecordedSandbox>();
  readonly #idempotent = new Map<string, string>();
  readonly #requests: Array<RecordedRequest> = [];
  #sequence = 0;
  #pid = 400;

  constructor(scenario: RecordedE2bScenario = {}, now: () => number = () => Date.now()) {
    this.#scenario = scenario;
    this.#now = now;
  }

  readonly fetch: DesktopHttpsFetch = async (url, init) => {
    const target = new URL(url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    this.#requests.push({
      method: init.method ?? "GET",
      host: target.host,
      path: `${target.pathname}${target.search}`,
      headers,
    });
    const body =
      init.body === undefined || init.body === null
        ? new Uint8Array(0)
        : typeof init.body === "string"
          ? new TextEncoder().encode(init.body)
          : init.body instanceof Uint8Array
            ? init.body
            : new Uint8Array(0);
    if (target.host === "api.e2b.app")
      return this.#api(init.method ?? "GET", target, headers, body);
    if (target.host === "sandbox.e2b.app")
      return this.#envd(init.method ?? "GET", target, headers, body);
    throw new Error(`The recorded E2B has no host ${target.host}.`);
  };

  requests(): ReadonlyArray<RecordedRequest> {
    return [...this.#requests];
  }

  /** Sandboxes E2B still runs, as its own listing would show them. */
  running(): ReadonlyArray<{
    readonly sandboxID: string;
    readonly metadata: Readonly<Record<string, string>>;
    readonly endAt: number;
    readonly createBody: unknown;
    readonly files: ReadonlyMap<string, Uint8Array>;
    readonly input: ReadonlyArray<ReadonlyArray<string>>;
  }> {
    return [...this.#sandboxes.values()].filter((sandbox) => !sandbox.killed);
  }

  /** E2B's own clock reaching a sandbox's end. */
  expire(sandboxID: string): void {
    this.#sandboxes.delete(sandboxID);
  }

  #api(
    method: string,
    target: URL,
    headers: Readonly<Record<string, string>>,
    body: Uint8Array,
  ): Response {
    if (headers["x-api-key"] !== RECORDED_E2B_API_KEY) return error(401, "Invalid API key");
    const path = target.pathname;
    if (method === "POST" && path === "/v2/sandboxes") return this.#create(headers, body);
    if (method === "GET" && path === "/v2/sandboxes") return this.#list(target.searchParams);
    const timeout = /^\/sandboxes\/([^/]+)\/timeout$/.exec(path);
    if (method === "POST" && timeout?.[1] !== undefined) return this.#setTimeout(timeout[1], body);
    const one = /^\/sandboxes\/([^/]+)$/.exec(path);
    const sandbox = one?.[1] === undefined ? undefined : this.#live(one[1]);
    if (one?.[1] !== undefined && sandbox === undefined) {
      return error(404, `sandbox "${one[1]}" not found`);
    }
    if (method === "GET" && sandbox !== undefined) return Response.json(this.#detail(sandbox));
    if (method === "DELETE" && sandbox !== undefined) {
      if (this.#scenario.outlivesKill !== true) sandbox.killed = true;
      return new Response(null, { status: 204 });
    }
    return error(404, "not found");
  }

  #live(sandboxID: string): RecordedSandbox | undefined {
    const sandbox = this.#sandboxes.get(sandboxID);
    if (sandbox === undefined || sandbox.killed || sandbox.endAt <= this.#now()) return undefined;
    return sandbox;
  }

  #create(headers: Readonly<Record<string, string>>, body: Uint8Array): Response {
    let request: unknown;
    try {
      request = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return error(400, "invalid request body");
    }
    if (!isRecord(request) || typeof request.templateID !== "string") {
      return error(400, "templateID is required");
    }
    const key = headers["idempotency-key"];
    if (key !== undefined && !/^[a-z0-9-]{1,255}$/.test(key)) {
      return error(400, "invalid Idempotency-Key");
    }
    const replay = key === undefined ? undefined : this.#idempotent.get(key);
    const existing = replay === undefined ? undefined : this.#sandboxes.get(replay);
    if (existing !== undefined) return Response.json(this.#created(existing), { status: 201 });
    const timeout = typeof request.timeout === "number" ? request.timeout : 300;
    const metadata = isRecord(request.metadata)
      ? Object.fromEntries(
          Object.entries(request.metadata).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
    this.#sequence += 1;
    const startedAt = this.#now();
    const sandbox: RecordedSandbox = {
      sandboxID: `i${String(this.#sequence).padStart(4, "0")}recorded${Math.random().toString(36).slice(2, 8)}`,
      templateID: request.templateID,
      metadata,
      startedAt,
      accessToken: `envd-token-${this.#sequence}`,
      createBody: request,
      endAt: this.#clamped(startedAt, startedAt + timeout * 1_000),
      files: new Map(),
      processes: new Set(),
      input: [],
      killed: false,
    };
    this.#sandboxes.set(sandbox.sandboxID, sandbox);
    if (key !== undefined) this.#idempotent.set(key, sandbox.sandboxID);
    return Response.json(this.#created(sandbox), { status: 201 });
  }

  #clamped(startedAt: number, endAt: number): number {
    const hold = this.#scenario.holdsTimeoutAt;
    return hold === undefined ? endAt : Math.min(endAt, startedAt + hold);
  }

  #created(sandbox: RecordedSandbox) {
    return {
      templateID: sandbox.templateID,
      sandboxID: sandbox.sandboxID,
      alias: sandbox.templateID,
      clientID: "6532622b",
      envdVersion: "0.2.4",
      envdAccessToken: sandbox.accessToken,
      trafficAccessToken: "traffic-token",
      domain: this.#scenario.domain === undefined ? null : this.#scenario.domain,
    };
  }

  #detail(sandbox: RecordedSandbox) {
    return {
      templateID: sandbox.templateID,
      alias: sandbox.templateID,
      sandboxID: sandbox.sandboxID,
      clientID: "6532622b",
      startedAt: new Date(sandbox.startedAt).toISOString(),
      endAt: new Date(sandbox.endAt).toISOString(),
      envdVersion: "0.2.4",
      envdAccessToken: sandbox.accessToken,
      domain: null,
      cpuCount: 2,
      memoryMB: 1024,
      diskSizeMB: 4096,
      metadata: sandbox.metadata,
      state: "running",
    };
  }

  #list(query: URLSearchParams): Response {
    const filters = new URLSearchParams(query.get("metadata") ?? "");
    const states = (query.get("state") ?? "running").split(",");
    if (!states.includes("running")) return Response.json([]);
    const pageSize = Math.min(this.#scenario.pageSize ?? 100, Number(query.get("limit") ?? "100"));
    const matching = [...this.#sandboxes.values()]
      .filter((sandbox) => this.#live(sandbox.sandboxID) !== undefined)
      .filter((sandbox) =>
        [...filters.entries()].every(([key, value]) => sandbox.metadata[key] === value),
      )
      .sort((left, right) => left.sandboxID.localeCompare(right.sandboxID));
    const start = Number(query.get("nextToken") ?? "0");
    const page = matching.slice(start, start + pageSize);
    const rest = start + pageSize < matching.length;
    return Response.json(
      page.map((sandbox) => {
        const { envdAccessToken: _token, domain: _domain, ...listed } = this.#detail(sandbox);
        return listed;
      }),
      rest ? { headers: { "X-Next-Token": String(start + pageSize) } } : {},
    );
  }

  #setTimeout(sandboxID: string, body: Uint8Array): Response {
    const sandbox = this.#live(sandboxID);
    if (sandbox === undefined) return error(404, `sandbox "${sandboxID}" not found`);
    let request: unknown;
    try {
      request = JSON.parse(new TextDecoder().decode(body));
    } catch {
      return error(400, "invalid request body");
    }
    if (!isRecord(request) || typeof request.timeout !== "number") {
      return error(400, "timeout is required");
    }
    sandbox.endAt = this.#clamped(sandbox.startedAt, this.#now() + request.timeout * 1_000);
    return new Response(null, { status: 204 });
  }

  #envd(
    method: string,
    target: URL,
    headers: Readonly<Record<string, string>>,
    body: Uint8Array,
  ): Response {
    if (headers["x-api-key"] !== undefined) {
      throw new Error("The person's API key reached a sandbox.");
    }
    const sandbox = this.#live(headers["e2b-sandbox-id"] ?? "");
    if (sandbox === undefined) return new Response("sandbox not found", { status: 502 });
    if (headers["e2b-sandbox-port"] !== "49983") return new Response("bad port", { status: 502 });
    if (headers["x-access-token"] !== sandbox.accessToken)
      return error(401, "invalid access token");
    if (headers.authorization !== `Basic ${btoa("user:")}`) return error(401, "invalid user");
    if (method === "POST" && target.pathname === "/process.Process/Start") {
      if (headers["content-type"] !== "application/connect+json") return error(415, "codec");
      return this.#start(sandbox, body);
    }
    const path = target.searchParams.get("path") ?? "";
    if (target.pathname === "/files" && method === "GET") {
      const file = sandbox.files.get(path);
      return file === undefined
        ? error(404, `path '${path}' does not exist`)
        : new Response(file.slice(), { headers: { "content-type": "application/octet-stream" } });
    }
    if (target.pathname === "/files" && method === "POST") {
      sandbox.files.set(path, body.slice());
      const name = path.slice(path.lastIndexOf("/") + 1);
      return Response.json([{ path, name, type: "file" }]);
    }
    return error(404, "not found");
  }

  #start(sandbox: RecordedSandbox, body: Uint8Array): Response {
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const length = body.byteLength >= 5 ? view.getUint32(1) : -1;
    if (body[0] !== 0 || length !== body.byteLength - 5) return error(400, "not one envelope");
    const request: unknown = JSON.parse(new TextDecoder().decode(body.subarray(5)));
    const process = isRecord(request) && isRecord(request.process) ? request.process : undefined;
    const cmd = typeof process?.cmd === "string" ? process.cmd : "";
    const args = Array.isArray(process?.args)
      ? process.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    const { exitCode, stdout } = this.#run(sandbox, cmd, args);
    this.#pid += 1;
    const events = [
      envelope({ event: { start: { pid: this.#pid } } }),
      ...(stdout === ""
        ? []
        : [envelope({ event: { data: { stdout: base64(new TextEncoder().encode(stdout)) } } })]),
      envelope({
        event: {
          end: {
            ...(exitCode === 0 ? {} : { exitCode }),
            exited: true,
            status: `exit status ${exitCode}`,
          },
        },
      }),
      envelope({}, 0x02),
    ];
    return new Response(concat(events), {
      headers: { "content-type": "application/connect+json" },
    });
  }

  /** The few programs the driver runs, by the name each script runs under. */
  #run(
    sandbox: RecordedSandbox,
    cmd: string,
    args: ReadonlyArray<string>,
  ): { readonly exitCode: number; readonly stdout: string } {
    if (cmd === "sh" && args[0] === "-c") {
      const [, , name, first = "", second = "", third = ""] = args;
      switch (name) {
        case "octant-display":
          sandbox.display = { width: Number(first), height: Number(second) };
          return { exitCode: 0, stdout: "" };
        case "octant-frame":
          if (sandbox.display === undefined) return { exitCode: 2, stdout: "" };
          sandbox.files.set(first, recordedPng(sandbox.display.width, sandbox.display.height));
          return { exitCode: 0, stdout: "" };
        case "octant-deliver": {
          const staged = sandbox.files.get(first);
          if (staged === undefined) return { exitCode: 1, stdout: "" };
          sandbox.files.delete(first);
          sandbox.files.set(`${second}/${third}`, staged);
          return { exitCode: 0, stdout: "" };
        }
        case "octant-launch": {
          if (!sandbox.files.has(`${first}/${second}`)) return { exitCode: 1, stdout: "" };
          this.#pid += 1;
          sandbox.processes.add(this.#pid);
          return { exitCode: 0, stdout: `${this.#pid}\n` };
        }
        default:
          return { exitCode: 127, stdout: "" };
      }
    }
    if (cmd === "xdotool") {
      if (sandbox.display === undefined) return { exitCode: 1, stdout: "" };
      sandbox.input.push([...args]);
      return { exitCode: 0, stdout: "" };
    }
    if (cmd === "kill" && args[0] === "-0") {
      return { exitCode: sandbox.processes.has(Number(args[1])) ? 0 : 1, stdout: "" };
    }
    return { exitCode: 127, stdout: "" };
  }
}
