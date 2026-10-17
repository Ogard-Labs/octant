import {
  MAX_CODE_TERMINAL_LIVE_FRAME_BYTES,
  type CodeTerminalId,
  type CodeTerminalLiveFrame,
} from "@octant/contracts";

/**
 * Cut text into pieces of at most `maximumBytes` of UTF-8, never inside a
 * character: a surrogate pair stays whole, and a lone surrogate counts as the
 * three bytes its replacement character takes. Each piece keeps its own length
 * in UTF-16 units, which is what a terminal's character offsets are counted in.
 */
export function splitByUtf8Bytes(text: string, maximumBytes: number): ReadonlyArray<string> {
  const pieces: string[] = [];
  let start = 0;
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const unit = text.charCodeAt(index);
    const pair =
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff;
    const width = pair ? 4 : unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    if (bytes + width > maximumBytes) {
      pieces.push(text.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += width;
    index += pair ? 2 : 1;
  }
  if (start < text.length) pieces.push(text.slice(start));
  return pieces;
}

/**
 * The frames for one publish. Output longer than a frame carries is split in
 * order, the first keeping the publish's `replace` and the rest appending to
 * it. Every frame's `characters` is the offset its own last character ends at,
 * counted back from where the publish ended, so a window that drops after any
 * frame resumes exactly where it stopped; only the last frame says the shell's
 * state, because a window stops reading at the first frame that says it ended.
 */
export function liveFramesOf(input: {
  readonly terminalId: CodeTerminalId;
  readonly text: string;
  readonly replace: boolean;
  /** Offset one past the last character of `text`. */
  readonly characters: number;
  readonly state: CodeTerminalLiveFrame["state"];
  readonly exitCode?: number | null;
}): ReadonlyArray<CodeTerminalLiveFrame> {
  const pieces = splitByUtf8Bytes(input.text, MAX_CODE_TERMINAL_LIVE_FRAME_BYTES);
  const parts = pieces.length === 0 ? [""] : pieces;
  let remaining = input.text.length;
  return parts.map((text, position) => {
    remaining -= text.length;
    const last = position === parts.length - 1;
    return {
      terminalId: input.terminalId,
      text,
      replace: position === 0 ? input.replace : false,
      characters: input.characters - remaining,
      state: last ? input.state : "running",
      ...(last && input.state === "exited" ? { exitCode: input.exitCode ?? null } : {}),
    };
  });
}
