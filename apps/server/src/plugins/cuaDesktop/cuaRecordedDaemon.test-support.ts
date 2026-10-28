/**
 * A recorded Cua daemon for the Cua desktop driver's tests: a real HTTP/1.1
 * server on a real Unix socket at `.cua/cua.sock` in a temporary home, mode
 * 0600 as `cua daemon` sets it, answering gRPC-Web as Cua's daemon documents
 * its `cua.daemon.v1` services and its env passthrough to `cua.env.v1`.
 *
 * Sources, read 2026-10-27 from github.com/trycua/cua at commit
 * 8fbdf83c1e05bf0a8b84a6199fe697cc58f0e24f: the `.proto` files under
 * `libs/cua/proto/cua/daemon/v1/` (`spaces.proto`, `daemon.proto`) and
 * `libs/cua/proto/cua/env/v1/` (`common.proto`, `computer.proto`,
 * `filesystem.proto`, `process.proto`, `system.proto`); the protocol
 * reference (`docs/content/docs/cua-sdk/reference/protocol/index.mdx` and
 * `daemon-spaces.mdx`); and the daemon's router
 * (`libs/cua/crates/cua-daemon/src/server.rs`), which serves gRPC-Web and the
 * `/v1/spaces/{key}/env/{*rest}` passthrough on the socket. Field numbers
 * here are written from those files independently of the driver's own, so a
 * wrong number in either fails a test.
 *
 * It also plays the person's other machines that provide Spaces
 * (`ListHosts`, a create `on` `host:<id>`), and the route its connection to
 * a Space on one of them takes now (`GetSpaceRoute`), which a test can move
 * to the relay's HTTPS path while a view is open.
 *
 * Inside a Space it plays a small Linux: it runs the two programs the driver
 * starts (by the name each script is started under), keeps files, and
 * records screen input, so tests can see what reached the desktop. It never
 * contacts anything; the tokens it hands out are test values.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProtobufWriter,
  readProtobuf,
  type DesktopDaemonPort,
  type ProtobufField,
} from "@octant/plugin-api/desktop-provider";
import { createDesktopDaemonPort } from "../../computerUse/desktopDaemonPort";
import { CUA_DESKTOP_DAEMON } from "./cuaDesktopProvider";

/** What the daemon hands out that the driver must never keep. */
export const RECORDED_LOOPBACK_TOKEN = "cua_recorded_loopback_token_not_a_credential";
export const RECORDED_SPACE_TOKEN = "cua_recorded_space_token_not_a_credential";

export interface RecordedCuaScenario {
  /** The daemon holds a Space's lifetime at most this long from when it is set. */
  readonly holdsLifetimeMs?: number;
  /** The daemon answers a delete but the Space keeps running. */
  readonly outlivesDelete?: boolean;
  /** The network a create reports, whatever was asked. */
  readonly network?: string;
  /** How a listing answers: whole, partly (`incomplete`), stale, or not at all. */
  readonly listing?: "complete" | "incomplete" | "stale" | "relay-unreachable";
  /** A create never answers until it is cancelled. */
  readonly createHangs?: boolean;
  /** Resolves a new Space answers as still booting before it runs. */
  readonly bootPolls?: number;
  /** The daemon places the Space in the person's cloud instead of here. */
  readonly placesInCloud?: string;
  /** The `cua.env.v1` major version the Space reports. */
  readonly protocolVersion?: number;
  readonly version?: string;
  readonly features?: ReadonlyArray<string>;
  /** The display a Space's screenshots show, before `max_dimension`. */
  readonly display?: { readonly width: number; readonly height: number };
  /** The person's other machines that provide Spaces, as `ListHosts` reports them. */
  readonly hosts?: ReadonlyArray<RecordedCuaHost>;
  /** The machine the daemon reports a Space on, whatever was asked. */
  readonly placesOnHost?: string;
  /** What carries the connection to a Space on another machine (`GetSpaceRoute`'s transport). */
  readonly route?: string;
  /**
   * The clouds the person linked to Cua (`aws`, `gcp`, `modal`): a create
   * there makes a Space that reports that cloud. Nothing is billed; this is
   * a recording.
   */
  readonly clouds?: ReadonlyArray<string>;
}

export interface RecordedCuaHost {
  readonly id: string;
  readonly name: string;
  /** `relay` or `direct` as Cua documents them, or any other value a daemon could answer. */
  readonly via: string;
  readonly online: boolean;
}

