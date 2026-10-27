/**
 * A small protobuf wire reader and writer for drivers that speak to a local
 * daemon through {@link DesktopDaemonPort}.
 *
 * It knows the wire format only: varints, length-delimited fields, and the
 * fixed 32- and 64-bit widths. It has no descriptors and no reflection, so a
 * driver writes the field numbers of the few messages it uses by hand from
 * its provider's published `.proto` files. A driver imports only
 * `@octant/contracts` and the desktop-provider seam, which is why this lives
 * in the seam rather than as a dependency.
 *
 * Reading answers a malformed message as a value, because the bytes come from
 * another program. Writing throws only for a field number or value no message
 * could carry, which is a mistake in the driver's own code.
 */

export type ProtobufField =
  | { readonly field: number; readonly wire: "varint"; readonly value: bigint }
  | { readonly field: number; readonly wire: "fixed64"; readonly value: Uint8Array }
  | { readonly field: number; readonly wire: "bytes"; readonly value: Uint8Array }
  | { readonly field: number; readonly wire: "fixed32"; readonly value: Uint8Array };

/**
 * Every field in wire order, repeated and unknown ones included. A
 * length-delimited field is a string, bytes, a packed list, or a nested
 * message; the driver reads it as the `.proto` says.
 */
export type ProtobufReadResult =
  | { readonly status: "read"; readonly fields: ReadonlyArray<ProtobufField> }
  | { readonly status: "invalid" };

const MAX_FIELD_NUMBER = 536_870_911;
const UINT64_MAX = 2n ** 64n - 1n;
const INT64_MIN = -(2n ** 63n);

function fieldNumber(field: number): number {
  if (!Number.isInteger(field) || field < 1 || field > MAX_FIELD_NUMBER) {
    throw new RangeError(`Protobuf field number out of range: ${field}`);
  }
  return field;
}

function encodeVarint(value: bigint): Uint8Array {
  const bytes: Array<number> = [];
  let rest = value;
  while (rest > 0x7fn) {
    bytes.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return new Uint8Array(bytes);
}

export class ProtobufWriter {
  readonly #parts: Array<Uint8Array> = [];

  #key(field: number, wireType: number): void {
    this.#parts.push(encodeVarint(BigInt(fieldNumber(field)) * 8n + BigInt(wireType)));
  }

  /**
   * An int32, int64, uint32, uint64, or enum. A negative value is written as
   * its 64-bit two's complement, as protobuf writes a negative int32 or int64.
   */
  varint(field: number, value: number | bigint): this {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new RangeError(`Protobuf varint is not a safe integer: ${value}`);
    }
    const whole = BigInt(value);
    if (whole > UINT64_MAX || whole < INT64_MIN) {
      throw new RangeError("Protobuf varint does not fit in 64 bits");
    }
    this.#key(field, 0);
    this.#parts.push(encodeVarint(BigInt.asUintN(64, whole)));
    return this;
  }

  bool(field: number, value: boolean): this {
    return this.varint(field, value ? 1 : 0);
  }

  /** Bytes, or a nested message another writer finished. */
  bytes(field: number, value: Uint8Array): this {
    this.#key(field, 2);
    this.#parts.push(encodeVarint(BigInt(value.byteLength)), value.slice());
    return this;
  }

  string(field: number, value: string): this {
    return this.bytes(field, new TextEncoder().encode(value));
  }

  /** A fixed32, sfixed32, or float, as its four little-endian bytes. */
  fixed32(field: number, value: Uint8Array): this {
    if (value.byteLength !== 4) throw new RangeError("A fixed32 field is four bytes");
    this.#key(field, 5);
    this.#parts.push(value.slice());
    return this;
  }

  /** A fixed64, sfixed64, or double, as its eight little-endian bytes. */
  fixed64(field: number, value: Uint8Array): this {
    if (value.byteLength !== 8) throw new RangeError("A fixed64 field is eight bytes");
    this.#key(field, 1);
    this.#parts.push(value.slice());
    return this;
  }

  finish(): Uint8Array {
    const length = this.#parts.reduce((total, part) => total + part.byteLength, 0);
    const message = new Uint8Array(length);
    let offset = 0;
    for (const part of this.#parts) {
      message.set(part, offset);
      offset += part.byteLength;
    }
    return message;
  }
}

/** A varint at `offset`, or undefined when it is truncated or does not fit in 64 bits. */
function readVarint(
  bytes: Uint8Array,
  offset: number,
): { readonly value: bigint; readonly next: number } | undefined {
  let value = 0n;
  for (let index = 0; index < 10; index += 1) {
    const byte = bytes[offset + index];
    if (byte === undefined) return undefined;
    // The tenth byte carries only the 64th bit.
    if (index === 9 && byte > 1) return undefined;
    value |= BigInt(byte & 0x7f) << BigInt(7 * index);
    if ((byte & 0x80) === 0) return { value, next: offset + index + 1 };
  }
  return undefined;
}

export function readProtobuf(bytes: Uint8Array): ProtobufReadResult {
  const fields: Array<ProtobufField> = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const key = readVarint(bytes, offset);
    if (key === undefined) return { status: "invalid" };
    const field = Number(key.value >> 3n);
    if (field < 1 || field > MAX_FIELD_NUMBER) return { status: "invalid" };
    offset = key.next;
    switch (Number(key.value & 7n)) {
      case 0: {
        const value = readVarint(bytes, offset);
        if (value === undefined) return { status: "invalid" };
        fields.push({ field, wire: "varint", value: value.value });
        offset = value.next;
        break;
      }
      case 1: {
        if (offset + 8 > bytes.byteLength) return { status: "invalid" };
        fields.push({ field, wire: "fixed64", value: bytes.slice(offset, offset + 8) });
        offset += 8;
        break;
      }
      case 2: {
        const length = readVarint(bytes, offset);
        if (length === undefined) return { status: "invalid" };
        const end = BigInt(length.next) + length.value;
        if (end > BigInt(bytes.byteLength)) return { status: "invalid" };
        fields.push({ field, wire: "bytes", value: bytes.slice(length.next, Number(end)) });
        offset = Number(end);
        break;
      }
      case 5: {
        if (offset + 4 > bytes.byteLength) return { status: "invalid" };
        fields.push({ field, wire: "fixed32", value: bytes.slice(offset, offset + 4) });
        offset += 4;
        break;
      }
      // Groups (3 and 4) are deprecated and no published message a driver
      // uses carries one; 6 and 7 are not wire types.
      default:
        return { status: "invalid" };
    }
  }
  return { status: "read", fields };
}
