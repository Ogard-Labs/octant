import type { ProviderInstanceId, ProviderModelId, ProviderSessionId } from "@octant/contracts";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect, Fiber, Stream, type Scope } from "effect";
import { subscribeThenSend } from "../providers/providerEventDelivery";

/** Bound on the whole request: a draft is a convenience, never a wait. */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 3_000;
const MAX_EVENTS = 64;
/**
 * How much diff the drafting request may read.
 *
 * A commit message is written from the shape of a change, not from every line
 * of it, and an unbounded diff would push a large refactor past the model's
 * window for no gain. The truncation is stated in the prompt so the model
 * knows it is summarizing a sample.
 */
const MAX_DIFF_BYTES = 24_000;

export type CodeGitDraftPurpose = "commit-message" | "pull-request";

export type CodeGitDraftResult =
  | { readonly status: "drafted"; readonly title: string; readonly body?: string }
  | { readonly status: "unavailable" | "failed" };

export interface CodeGitDraftRequest {
  readonly purpose: CodeGitDraftPurpose;
  readonly branch?: string;
  /** The change to describe, already truncated by the caller if it wishes. */
  readonly diff: string;
  readonly diffTruncated: boolean;
  readonly paths: readonly string[];
}

export interface CodeGitDraftServiceOptions {
  readonly driver: ProviderDriver;
  readonly instanceId: ProviderInstanceId;
  readonly modelId: ProviderModelId;
  readonly sessionId: ProviderSessionId;
  /** Where the drafting session runs. The draft reads nothing from disk. */
  readonly projectRoot: string;
  readonly timeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

/**
 * Ask the thread's own provider to describe a change the checkout already
 * shows.
 *
 * The request is tool-free and read-only by construction: the diff travels in
 * the prompt, the session is given no tools, and the answer is text the user
 * edits before anything is committed or opened. A provider that cannot answer
 * leaves the field empty rather than producing a message nobody wrote.
 */
export async function draftGitText(
  options: CodeGitDraftServiceOptions,
  request: CodeGitDraftRequest,
): Promise<CodeGitDraftResult> {
  const state: DraftState = { text: "", handled: 0, completed: false };
  try {
    await Effect.runPromise(
      Effect.scoped(
        runDraft(options, request, state).pipe(
          Effect.timeoutFail({
            duration: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            onTimeout: () => new Error("The provider did not draft within its deadline."),
          }),
        ),
      ),
    );
  } catch {
    return { status: "failed" };
  }
  if (!state.completed) return { status: "failed" };
  return splitDraft(state.text);
}

interface DraftState {
  text: string;
  handled: number;
  completed: boolean;
}

function runDraft(
  options: CodeGitDraftServiceOptions,
  request: CodeGitDraftRequest,
  state: DraftState,
): Effect.Effect<void, unknown, Scope.Scope> {
  return Effect.gen(function* () {
    const connection = yield* options.driver.acquire({
      instanceId: options.instanceId,
      projectRoot: options.projectRoot,
      mode: "code",
    });
    yield* Effect.addFinalizer(() =>
      connection.stop(options.sessionId).pipe(
        Effect.timeout(options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS),
        Effect.catchAll(() => Effect.void),
      ),
    );
    yield* connection.start({
      sessionId: options.sessionId,
      modelId: options.modelId,
      // Plan keeps the drafting session read-only at the provider as well as
      // in this prompt, so a model that decides to act cannot.
      executionPolicy: "plan",
    });
    const events = yield* subscribeThenSend({
      connection,
      consume: (runtimeEvents) =>
        runtimeEvents.pipe(
          Stream.filter((event) => event.sessionId === options.sessionId),
          Stream.take(MAX_EVENTS + 1),
          Stream.takeUntil(isTerminal),
          Stream.runForEach((event) =>
            Effect.sync(() => {
              state.handled += 1;
              if (state.handled > MAX_EVENTS) return;
              if (event.kind === "text-delta") state.text += event.text;
              if (event.kind === "completed") state.completed = true;
            }),
          ),
        ),
      send: connection.send({
        sessionId: options.sessionId,
        prompt: draftPrompt(request),
        context: [],
        attachments: [],
        tools: [],
      }),
    });
    yield* Fiber.join(events);
  });
}

function isTerminal(event: { readonly kind: string }): boolean {
  return event.kind === "completed" || event.kind === "failed" || event.kind === "interrupted";
}

function draftPrompt(request: CodeGitDraftRequest): string {
  const shape =
    request.purpose === "commit-message"
      ? [
          "Write a Git commit message for the change below.",
          "First line: an imperative subject under 72 characters.",
          "Then a blank line, then a short body explaining why, only if the",
          "reason is not obvious from the subject.",
        ]
      : [
          "Write a pull request title and description for the change below.",
          "First line: the title.",
          "Then a blank line, then the description in Markdown.",
        ];
  const lines = [
    ...shape,
    "Describe only what the diff shows. Do not invent motivation, ticket",
    "numbers, or work that is not present. Return the message itself with no",
    "preamble, no code fences, and no commentary.",
    "",
    ...(request.branch === undefined ? [] : [`Branch: ${request.branch}`, ""]),
    `Files changed (${request.paths.length}):`,
    ...request.paths.slice(0, 100).map((path) => `- ${path}`),
    "",
    request.diffTruncated
      ? "Diff (truncated — describe the change it samples, not only these lines):"
      : "Diff:",
    request.diff,
  ];
  return lines.join("\n");
}

/**
 * Split the provider's answer into a subject and body.
 *
 * Models routinely wrap the answer in a code fence despite being asked not to;
 * stripping it here is what keeps backticks out of a commit subject.
 */
export function splitDraft(text: string): CodeGitDraftResult {
  const cleaned = stripFence(text).trim();
  if (cleaned.length === 0) return { status: "failed" };
  const [subject = "", ...rest] = cleaned.split("\n");
  const title = subject.trim().slice(0, 512);
  if (title.length === 0) return { status: "failed" };
  const body = rest.join("\n").trim();
  return { status: "drafted", title, ...(body.length === 0 ? {} : { body }) };
}

function stripFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  const firstBreak = trimmed.indexOf("\n");
  if (firstBreak === -1) return trimmed;
  const closing = trimmed.lastIndexOf("```");
  if (closing <= firstBreak) return trimmed.slice(firstBreak + 1);
  return trimmed.slice(firstBreak + 1, closing);
}

/** Cut a diff to the drafting budget on a line boundary. */
export function boundedDiff(diff: string): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(diff, "utf8") <= MAX_DIFF_BYTES) return { text: diff, truncated: false };
  const sliced = Buffer.from(diff, "utf8").subarray(0, MAX_DIFF_BYTES).toString("utf8");
  const lastBreak = sliced.lastIndexOf("\n");
  return { text: lastBreak === -1 ? sliced : sliced.slice(0, lastBreak), truncated: true };
}
