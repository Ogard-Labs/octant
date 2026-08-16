import { describe, expect, it } from "vitest";
import { writeWorkZip, readWorkZip } from "./workZipPort";

const textEncoder = new TextEncoder();

describe("workZipPort", () => {
  it("round-trips a single stored entry", () => {
    const bytes = writeWorkZip([{ name: "hello.txt", data: textEncoder.encode("hi") }]);
    const entries = readWorkZip(bytes);
    expect(new TextDecoder().decode(entries.get("hello.txt")!)).toBe("hi");
  });

  it("round-trips multiple deflated entries with binary content", () => {
    const payload = new Uint8Array(2048);
    for (let i = 0; i < payload.byteLength; i += 1) payload[i] = i % 251;
    const bytes = writeWorkZip([
      { name: "a.bin", data: payload },
      { name: "b.bin", data: payload.subarray(0, 100) },
    ]);
    const entries = readWorkZip(bytes);
    expect(entries.get("a.bin")!.byteLength).toBe(2048);
    expect(entries.get("b.bin")!.byteLength).toBe(100);
    expect(Array.from(entries.get("a.bin")!)).toEqual(Array.from(payload));
  });

  it("throws on a truncated container", () => {
    expect(() => readWorkZip(new Uint8Array(4))).toThrow();
  });

  it("throws when the end-of-central-directory record is missing", () => {
    expect(() => readWorkZip(new Uint8Array(64))).toThrow();
  });

  it("rejects an entry whose declared uncompressed size exceeds the budget", () => {
    const bytes = writeWorkZip([{ name: "big.bin", data: textEncoder.encode("small") }]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = bytes.byteLength - 22; i >= 0; i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) {
        const centralOffset = view.getUint32(i + 16, true);
        view.setUint32(centralOffset + 24, 32 * 1024 * 1024, true);
        break;
      }
    }
    expect(() => readWorkZip(bytes)).toThrow(/exceeds budget/);
  });

  it("rejects a container whose entry count exceeds the limit", () => {
    const bytes = writeWorkZip([{ name: "a.txt", data: textEncoder.encode("x") }]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = bytes.byteLength - 22; i >= 0; i -= 1) {
      if (view.getUint32(i, true) === 0x06054b50) {
        // Set the entry count to 2000 (exceeds MAX_WORK_ZIP_ENTRY_COUNT of 1000)
        view.setUint16(i + 10, 2000, true);
        break;
      }
    }
    expect(() => readWorkZip(bytes)).toThrow(/entry count/);
  });

  it.each(["../outside.xml", "/absolute.xml", "xl/../outside.xml", "xl\\outside.xml"])(
    "rejects an unsafe ZIP entry name: %s",
    (name) => {
      const bytes = writeWorkZip([{ name, data: textEncoder.encode("content") }]);
      expect(() => readWorkZip(bytes)).toThrow(/unsafe entry name/);
    },
  );

  it("rejects duplicate ZIP entry names instead of silently overwriting one", () => {
    const bytes = writeWorkZip([
      { name: "xl/workbook.xml", data: textEncoder.encode("first") },
      { name: "xl/workbook.xml", data: textEncoder.encode("second") },
    ]);
    expect(() => readWorkZip(bytes)).toThrow(/duplicate entry name/);
  });
});
