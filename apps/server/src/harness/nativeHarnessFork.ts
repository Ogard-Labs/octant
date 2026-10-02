import {
  decodeProviderSessionId,
  type CodeConversationTurn,
  type CodeThread,
  type CodeThreadForkOrigin,
  type NativeHarnessTranscriptMessage,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderResumeCursor,
  type ProviderSessionId,
} from "@octant/contracts";
import type {
  NativeHarnessTranscript,
  NativeHarnessTranscriptStore,
} from "./nativeHarnessTranscriptStore";

/**
 * A harness fork carries the lead's own working memory — every message, tool
 * call, and result — up to the point it was forked at, instead of a text
 * summary of the conversation. The copy is a new transcript the fork resumes;
 * the source's is never touched.
 */

/** Where a copied message stops being the source's: its folder and its secrets. */
export interface NativeHarnessForkRewrite {
  readonly fromRoot: string;
  readonly toRoot: string;
  readonly secrets: ReadonlyArray<string>;
}

/**
 * The source's messages through its `throughTurn`-th own turn, or undefined
 * when the transcript cannot say exactly where that turn ends.
 *
 * A turn begins with the one user message `send` journals for it; tool
 * results and steering ride in other messages. Every turn the source ran on
 * this session must appear once — a turn refused before it reached the model
 * journals nothing — so a count that does not match means a boundary is
 * unknown, and a guessed cut would hand the fork someone else's turn.
 */
export function nativeHarnessForkPrefix(
  transcript: NativeHarnessTranscript,
  input: { readonly ownTurns: number; readonly throughTurn: number },
):
  | { readonly messages: ReadonlyArray<NativeHarnessTranscriptMessage>; readonly turns: number }
  | undefined {
  const starts = transcript.messages.flatMap((message, index) =>
    message.role === "user" && message.toolResults === undefined ? [index] : [],
  );
  const inherited = transcript.forkedFrom?.turns ?? 0;
  if (input.throughTurn < 1 || input.throughTurn > input.ownTurns) return undefined;
  if (starts.length !== inherited + input.ownTurns) return undefined;
  const turns = inherited + input.throughTurn;
  // The newest turn must have finished its last step; a copy cannot end
  // between a call and its result.
  if (turns === starts.length && transcript.openStep !== undefined) return undefined;
  return {
    messages: transcript.messages.slice(0, starts[turns] ?? transcript.messages.length),
    turns,
  };
}

/**
 * A copied message as the fork should read it: paths under the source's
 * folder point at the fork's own copy of those files, and a secret the thread
 * resolved is never carried into a second transcript.
 */
export function rewriteForFork(
  message: NativeHarnessTranscriptMessage,
  rewrite: NativeHarnessForkRewrite,
): NativeHarnessTranscriptMessage {
  const text = (value: string) =>
    scrub(value.split(rewrite.fromRoot).join(rewrite.toRoot), rewrite.secrets);
  // JSON payloads hold the same strings escaped; a root or secret with a
  // character JSON escapes would otherwise slip past the plain match.
  const json = (value: string) =>
    scrub(
      text(value).split(escaped(rewrite.fromRoot)).join(escaped(rewrite.toRoot)),
      rewrite.secrets.map(escaped),
    );
  return {
    role: message.role,
    text: text(message.text),
    ...(message.toolCalls === undefined
      ? {}
      : {
          toolCalls: message.toolCalls.map((call) => ({
            ...call,
            argumentsJson: json(call.argumentsJson),
          })),
        }),
    ...(message.toolResults === undefined
      ? {}
      : {
          toolResults: message.toolResults.map((result) => ({
            ...result,
            resultJson: json(result.resultJson),
          })),
        }),
  };
}

function scrub(value: string, secrets: ReadonlyArray<string>): string {
  let scrubbed = value;
  for (const secret of secrets) {
    if (secret.length > 0) scrubbed = scrubbed.split(secret).join("[REDACTED]");
  }
  return scrubbed;
}

function escaped(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export interface CodeForkHarnessSeedDependencies {
  readonly transcripts: NativeHarnessTranscriptStore;
  /** The driver kind of a harness provider instance; undefined for any other provider. */
  readonly harnessDriverKind: (instanceId: ProviderInstanceId) => ProviderDriverKind | undefined;
  /** Every turn of a Code thread, oldest first; undefined when it cannot all be read. */
  readonly sourceTurns: (
    threadId: CodeThreadForkOrigin["threadId"],
  ) => ReadonlyArray<CodeConversationTurn> | undefined;
  /**
   * The provider conversation each of the thread's turns ran on, by
   * operation id. A turn's own `sessionId` names the session it asked for,
   * not the conversation a resume carried it into, so it cannot place a turn.
   */
  readonly sourceConversations: (
    threadId: CodeThreadForkOrigin["threadId"],
  ) => ReadonlyMap<string, string> | undefined;
}

/**
 * Seeds a Code fork's first harness session with the source's transcript
 * through the fork point and returns the cursor that resumes it. Undefined
 * whenever the copy could not be exact — another provider, a source turn the
 * transcript cannot place, a turn that has not finished — so the fork falls
 * back to the text handoff rather than starting from a wrong memory.
 */
export async function seedCodeForkHarnessSession(
  deps: CodeForkHarnessSeedDependencies,
  input: {
    readonly fork: CodeThread;
    readonly origin: CodeThreadForkOrigin;
    readonly sessionId: ProviderSessionId;
    readonly checkoutRoot: string;
    readonly secrets: ReadonlyArray<string>;
  },
): Promise<ProviderResumeCursor | undefined> {
  const driverKind = deps.harnessDriverKind(input.fork.providerInstanceId);
  if (driverKind === undefined) return undefined;
  const turns = deps.sourceTurns(input.origin.threadId);
  const conversations = deps.sourceConversations(input.origin.threadId);
  if (turns === undefined || conversations === undefined) return undefined;
  const named = turns.find(
    (turn) => String(turn.operationId) === String(input.origin.throughOperationId),
  );
  if (named === undefined || named.status !== "completed") return undefined;
  const transcriptId = conversations.get(String(named.operationId));
  if (transcriptId === undefined) return undefined;
  const own = turns.filter((turn) => conversations.get(String(turn.operationId)) === transcriptId);
  let sourceSession: ProviderSessionId;
  try {
    sourceSession = decodeProviderSessionId(transcriptId);
  } catch {
    return undefined;
  }
  const transcript = deps.transcripts.load(sourceSession);
  if (
    transcript === undefined ||
    String(transcript.binding.instanceId) !== String(input.fork.providerInstanceId) ||
    transcript.binding.mode !== "code"
  ) {
    return undefined;
  }
  const prefix = nativeHarnessForkPrefix(transcript, {
    ownTurns: own.length,
    throughTurn: own.indexOf(named) + 1,
  });
  if (prefix === undefined) return undefined;
  const rewrite = {
    fromRoot: transcript.binding.projectRoot,
    toRoot: input.checkoutRoot,
    secrets: input.secrets,
  };
  deps.transcripts.open(
    input.sessionId,
    {
      instanceId: transcript.binding.instanceId,
      modelId: transcript.binding.modelId,
      projectRoot: input.checkoutRoot,
      mode: "code",
    },
    { sessionId: sourceSession, turns: prefix.turns },
  );
  for (const message of prefix.messages) {
    deps.transcripts.append(input.sessionId, rewriteForFork(message, rewrite));
  }
  return { driverKind, value: String(input.sessionId) };
}