type Fields = ReadonlyArray<ProtobufField>;

interface RecordedSpace {
  readonly id: string;
  readonly name: string;
  readonly createId: string;
  /** The machine that provides it, as `Space.host` names it; empty on this machine. */
  readonly host: string;
  /** The person's cloud it runs in, as `Space.cloud` names it; empty off a cloud. */
  readonly cloud: string;
  readonly labels: ReadonlyMap<string, string>;
  readonly createRequest: Fields;
  expiresAt?: number;
  bootPolls: number;
  readonly files: Map<string, { readonly bytes: Uint8Array; readonly permissions: number }>;
  readonly processes: Set<number>;
  readonly input: Array<string>;
}

export interface RecordedCall {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;
  readonly request: Fields;
}

const decoder = new TextDecoder();

function fields(bytes: Uint8Array): Fields {
  const read = readProtobuf(bytes);
  if (read.status !== "read") throw new Error("The recorded Cua daemon got a malformed message.");
  return read.fields;
}

export function textOf(message: Fields, field: number): string {
  const found = message.filter((each) => each.field === field && each.wire === "bytes").at(-1);
  return found?.wire === "bytes" ? decoder.decode(found.value) : "";
}

export function textsOf(message: Fields, field: number): ReadonlyArray<string> {
  return message.flatMap((each) =>
    each.field === field && each.wire === "bytes" ? [decoder.decode(each.value)] : [],
  );
}

export function numberOf(message: Fields, field: number): number | undefined {
  const found = message.filter((each) => each.field === field && each.wire === "varint").at(-1);
  return found?.wire === "varint" ? Number(found.value) : undefined;
}

export function messageOf(message: Fields, field: number): Fields | undefined {
  const found = message.filter((each) => each.field === field && each.wire === "bytes").at(-1);
  return found?.wire === "bytes" ? fields(found.value) : undefined;
}

function doubleOf(message: Fields, field: number): number | undefined {
  const found = message.find((each) => each.field === field && each.wire === "fixed64");
  return found?.wire === "fixed64"
    ? new DataView(found.value.buffer, found.value.byteOffset, 8).getFloat64(0, true)
    : undefined;
}

export function mapOf(message: Fields, field: number): ReadonlyMap<string, string> {
  return new Map(
    message.flatMap((each) =>
      each.field === field && each.wire === "bytes"
        ? [[textOf(fields(each.value), 1), textOf(fields(each.value), 2)] as const]
        : [],
    ),
  );
}

