/**
 * The few Cua messages the Cua desktop driver speaks, written by hand from
 * Cua's published `.proto` files with the seam's protobuf wire helper.
 * Octant vendors no `.proto` file and generates no code from one.
 *
 * Sources, read 2026-10-27 from github.com/trycua/cua at commit
 * 8fbdf83c1e05bf0a8b84a6199fe697cc58f0e24f:
 * - `libs/cua/proto/cua/daemon/v1/spaces.proto`: `Space`, `CreatingSpace`,
 *   `SpacesHost`, and the `SpaceService` requests and responses below.
 * - `libs/cua/proto/cua/daemon/v1/daemon.proto`: `GetInfoResponse`.
 * - `libs/cua/proto/cua/env/v1/common.proto`: `Point`, `PixelSize`,
 *   `CoordinateSpace`.
 * - `libs/cua/proto/cua/env/v1/computer.proto`: `Screenshot`, `Pointer`,
 *   `Keyboard`, `ImageFormat`, `MouseButton`, `ScrollUnit`, `Key`.
 * - `libs/cua/proto/cua/env/v1/filesystem.proto`: `WriteFileHeader`, the
 *   unary upload, and `Move`.
 * - `libs/cua/proto/cua/env/v1/process.proto`: `StartProcess` and its event
 *   stream.
 * - `libs/cua/proto/cua/env/v1/system.proto`: `GetCapabilitiesResponse`.
 *
 * Only the fields the driver needs are read. A field the driver must never
 * hold is never read: `GetInfoResponse.loopback_token` (5) and
 * `ConnectSpaceResponse.token` (3) are skipped unparsed.
 */
import {
  ProtobufWriter,
  readProtobuf,
  type ProtobufField,
} from "@octant/plugin-api/desktop-provider";

type Fields = ReadonlyArray<ProtobufField>;

/** The longest text the driver keeps from any one Cua field. */
const MAX_TEXT = 1_024;
const decoder = new TextDecoder();

function parse(bytes: Uint8Array): Fields | undefined {
  const read = readProtobuf(bytes);
  return read.status === "read" ? read.fields : undefined;
}

function lastBytes(fields: Fields, field: number): Uint8Array | undefined {
  let found: Uint8Array | undefined;
  for (const each of fields) if (each.field === field && each.wire === "bytes") found = each.value;
  return found;
}

function text(fields: Fields, field: number): string {
  const bytes = lastBytes(fields, field);
  return bytes === undefined ? "" : decoder.decode(bytes).slice(0, MAX_TEXT);
}

function texts(fields: Fields, field: number): ReadonlyArray<string> {
  return fields
    .flatMap((each) => (each.field === field && each.wire === "bytes" ? [each.value] : []))
    .slice(0, 256)
    .map((value) => decoder.decode(value).slice(0, MAX_TEXT));
}

function varint(fields: Fields, field: number): bigint {
  let found = 0n;
  for (const each of fields) if (each.field === field && each.wire === "varint") found = each.value;
  return found;
}

function bool(fields: Fields, field: number): boolean {
  return varint(fields, field) !== 0n;
}

function nested(fields: Fields, field: number): Fields | undefined {
  const bytes = lastBytes(fields, field);
  return bytes === undefined ? undefined : parse(bytes);
}

/** Every repeated message in `field`, or undefined when any one is malformed. */
function nestedAll(fields: Fields, field: number): ReadonlyArray<Fields> | undefined {
  const all: Array<Fields> = [];
  for (const each of fields) {
    if (each.field !== field || each.wire !== "bytes") continue;
    const inner = parse(each.value);
    if (inner === undefined) return undefined;
    all.push(inner);
  }
  return all;
}

/** A `map<string, string>`: repeated entries with the key in 1 and the value in 2. */
function stringMap(fields: Fields, field: number): ReadonlyMap<string, string> | undefined {
  const entries = nestedAll(fields, field);
  if (entries === undefined) return undefined;
  return new Map(entries.slice(0, 64).map((entry) => [text(entry, 1), text(entry, 2)]));
}

function writeStringMap(
  writer: ProtobufWriter,
  field: number,
  map: Readonly<Record<string, string>>,
): void {
  for (const [key, value] of Object.entries(map)) {
    writer.bytes(field, new ProtobufWriter().string(1, key).string(2, value).finish());
  }
}

