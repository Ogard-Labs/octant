import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeThread } from "@octant/contracts/code";
import type { TurnActivity } from "../transcript/turnActivity";
import {
  projectConversationTurns,
  readConversationEvidence,
  type CodeConversationMessage,
} from "./codeControllerState";

/**
 * A fork's inherited history on a host without the window read, read whole
 * from each source thread up to the turn the fork was made from. Only a fork
 * opened on such a host needs it, so it loads with that read rather than
 * with the first window.
 */
export async function readForkConversation(
  client: CodeClient,
  origin: NonNullable<CodeThread["forkedFrom"]>,
  signal: AbortSignal,
  visited: ReadonlySet<string> = new Set(),
): Promise<{
  readonly messages: ReadonlyArray<CodeConversationMessage>;
  readonly activity: ReadonlyMap<string, TurnActivity>;
}> {
  const sourceId = String(origin.threadId);
  if (visited.has(sourceId) || visited.size >= 32)
    throw new Error("Fork history contains an invalid lineage.");
  const source = await client.thread(origin.threadId, signal);
  const inherited =
    source.thread.forkedFrom === undefined
      ? { messages: [], activity: new Map<string, TurnActivity>() }
      : await readForkConversation(
          client,
          source.thread.forkedFrom,
          signal,
          new Set([...visited, sourceId]),
        );
  const messages: CodeConversationMessage[] = [...inherited.messages];
  const activity = new Map(inherited.activity);
  let cursor = 0;
  for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
    const page = await client.conversation(origin.threadId, cursor, 50, signal);
    const boundary = page.turns.findIndex(
      (turn) => String(turn.operationId) === String(origin.throughOperationId),
    );
    const turns = boundary < 0 ? page.turns : page.turns.slice(0, boundary + 1);
    const evidence = await readConversationEvidence(client, origin.threadId, turns, signal);
    const projected = await projectConversationTurns(
      client,
      origin.threadId,
      turns,
      evidence,
      signal,
    );
    messages.push(
      ...projected.messages.map((message) => ({ ...message, sourceThreadId: origin.threadId })),
    );
    for (const [key, value] of projected.activity) activity.set(key, value);
    if (boundary >= 0) return { messages, activity };
    if (!page.hasMore || page.nextCursor <= cursor) break;
    cursor = page.nextCursor;
  }
  throw new Error("The source response for this fork is unavailable.");
}
