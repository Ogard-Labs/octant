import {
  CodeWorktreeCreationFrame,
  decodeHostAnswer,
  type CodeThreadId,
  type CodeWorktreeCreationProgress,
} from "@octant/contracts";

export async function readWorktreeCreation(
  response: Response,
  threadId: CodeThreadId,
  progress: (progress: CodeWorktreeCreationProgress) => void,
  maxLineBytes: number,
) {
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("Missing worktree creation stream");
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const decodeFrame = decodeHostAnswer(CodeWorktreeCreationFrame);
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (encoder.encode(line).length > maxLineBytes)
          throw new Error("Worktree frame is too large");
        const frame = decodeFrame(JSON.parse(line));
        if (frame.kind === "failure") return frame;
        if (frame.kind === "result") {
          if (frame.result.thread.id !== threadId) throw new Error("Worktree thread mismatch");
          return frame;
        }
        progress(frame.progress);
        newline = buffer.indexOf("\n");
      }
      if (encoder.encode(buffer).length > maxLineBytes)
        throw new Error("Worktree frame is too large");
    }
    throw new Error("Worktree creation stream ended before its result");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