/** A PNG signature and IHDR naming `width` by `height`; nothing reads further. */
function recordedPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13], 0);
  bytes.set(new TextEncoder().encode("IHDR"), 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function frame(flag: number, payload: Uint8Array): Uint8Array {
  const framed = new Uint8Array(5 + payload.byteLength);
  framed[0] = flag;
  new DataView(framed.buffer).setUint32(1, payload.byteLength);
  framed.set(payload, 5);
  return framed;
}

function answer(response: ServerResponse, messages: ReadonlyArray<Uint8Array>, status = 0): void {
  response.writeHead(200, { "content-type": "application/grpc-web+proto" });
  response.end(
    Buffer.concat([
      ...messages.map((message) => frame(0, message)),
      frame(0x80, new TextEncoder().encode(`grpc-status: ${status}\r\n`)),
    ]),
  );
}

const fail = (response: ServerResponse, status: number) => answer(response, [], status);

function timestamp(milliseconds: number): Uint8Array {
  return new ProtobufWriter().varint(1, Math.floor(milliseconds / 1_000)).finish();
}

export class RecordedCuaDaemon {
  readonly home: string;
  readonly #scenario: RecordedCuaScenario;
  readonly #now: () => number;
  readonly #server: Server;
  readonly #spaces = new Map<string, RecordedSpace>();
  /** Creates the daemon is still running, by create id, with the answer they owe. */
  readonly #creating = new Map<string, { readonly name: string; readonly respond: () => void }>();
  readonly #envKeys = new Map<string, string>();
  readonly #uploads = new Map<
    string,
    {
      readonly path: string;
      readonly permissions: number;
      readonly parts: Array<Uint8Array>;
      received: number;
    }
  >();
  readonly #calls: Array<RecordedCall> = [];
  #transport: string;
  #sequence = 0;
  #pid = 700;

  private constructor(home: string, scenario: RecordedCuaScenario, now: () => number) {
    this.home = home;
    this.#scenario = scenario;
    this.#transport = scenario.route ?? "mesh";
    this.#now = now;
    this.#server = createServer((request, response) => {
      const chunks: Array<Buffer> = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        const length = body.byteLength >= 5 ? body.readUInt32BE(1) : 0;
        const message = fields(new Uint8Array(body.subarray(5, 5 + length)));
        const method = request.url ?? "";
        this.#calls.push({ method, headers: request.headers, request: message });
        this.#route(method, message, response);
      });
    });
  }

  /** A daemon listening in a fresh temporary home. */
  static async start(
    scenario: RecordedCuaScenario = {},
    now: () => number = () => Date.now(),
  ): Promise<RecordedCuaDaemon> {
    const home = mkdtempSync(join(tmpdir(), "octant-cua-home-"));
    mkdirSync(join(home, ".cua"), { mode: 0o700 });
    const daemon = new RecordedCuaDaemon(home, scenario, now);
    const socketPath = join(home, CUA_DESKTOP_DAEMON.socketPath);
    await new Promise<void>((resolve) => daemon.#server.listen(socketPath, () => resolve()));
    chmodSync(socketPath, 0o600);
    return daemon;
  }

  /** The host's real daemon port over this daemon's socket, as the wiring builds it. */
  port(): DesktopDaemonPort {
    return createDesktopDaemonPort({
      daemon: () => CUA_DESKTOP_DAEMON,
      homeDirectory: this.home,
      userId: process.getuid?.() ?? 0,
    });
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    rmSync(this.home, { recursive: true, force: true });
  }

  calls(): ReadonlyArray<RecordedCall> {
    return [...this.#calls];
  }

  /** Spaces the daemon still runs, as its own listing would show them. */
  spaces(): ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly createId: string;
    readonly host: string;
    readonly labels: ReadonlyMap<string, string>;
    readonly createRequest: Fields;
    readonly expiresAt: number | undefined;
    readonly files: ReadonlyMap<
      string,
      { readonly bytes: Uint8Array; readonly permissions: number }
    >;
    readonly input: ReadonlyArray<string>;
  }> {
    return [...this.#spaces.values()].map((space) => ({ ...space, expiresAt: space.expiresAt }));
  }

  /** Creates the daemon is still running. */
  creating(): ReadonlyArray<string> {
    return [...this.#creating.keys()];
  }

  /** Moves the connection to Spaces on other machines to another transport, as Cua's fallback does. */
  routeOver(transport: string): void {
    this.#transport = transport;
  }

  #route(method: string, request: Fields, response: ServerResponse): void {
    const env = /^\/v1\/spaces\/([^/]+)\/env\/cua\.env\.v1\.([A-Za-z]+)\/([A-Za-z]+)$/.exec(method);
    if (env !== null) {
      const space = this.#spaces.get(this.#envKeys.get(env[1] ?? "") ?? "");
      if (space === undefined) return fail(response, 5);
      return this.#env(space, `${env[2]}/${env[3]}`, request, response);
    }
    switch (method) {
      case "/cua.daemon.v1.DaemonService/GetInfo":
        return answer(response, [
          (() => {
            const info = new ProtobufWriter()
              .string(1, this.#scenario.version ?? "0.9.0")
              .varint(2, 4242)
              .string(4, "http://127.0.0.1:41234")
              .string(5, RECORDED_LOOPBACK_TOKEN);
            for (const feature of this.#scenario.features ?? [
              "env",
              "sandboxes",
              "spaces",
              "mcp",
            ]) {
              info.string(6, feature);
            }
            return info.finish();
          })(),
        ]);
      case "/cua.daemon.v1.SpaceService/CreateSpace":
        return this.#create(request, response);
      case "/cua.daemon.v1.SpaceService/CancelCreateSpace": {
        const createId = textOf(request, 1);
        const pending = this.#creating.get(createId);
        if (pending !== undefined) {
          this.#creating.delete(createId);
          pending.respond();
        }
        const made = [...this.#spaces.values()].some((space) => space.createId === createId);
        return answer(response, [
          new ProtobufWriter()
            .string(1, createId)
            .string(
              2,
              pending !== undefined ? "cancelled" : made ? "already_created" : "not_creating",
            )
            .finish(),
        ]);
      }
      case "/cua.daemon.v1.SpaceService/SetSpaceLifetime": {
        const space = this.#spaces.get(textOf(request, 1));
        if (space === undefined) return fail(response, 5);
        const requested = messageOf(request, 2);
        const asked = (numberOf(requested ?? [], 1) ?? 0) * 1_000;
        const held = Math.min(asked, this.#scenario.holdsLifetimeMs ?? asked);
        space.expiresAt = this.#now() + held;
        return answer(response, [
          new ProtobufWriter().bytes(1, timestamp(space.expiresAt)).finish(),
        ]);
      }
      case "/cua.daemon.v1.SpaceService/DeleteSpace": {
        const id = textOf(request, 1);
        if (!this.#spaces.has(id)) return fail(response, 5);
        if (this.#scenario.outlivesDelete !== true) this.#spaces.delete(id);
        return answer(response, [new ProtobufWriter().string(1, "deleted").finish()]);
      }
      case "/cua.daemon.v1.SpaceService/ResolveSpace": {
        const space = this.#spaces.get(textOf(request, 1));
        if (space === undefined) return fail(response, 5);
        // A new Space answers as booting this many times before it runs.
        const message = this.#spaceMessage(space);
        if (space.bootPolls > 0) space.bootPolls -= 1;
        return answer(response, [new ProtobufWriter().bytes(1, message).finish()]);
      }
      case "/cua.daemon.v1.SpaceService/ConnectSpace": {
        const space = this.#spaces.get(textOf(request, 1));
        if (space === undefined) return fail(response, 5);
        const key = `env-${(this.#sequence += 1)}-${space.id}`;
        this.#envKeys.set(key, space.id);
        return answer(response, [
          new ProtobufWriter()
            .bytes(1, this.#spaceMessage(space))
            .string(2, `http://127.0.0.1:41234/v1/spaces/${key}/env`)
            .string(3, RECORDED_SPACE_TOKEN)
            .string(6, "local")
            .finish(),
        ]);
      }
      case "/cua.daemon.v1.SpaceService/ListSpaces":
        return this.#list(response);
      case "/cua.daemon.v1.SpaceService/ListHosts": {
        const writer = new ProtobufWriter();
        for (const host of this.#scenario.hosts ?? []) {
          writer.bytes(
            1,
            new ProtobufWriter()
              .string(1, host.id)
              .string(2, host.name)
              .string(3, host.via)
              .bool(4, host.online)
              .finish(),
          );
        }
        return answer(response, [writer.finish()]);
      }
      case "/cua.daemon.v1.SpaceService/GetSpaceRoute": {
        const space = this.#spaces.get(textOf(request, 1));
        if (space === undefined) return fail(response, 5);
        // A Space on this machine is always `local`; one on another machine
        // or in a cloud takes the route the test set.
        const transport = space.host === "" && space.cloud === "" ? "local" : this.#transport;
        const route =
          transport === "local"
            ? "local 127.0.0.1:3211"
            : transport === "relay_https"
              ? "relay https://relay.example.invalid"
              : transport === "mesh"
                ? "mesh relayed"
                : transport;
        return answer(response, [
          new ProtobufWriter()
            .string(1, route)
            .bool(2, transport === "local" || transport === "direct")
            .string(3, transport)
            .string(4, transport === "relay_https" ? "the mesh did not answer" : "")
            .finish(),
        ]);
      }
      default:
        return fail(response, 12);
    }
  }

  #create(request: Fields, response: ServerResponse): void {
    const createId = textOf(request, 17);
    const name = textOf(request, 5);
    // `local`, or `host:<id>` for one of the person's machines that answers;
    // a Space a relay host provides is named by that host's relay machine id.
    const location = textOf(request, 2);
    const asked = location.startsWith("host:")
      ? (this.#scenario.hosts ?? []).find((host) => host.online && `host:${host.id}` === location)
      : undefined;
    const inCloud = (this.#scenario.clouds ?? []).includes(location);
    if (location !== "local" && asked === undefined && !inCloud) return fail(response, 5);
    const host =
      this.#scenario.placesOnHost ??
      (asked === undefined ? "" : asked.via === "relay" ? asked.id : "direct:10.0.0.9:3211");
    const respond = () => {
      const existing = [...this.#spaces.values()].find((space) => space.createId === createId);
      const space: RecordedSpace = existing ?? {
        id: `space-${(this.#sequence += 1)}`,
        name,
        createId,
        host,
        cloud: inCloud ? location : "",
        labels: mapOf(request, 21),
        createRequest: request,
        bootPolls: this.#scenario.bootPolls ?? 1,
        files: new Map(),
        processes: new Set(),
        input: [],
      };
      this.#spaces.set(space.id, space);
      const network =
        this.#scenario.network ??
        (textOf(request, 20) === "none" && textOf(request, 3) === "vm" ? "none" : "");
      answer(response, [
        new ProtobufWriter()
          .bytes(1, new ProtobufWriter().string(1, space.id).finish())
          .string(2, "starting")
          .string(4, network)
          .finish(),
      ]);
    };
    if (this.#scenario.createHangs === true) {
      // The create runs until it is cancelled; a cancelled one makes nothing.
      this.#creating.set(createId, {
        name,
        respond: () => {
          if (!response.writableEnded) fail(response, 1);
        },
      });
      return;
    }
    respond();
  }

  #spaceMessage(space: RecordedSpace): Uint8Array {
    const booted = space.bootPolls === 0;
    const writer = new ProtobufWriter()
      .string(1, space.id)
      .string(2, space.name)
      .string(3, booted ? "0.9.0" : "")
      .string(12, "vm")
      .string(14, space.host)
      .string(17, booted ? "running" : "")
      .string(18, this.#scenario.placesInCloud ?? space.cloud)
      .string(20, (this.#scenario.placesInCloud ?? space.cloud) === "" ? "" : "here");
    for (const [key, value] of space.labels) {
      writer.bytes(22, new ProtobufWriter().string(1, key).string(2, value).finish());
    }
    if (space.expiresAt !== undefined) writer.varint(23, Math.floor(space.expiresAt / 1_000));
    return writer.finish();
  }

  #list(response: ServerResponse): void {
    const listing = this.#scenario.listing ?? "complete";
    // Without `known_now` the daemon waits for the relay and fails when it
    // cannot be read.
    if (listing === "relay-unreachable") return fail(response, 14);
    const writer = new ProtobufWriter();
    for (const space of this.#spaces.values()) {
      if (space.expiresAt !== undefined && space.expiresAt <= this.#now()) continue;
      writer.bytes(1, this.#spaceMessage(space));
    }
    if (listing === "incomplete") writer.bool(2, true);
    if (listing === "stale") writer.bool(4, true);
    for (const pending of this.#creating.values()) {
      writer.bytes(6, new ProtobufWriter().string(3, pending.name).string(5, "booting").finish());
    }
    answer(response, [writer.finish()]);
  }

  #env(space: RecordedSpace, call: string, request: Fields, response: ServerResponse): void {
    switch (call) {
      case "SystemService/GetCapabilities":
        return answer(response, [
          new ProtobufWriter()
            .string(1, "0.9.0")
            .varint(2, this.#scenario.protocolVersion ?? 1)
            .varint(3, 13)
            .finish(),
        ]);
      case "ComputerService/Screenshot": {
        const display = this.#scenario.display ?? { width: 1024, height: 768 };
        const longest = numberOf(request, 6) ?? 0;
        const scale =
          longest > 0 ? Math.min(1, longest / Math.max(display.width, display.height)) : 1;
        const width = Math.round(display.width * scale);
        const height = Math.round(display.height * scale);
        space.input.push(`screenshot format=${numberOf(request, 4) ?? 0}`);
        return answer(response, [
          new ProtobufWriter()
            .bytes(1, recordedPng(width, height))
            .varint(2, 1)
            .bytes(3, new ProtobufWriter().varint(1, width).varint(2, height).finish())
            .string(7, `shot-${(this.#sequence += 1)}`)
            .finish(),
        ]);
      }
      case "ComputerService/Pointer": {
        const target = messageOf(request, 1) ?? [];
        const on = `space=${numberOf(target, 4) ?? 0} shot=${textOf(target, 5)}`;
        for (const [field, action] of [
          [3, "move"],
          [4, "down"],
          [5, "up"],
          [7, "scroll"],
        ] as const) {
          const acted = messageOf(request, field);
          if (acted === undefined) continue;
          const at = messageOf(acted, 1) ?? [];
          const where = `${doubleOf(at, 1) ?? "?"},${doubleOf(at, 2) ?? "?"}`;
          const button = field === 4 || field === 5 ? ` button=${numberOf(acted, 2) ?? 0}` : "";
          const delta =
            field === 7
              ? ` delta=${doubleOf(acted, 2) ?? 0},${doubleOf(acted, 3) ?? 0} unit=${numberOf(acted, 4) ?? 0}`
              : "";
          space.input.push(`pointer ${action} ${where}${button}${delta} ${on}`);
        }
        return answer(response, [new Uint8Array(0)]);
      }
      case "ComputerService/Keyboard": {
        const typed = messageOf(request, 2);
        if (typed !== undefined) space.input.push(`type ${textOf(typed, 1)}`);
        for (const [field, action] of [
          [5, "down"],
          [6, "up"],
        ] as const) {
          const acted = messageOf(request, field);
          if (acted === undefined) continue;
          const key = messageOf(acted, 1) ?? [];
          const named = numberOf(key, 1);
          space.input.push(
            `key ${action} ${named === undefined ? `char=${textOf(key, 2)}` : `named=${named}`}`,
          );
        }
        return answer(response, [new Uint8Array(0)]);
      }
      case "FilesystemService/BeginUpload": {
        const header = messageOf(request, 1) ?? [];
        const uploadId = textOf(request, 2);
        this.#uploads.set(uploadId, {
          path: textOf(header, 1),
          permissions: numberOf(header, 3) ?? 0,
          parts: [],
          received: 0,
        });
        return answer(response, [
          new ProtobufWriter().string(1, uploadId).varint(2, 0).varint(3, 4).finish(),
        ]);
      }
      case "FilesystemService/UploadChunk": {
        const upload = this.#uploads.get(textOf(request, 1));
        if (upload === undefined || (numberOf(request, 2) ?? 0) !== upload.received) {
          return fail(response, 9);
        }
        const data = request.find((each) => each.field === 3 && each.wire === "bytes");
        const bytes = data?.wire === "bytes" ? data.value : new Uint8Array(0);
        upload.parts.push(bytes);
        upload.received += bytes.byteLength;
        return answer(response, [new ProtobufWriter().varint(1, upload.received).finish()]);
      }
      case "FilesystemService/CommitUpload": {
        const upload = this.#uploads.get(textOf(request, 1));
        if (upload === undefined) return fail(response, 5);
        const bytes = new Uint8Array(Buffer.concat(upload.parts));
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        if (textOf(request, 2) !== sha256) return fail(response, 9);
        space.files.set(upload.path, { bytes, permissions: upload.permissions });
        return answer(response, [new ProtobufWriter().string(2, sha256).finish()]);
      }
      case "FilesystemService/Move": {
        const moving = space.files.get(textOf(request, 1));
        if (moving === undefined) return fail(response, 5);
        space.files.delete(textOf(request, 1));
        space.files.set(textOf(request, 2), moving);
        return answer(response, [new Uint8Array(0)]);
      }
      case "ProcessService/StartProcess":
        return this.#process(space, request, response);
      default:
        return fail(response, 12);
    }
  }

  /** The two programs the driver runs, streamed as start, output, and end events. */
  #process(space: RecordedSpace, request: Fields, response: ServerResponse): void {
    const config = messageOf(request, 1) ?? [];
    const command = textOf(config, 1);
    const args = textsOf(config, 2);
    let exitCode = 1;
    let stdout = "";
    if (command === "sh" && args[0] === "-c" && args[2] === "octant-launch") {
      if (space.files.has(`${args[3] ?? ""}/${args[4] ?? ""}`)) {
        const pid = (this.#pid += 1);
        space.processes.add(pid);
        exitCode = 0;
        stdout = `${pid}\n`;
      }
    } else if (command === "kill" && args[0] === "-0") {
      exitCode = space.processes.has(Number(args[1])) ? 0 : 1;
    }
    const event = (branch: number, inner: Uint8Array) =>
      new ProtobufWriter().bytes(1, new ProtobufWriter().bytes(branch, inner).finish()).finish();
    const runner = (this.#pid += 1);
    answer(response, [
      event(1, new ProtobufWriter().varint(1, runner).finish()),
      ...(stdout === ""
        ? []
        : [event(2, new ProtobufWriter().varint(1, 0).string(2, stdout).finish())]),
      event(3, new ProtobufWriter().varint(1, exitCode).finish()),
    ]);
  }
}
