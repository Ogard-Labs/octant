import { describe, expect, it } from "vitest";
import { ProtobufWriter, readProtobuf } from "./protobufWire";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const bytesOf = (text: string) => new Uint8Array(Buffer.from(text, "hex"));

describe("protobuf wire helper", () => {
  it("writes the encoding protobuf's own documentation gives for a varint and a string", () => {
    expect(hex(new ProtobufWriter().varint(1, 150).finish())).toBe("089601");
    expect(hex(new ProtobufWriter().string(2, "testing").finish())).toBe("120774657374696e67");
  });

  it("writes a negative int64 as ten bytes of two's complement", () => {
    expect(hex(new ProtobufWriter().varint(1, -1).finish())).toBe("08ffffffffffffffffff01");
    expect(readProtobuf(bytesOf("08ffffffffffffffffff01"))).toEqual({
      status: "read",
      fields: [{ field: 1, wire: "varint", value: 18_446_744_073_709_551_615n }],
    });
  });

  it("reads back every field it writes, nested messages and fixed widths included", () => {
    const inner = new ProtobufWriter().string(1, "ocтant").bool(2, true).finish();
    const message = new ProtobufWriter()
      .varint(1, 9_007_199_254_740_991)
      .bytes(3, inner)
      .fixed32(4, new Uint8Array([1, 2, 3, 4]))
      .fixed64(5, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
      .varint(536_870_911, 2n ** 64n - 1n)
      .finish();
    const read = readProtobuf(message);
    expect(read).toEqual({
      status: "read",
      fields: [
        { field: 1, wire: "varint", value: 9_007_199_254_740_991n },
        { field: 3, wire: "bytes", value: inner },
        { field: 4, wire: "fixed32", value: new Uint8Array([1, 2, 3, 4]) },
        { field: 5, wire: "fixed64", value: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
        { field: 536_870_911, wire: "varint", value: 2n ** 64n - 1n },
      ],
    });
    expect(readProtobuf(inner)).toEqual({
      status: "read",
      fields: [
        { field: 1, wire: "bytes", value: new TextEncoder().encode("ocтant") },
        { field: 2, wire: "varint", value: 1n },
      ],
    });
  });

  it("reads an empty message as no fields", () => {
    expect(readProtobuf(new Uint8Array(0))).toEqual({ status: "read", fields: [] });
  });

  it.each([
    ["a truncated varint", "0896"],
    ["a varint longer than ten bytes", "08ffffffffffffffffffff01"],
    ["a varint past 64 bits", "08ffffffffffffffffff02"],
    ["a length past the end", "120574657374"],
    ["a truncated fixed64", "0901020304"],
    ["a truncated fixed32", "0d0102"],
    ["field number zero", "0001"],
    ["a group start", "0b"],
    ["a group end", "0c"],
    ["an unknown wire type", "0e"],
  ])("answers %s as invalid rather than throwing", (_name, encoded) => {
    expect(readProtobuf(bytesOf(encoded))).toEqual({ status: "invalid" });
  });

  it("refuses a field number or value the wire cannot carry, a broken invariant in driver code", () => {
    expect(() => new ProtobufWriter().varint(0, 1)).toThrow(RangeError);
    expect(() => new ProtobufWriter().varint(536_870_912, 1)).toThrow(RangeError);
    expect(() => new ProtobufWriter().varint(1, 1.5)).toThrow(RangeError);
    expect(() => new ProtobufWriter().varint(1, 2n ** 64n)).toThrow(RangeError);
    expect(() => new ProtobufWriter().varint(1, -(2n ** 63n) - 1n)).toThrow(RangeError);
    expect(() => new ProtobufWriter().fixed32(1, new Uint8Array(3))).toThrow(RangeError);
    expect(() => new ProtobufWriter().fixed64(1, new Uint8Array(9))).toThrow(RangeError);
  });
});
