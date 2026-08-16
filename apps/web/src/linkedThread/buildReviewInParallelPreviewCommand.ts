import type { LinkedThreadPromptPreviewCommand } from "@octant/contracts";
import type { ChatThread } from "@octant/contracts/chat";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import { resolveReviewInParallelSkillPrompt } from "@octant/domain";

export type BuildReviewInParallelPreviewCommandResult =
  | { readonly kind: "ready"; readonly command: LinkedThreadPromptPreviewCommand }
  | { readonly kind: "invalid"; readonly reason: string };

export async function buildReviewInParallelPreviewCommand(input: {
  readonly thread: ChatThread;
  readonly task: string;
  readonly requestedCount: number;
  readonly requestId: string;
  readonly contextSnapshotId: string;
  readonly digest: (value: string) => Promise<string>;
}): Promise<BuildReviewInParallelPreviewCommandResult> {
  const resolved = resolveReviewInParallelSkillPrompt({
    task: input.task,
    requestedCount: input.requestedCount,
  });
  if (resolved.kind !== "linked-thread-fan-out") {
    return { kind: "invalid", reason: resolved.reason };
  }
  const scope = {
    hostId: LOCAL_HOST_ID,
    mode: "chat" as const,
    workspace: {
      kind: "chat-virtual" as const,
      projectId: input.thread.projectId ?? null,
    },
  };
  const requestFingerprint = await input.digest(
    JSON.stringify({
      prompt: resolved.prompt,
      requestedCount: resolved.requestedCount,
      sourceThreadId: String(input.thread.id),
      sourceVersion: input.thread.version,
    }),
  );
  return {
    kind: "ready",
    command: {
      kind: "linked-thread-prompt-preview",
      requestId: input.requestId as never,
      requestFingerprint: requestFingerprint as never,
      prompt: resolved.prompt,
      sourceThreadId: input.thread.id as never,
      sourceScope: scope as never,
      sourceVersion: input.thread.version as never,
      contextSnapshotId: input.contextSnapshotId as never,
      targetScope: scope as never,
      requestedAuthority: resolved.authority,
      nestingDepth: 1,
    },
  };
}

export async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
