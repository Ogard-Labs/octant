import { MAX_CODE_TERMINAL_LIVE_FRAME_BYTES, type CodeTerminalId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { liveFramesOf, splitByUtf8Bytes } from "./terminalLiveFrames";

const terminalId = "55555555-5555-4555-8555-555555555555" as CodeTerminalId;
const bytes = (value: string) => Buffer.byteLength(value, "utf8");

describe("live terminal frames", () => {
  it.each([
    ["ASCII", "a", 1],
    ["CJK", "界", 3],
    ["emoji", "😀", 4],
  ])("splits %s output at the byte bound without cutting a character", (_name, unit, width) => {
    // One character more than fits, so the boundary lands exactly on a split.
    const count = Math.floor(MAX_CODE_TERMINAL_LIVE_FRAME_BYTES / width) + 1;
    const text = unit.repeat(count);

    const pieces = splitByUtf8Bytes(text, MAX_CODE_TERMINAL_LIVE_FRAME_BYTES);

    expect(pieces.length).toBe(2);
    expect(pieces.join("")).toBe(text);
    for (const piece of pieces) {
      expect(bytes(piece)).toBeLessThanOrEqual(MAX_CODE_TERMINAL_LIVE_FRAME_BYTES);
      expect(Buffer.from(piece, "utf8").toString("utf8")).toBe(piece);
    }
  });

  it("keeps a surrogate pair whole when it straddles the bound", () => {
    const text = `ab${"😀".repeat(3)}c`;

    const pieces = splitByUtf8Bytes(text, 7);

    // Two ASCII bytes and one emoji fill 6 of 7; no second emoji fits after it.
    expect(pieces).toEqual(["ab😀", "😀", "😀c"]);
    expect(pieces.every((piece) => !/[\ud800-\udbff]$/.test(piece))).toBe(true);
  });

  it("numbers each frame by where it ends so a window can resume after any of them", () => {
    const text = "界".repeat(50_000);
    const end = 1_000 + text.length;

    const frames = liveFramesOf({
      terminalId,
      text,
      replace: true,
      characters: end,
      state: "exited",
      exitCode: 4,
    });

    expect(frames.length).toBe(3);
    expect(frames.map((frame) => frame.replace)).toEqual([true, false, false]);
    expect(frames.every((frame) => bytes(frame.text) <= MAX_CODE_TERMINAL_LIVE_FRAME_BYTES)).toBe(
      true,
    );
    expect(frames.map((frame) => frame.text).join("")).toBe(text);
    let position = end - text.length;
    for (const frame of frames) {
      position += frame.text.length;
      expect(frame.characters).toBe(position);
    }
    expect(frames.at(-1)?.characters).toBe(end);
    // Only the last frame says the shell ended; a window stops reading there.
    expect(frames.map((frame) => frame.state)).toEqual(["running", "running", "exited"]);
    expect(frames.at(-1)?.exitCode).toBe(4);
    expect(frames[0]).not.toHaveProperty("exitCode");
  });

  it("still sends one frame for a publish that carries only a state change", () => {
    expect(
      liveFramesOf({ terminalId, text: "", replace: false, characters: 9, state: "interrupted" }),
    ).toEqual([{ terminalId, text: "", replace: false, characters: 9, state: "interrupted" }]);
  });
});