/** `google.protobuf.Duration`: seconds (1) and nanos (2). */
function duration(milliseconds: number): Uint8Array {
  const whole = Math.max(0, Math.floor(milliseconds));
  const writer = new ProtobufWriter().varint(1, Math.floor(whole / 1_000));
  const nanos = (whole % 1_000) * 1_000_000;
  return nanos === 0 ? writer.finish() : writer.varint(2, nanos).finish();
}

/** `google.protobuf.Timestamp` as milliseconds since the epoch, or undefined. */
function timestamp(fields: Fields | undefined): number | undefined {
  if (fields === undefined) return undefined;
  const seconds = BigInt.asIntN(64, varint(fields, 1));
  const nanos = Number(BigInt.asIntN(32, varint(fields, 2)));
  const milliseconds = Number(seconds) * 1_000 + Math.floor(nanos / 1_000_000);
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
}

function double(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, value, true);
  return bytes;
}

const single = (field: number, value: string): Uint8Array =>
  new ProtobufWriter().string(field, value).finish();

// ── cua.daemon.v1 ──────────────────────────────────────────────────────────

/** `cua.daemon.v1.Space`, the fields the driver checks. */
export interface CuaSpace {
  readonly id: string;
  readonly name: string;
  readonly spacesdVersion: string;
  readonly kind: string;
  readonly powerState: string;
  /** Empty for a Space that is not in a cloud. */
  readonly cloud: string;
  /** The machine of the person's that provides the Space; empty for one on this machine. */
  readonly host: string;
  readonly labels: ReadonlyMap<string, string>;
}

function space(fields: Fields | undefined): CuaSpace | undefined {
  if (fields === undefined) return undefined;
  const labels = stringMap(fields, 22);
  if (labels === undefined) return undefined;
  return {
    id: text(fields, 1),
    name: text(fields, 2),
    spacesdVersion: text(fields, 3),
    kind: text(fields, 12),
    powerState: text(fields, 17),
    cloud: text(fields, 18),
    host: text(fields, 14),
    labels,
  };
}

export const cuaGetInfoRequest = (): Uint8Array => new Uint8Array(0);

/** `GetInfoResponse`: version (1) and features (6). The loopback token (5) is never read. */
export function readCuaGetInfo(
  bytes: Uint8Array,
): { readonly version: string; readonly features: ReadonlyArray<string> } | undefined {
  const fields = parse(bytes);
  return fields === undefined
    ? undefined
    : { version: text(fields, 1), features: texts(fields, 6) };
}

export interface CuaCreateSpace {
  readonly image: string;
  /** `local`, or `host:<id>` for one of the person's other machines. */
  readonly location: string;
  readonly name: string;
  readonly createId: string;
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * `CreateSpaceRequest` for a QEMU VM with no network: image (1), location
 * (2), kind (3) `vm`, runtime (4) `qemu`, name (5), wait (9) false,
 * create_id (17), network (20) `none`, and labels (21). Nothing else is set,
 * so no volume, environment, service, egress, durability, or reuse.
 */
export function cuaCreateSpaceRequest(create: CuaCreateSpace): Uint8Array {
  const writer = new ProtobufWriter()
    .string(1, create.image)
    .string(2, create.location)
    .string(3, "vm")
    .string(4, "qemu")
    .string(5, create.name)
    // `wait` is a proto3 `optional`, so false is written to be present.
    .bool(9, false)
    .string(17, create.createId)
    .string(20, "none");
  writeStringMap(writer, 21, create.labels);
  return writer.finish();
}

/** `CreateSpaceResponse`: space (1), phase (2), network (4). */
export function readCuaCreateSpace(
  bytes: Uint8Array,
): { readonly space: CuaSpace; readonly phase: string; readonly network: string } | undefined {
  const fields = parse(bytes);
  if (fields === undefined) return undefined;
  const created = space(nested(fields, 1));
  return created === undefined
    ? undefined
    : { space: created, phase: text(fields, 2), network: text(fields, 4) };
}

/** `CancelCreateSpaceRequest`: space (1), here the create id. */
export const cuaCancelCreateRequest = (createId: string): Uint8Array => single(1, createId);

/** `SetSpaceLifetimeRequest`: space (1), duration (2) from now, on_expire (3) `delete`. */
export function cuaSetLifetimeRequest(spaceId: string, fromNowMs: number): Uint8Array {
  return new ProtobufWriter()
    .string(1, spaceId)
    .bytes(2, duration(fromNowMs))
    .string(3, "delete")
    .finish();
}

/** `SetSpaceLifetimeResponse`: expires_at (1), in milliseconds since the epoch. */
export function readCuaLifetime(bytes: Uint8Array): number | undefined {
  const fields = parse(bytes);
  return fields === undefined ? undefined : timestamp(nested(fields, 1));
}

/**
 * `DeleteSpaceRequest`, `ResolveSpaceRequest`, `ConnectSpaceRequest`, and
 * `GetSpaceRouteRequest`: space (1).
 */
export const cuaSpaceRequest = (spaceId: string): Uint8Array => single(1, spaceId);

/** `ResolveSpaceResponse`: space (1). */
export function readCuaResolve(bytes: Uint8Array): CuaSpace | undefined {
  const fields = parse(bytes);
  return fields === undefined ? undefined : space(nested(fields, 1));
}

/**
 * `ListSpacesRequest` without `known_now` (1): the daemon waits for every
 * machine of the account and fails rather than answer partly.
 */
export const cuaListSpacesRequest = (): Uint8Array => new Uint8Array(0);

/**
 * `ListSpacesResponse`: spaces (1), incomplete (2), stale (4), and the names
 * (3) of Spaces still being created (6), which carry no labels yet.
 */
export function readCuaListSpaces(bytes: Uint8Array):
  | {
      readonly spaces: ReadonlyArray<CuaSpace>;
      readonly complete: boolean;
      readonly creating: ReadonlyArray<string>;
    }
  | undefined {
  const fields = parse(bytes);
  if (fields === undefined) return undefined;
  const listed = nestedAll(fields, 1);
  const creating = nestedAll(fields, 6);
  if (listed === undefined || creating === undefined) return undefined;
  const spaces: Array<CuaSpace> = [];
  for (const each of listed) {
    const read = space(each);
    if (read === undefined) return undefined;
    spaces.push(read);
  }
  return {
    spaces,
    complete: !bool(fields, 2) && !bool(fields, 4),
    creating: creating.map((each) => text(each, 3)),
  };
}

export const cuaListHostsRequest = (): Uint8Array => new Uint8Array(0);

/** `SpacesHost`, the fields the driver checks. */
export interface CuaHost {
  readonly id: string;
  readonly name: string;
  /** `relay` or `direct`. */
  readonly via: string;
  readonly online: boolean;
}

/**
 * `ListHostsResponse`: hosts (1), each with id (1), name (2), via (3), and
 * online (4). Every host is kept, as the response's byte bound allows: a
 * listing cut short could hide a second machine that answers, and the driver
 * would then choose one for a person who confirmed only "your other machine".
 */
export function readCuaListHosts(bytes: Uint8Array): ReadonlyArray<CuaHost> | undefined {
  const fields = parse(bytes);
  const hosts = fields === undefined ? undefined : nestedAll(fields, 1);
  return hosts?.map((host) => ({
    id: text(host, 1),
    name: text(host, 2),
    via: text(host, 3),
    online: bool(host, 4),
  }));
}

/** `GetSpaceRouteResponse`: transport (3), what carries the daemon's connection to the Space now. */
export function readCuaRouteTransport(bytes: Uint8Array): string | undefined {
  const fields = parse(bytes);
  return fields === undefined ? undefined : text(fields, 3);
}

/** `ConnectSpaceResponse`: env_url (2) only. The Space's token (3) is never read. */
export function readCuaConnect(bytes: Uint8Array): string | undefined {
  const fields = parse(bytes);
  return fields === undefined ? undefined : text(fields, 2);
}

// ── cua.env.v1, through the daemon's env passthrough ───────────────────────

export const cuaGetCapabilitiesRequest = (): Uint8Array => new Uint8Array(0);

/** `GetCapabilitiesResponse`: protocol_version (2). */
export function readCuaProtocolVersion(bytes: Uint8Array): number | undefined {
  const fields = parse(bytes);
  return fields === undefined ? undefined : Number(varint(fields, 2));
}

/** `ScreenshotRequest`: format (4) PNG (1), max_dimension (6). */
export function cuaScreenshotRequest(maxDimension: number): Uint8Array {
  return new ProtobufWriter().varint(4, 1).varint(6, maxDimension).finish();
}

/** `ScreenshotResponse`: image (1), format (2), screenshot_id (7). */
export function readCuaScreenshot(
  bytes: Uint8Array,
):
  | { readonly image: Uint8Array; readonly format: number; readonly screenshotId: string }
  | undefined {
  const fields = parse(bytes);
  if (fields === undefined) return undefined;
  const image = lastBytes(fields, 1);
  if (image === undefined) return undefined;
  return { image, format: Number(varint(fields, 2)), screenshotId: text(fields, 7) };
}

/**
 * `InputTarget` (1) naming pixels of one screenshot: space (4)
 * `COORDINATE_SPACE_SCREENSHOT` (3) and screenshot_id (5), so a person's or
 * agent's point lands where it was on the frame they saw.
 */
function screenshotTarget(screenshotId: string): Uint8Array {
  return new ProtobufWriter().varint(4, 3).string(5, screenshotId).finish();
}

function point(x: number, y: number): Uint8Array {
  return new ProtobufWriter().fixed64(1, double(x)).fixed64(2, double(y)).finish();
}

/** `MouseButton`: LEFT 1, RIGHT 2, MIDDLE 3. */
const MOUSE_BUTTONS = { left: 1, right: 2, middle: 3 } as const;

export type CuaPointer =
  | { readonly action: "move"; readonly x: number; readonly y: number }
  | {
      readonly action: "down" | "up";
      readonly x: number;
      readonly y: number;
      readonly button: keyof typeof MOUSE_BUTTONS;
    }
  | {
      readonly action: "scroll";
      readonly x: number;
      readonly y: number;
      readonly deltaX: number;
      readonly deltaY: number;
    };

/**
 * `PointerRequest`: target (1), and one of move (3, `PointerMove`), down (4,
 * `PointerDown`), up (5, `PointerUp`), or scroll (7, `PointerScroll` with
 * unit `PIXEL` (2)).
 */
export function cuaPointerRequest(screenshotId: string, pointer: CuaPointer): Uint8Array {
  const writer = new ProtobufWriter().bytes(1, screenshotTarget(screenshotId));
  const at = point(pointer.x, pointer.y);
  switch (pointer.action) {
    case "move":
      return writer.bytes(3, new ProtobufWriter().bytes(1, at).finish()).finish();
    case "down":
    case "up":
      return writer
        .bytes(
          pointer.action === "down" ? 4 : 5,
          new ProtobufWriter().bytes(1, at).varint(2, MOUSE_BUTTONS[pointer.button]).finish(),
        )
        .finish();
    case "scroll":
      return writer
        .bytes(
          7,
          new ProtobufWriter()
            .bytes(1, at)
            .fixed64(2, double(pointer.deltaX))
            .fixed64(3, double(pointer.deltaY))
            .varint(4, 2)
            .finish(),
        )
        .finish();
  }
}

/** `KeyInput`: named (1, a `Key`) or one character (2). */
export type CuaKey = { readonly named: number } | { readonly character: string };

function keyInput(key: CuaKey): Uint8Array {
  return "named" in key
    ? new ProtobufWriter().varint(1, key.named).finish()
    : new ProtobufWriter().string(2, key.character).finish();
}

/** `KeyboardRequest`: down (5, `KeyboardDown`) or up (6, `KeyboardUp`) with its key (1). */
export function cuaKeyRequest(action: "down" | "up", key: CuaKey): Uint8Array {
  return new ProtobufWriter()
    .bytes(action === "down" ? 5 : 6, new ProtobufWriter().bytes(1, keyInput(key)).finish())
    .finish();
}

/** `KeyboardRequest`: type (2, `KeyboardType`) with its text (1), typed as keystrokes. */
export function cuaTypeRequest(textToType: string): Uint8Array {
  return new ProtobufWriter()
    .bytes(2, new ProtobufWriter().string(1, textToType).finish())
    .finish();
}

/** `Key` values for the DOM key names a Desktop tab sends that name no one character. */
export const CUA_NAMED_KEYS: Readonly<Record<string, number>> = {
  Shift: 1,
  Control: 4,
  Alt: 7,
  Meta: 10,
  CapsLock: 14,
  Enter: 20,
  Tab: 21,
  " ": 22,
  Backspace: 23,
  Delete: 24,
  Escape: 25,
  Insert: 26,
  Home: 27,
  End: 28,
  PageUp: 29,
  PageDown: 30,
  ArrowUp: 31,
  ArrowDown: 32,
  ArrowLeft: 33,
  ArrowRight: 34,
};
/** `KEY_F1` is 60, through `KEY_F12` at 71. */
export const CUA_KEY_F1 = 60;

/**
 * `BeginUploadRequest`: header (1, `WriteFileHeader`: path (1), mode (2)
 * `OVERWRITE` (1), permissions (3), create_parents (4), expected_size (5),
 * expected_sha256 (6)) and upload_id (2).
 */
export function cuaBeginUploadRequest(upload: {
  readonly path: string;
  readonly permissions: number;
  readonly size: number;
  readonly sha256: string;
  readonly uploadId: string;
}): Uint8Array {
  const header = new ProtobufWriter()
    .string(1, upload.path)
    .varint(2, 1)
    .varint(3, upload.permissions)
    .bool(4, true)
    .varint(5, upload.size)
    .string(6, upload.sha256)
    .finish();
  return new ProtobufWriter().bytes(1, header).string(2, upload.uploadId).finish();
}

/** `BeginUploadResponse`: upload_id (1), received_bytes (2), max_chunk_bytes (3). */
export function readCuaBeginUpload(
  bytes: Uint8Array,
):
  | { readonly uploadId: string; readonly receivedBytes: number; readonly maxChunkBytes: number }
  | undefined {
  const fields = parse(bytes);
  if (fields === undefined) return undefined;
  return {
    uploadId: text(fields, 1),
    receivedBytes: Number(varint(fields, 2)),
    maxChunkBytes: Number(varint(fields, 3)),
  };
}

/** `UploadChunkRequest`: upload_id (1), offset (2), data (3). */
export function cuaUploadChunkRequest(uploadId: string, offset: number, data: Uint8Array) {
  return new ProtobufWriter().string(1, uploadId).varint(2, offset).bytes(3, data).finish();
}

/** `UploadChunkResponse`: received_bytes (1). */
export function readCuaUploadChunk(bytes: Uint8Array): number | undefined {
  const fields = parse(bytes);
  return fields === undefined ? undefined : Number(varint(fields, 1));
}

/** `CommitUploadRequest`: upload_id (1), sha256 (2). */
export function cuaCommitUploadRequest(uploadId: string, sha256: string): Uint8Array {
  return new ProtobufWriter().string(1, uploadId).string(2, sha256).finish();
}

/** `CommitUploadResponse`: sha256 (2) of what was committed. */
export function readCuaCommitUpload(bytes: Uint8Array): string | undefined {
  const fields = parse(bytes);
  return fields === undefined ? undefined : text(fields, 2);
}

/** `MoveRequest`: source (1), destination (2), overwrite (3), create_parents (4). */
export function cuaMoveRequest(source: string, destination: string): Uint8Array {
  return new ProtobufWriter()
    .string(1, source)
    .string(2, destination)
    .bool(3, true)
    .bool(4, true)
    .finish();
}

/**
 * `StartProcessRequest`: config (1, `ProcessConfig`: command (1), args (2)).
 * stdin and kill_on_disconnect stay false, so the program reads nothing and
 * a detached child outlives the call.
 */
export function cuaStartProcessRequest(command: string, args: ReadonlyArray<string>): Uint8Array {
  const config = new ProtobufWriter().string(1, command);
  for (const arg of args) config.string(2, arg);
  return new ProtobufWriter().bytes(1, config.finish()).finish();
}

/** The most standard output the driver keeps from one process. */
const MAX_PROCESS_OUTPUT = 65_536;

/**
 * A finished process from a whole `StartProcess` stream: each
 * `StartProcessResponse` carries an event (1) that is a start (1), data (2,
 * with stdout in 2), or an end (3, with exit_code in 1). Undefined when the
 * stream is malformed or never reached its end.
 */
export function readCuaProcessRun(
  messages: ReadonlyArray<Uint8Array>,
): { readonly exitCode: number; readonly stdout: string } | undefined {
  let stdout = "";
  let exitCode: number | undefined;
  for (const message of messages) {
    const event = nested(parse(message) ?? [], 1);
    if (event === undefined) return undefined;
    const data = nested(event, 2);
    const output = data === undefined ? undefined : lastBytes(data, 2);
    if (output !== undefined && stdout.length < MAX_PROCESS_OUTPUT) {
      stdout = `${stdout}${decoder.decode(output)}`.slice(0, MAX_PROCESS_OUTPUT);
    }
    const end = nested(event, 3);
    if (end !== undefined) {
      // `exit_code` is a proto3 `optional`: absent means the process ended
      // without one (a signal or a lost process), never success.
      const code = end.flatMap((each) =>
        each.field === 1 && each.wire === "varint" ? [each.value] : [],
      )[0];
      exitCode = code === undefined ? -1 : Number(BigInt.asIntN(32, code));
    }
  }
  return exitCode === undefined ? undefined : { exitCode, stdout };
}
