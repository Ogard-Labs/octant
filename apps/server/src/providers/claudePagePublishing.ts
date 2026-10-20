import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  decodePagePublishRequest,
  type ClaudeAuthentication,
  type PagePublishAvailability,
  type PagePublishOutcome,
  type PagePublishRequest,
  type ProviderFailure,
  type ProviderInstanceId,
} from "@octant/contracts";
import type { ProviderPagePublishingSource } from "@octant/provider-sdk/page-publishing";
import { Effect, type Scope, Stream } from "effect";
import { failure } from "./claudeAgentSdkDecoder";
import type {
  ClaudeAgentSdkPort,
  ClaudeDecodedMessage,
  ClaudePreToolDecision,
  ClaudePreToolRequest,
} from "./claudeAgentSdkPort";
import type { ClaudeEnvironmentScope, ClaudeEnvironmentScopeOptions } from "./claudeEnvironment";
import type { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

/**
 * The Claude driver's page-publishing operation: publishing one HTML page on
 * the person's Anthropic account through the Claude runtime Octant already
 * manages, outside any thread.
 *
 * The runtime's own `Artifact` tool is the only thing that can publish a page,
 * so this runs it: a one-shot session, signed in as this instance's account,
 * bound to a private folder only this call can name, offered the `Artifact`
 * tool and no other, and allowed exactly one publish of exactly the approved
 * file. Everything Claude-shaped — the tool's name, its input, the hook that
 * pins it — stays in this adapter; the seam speaks in pages, refusals, and
 * addresses. The person's approval of the export card is the consent; nothing
 * here raises a second prompt and nothing here runs from an agent turn.
 */

/** The runtime's own tool that publishes a file as a private page. */
const ARTIFACT_TOOL = "Artifact";
/**
 * The model the one-shot asks for. Publishing is one tool call with a fixed
 * answer, so the alias the readiness probe already proves is enough.
 */
const PUBLISH_MODEL = "sonnet";
/** A publish is one tool call; a session that takes longer is not finishing. */
const DEFAULT_PUBLISH_TIMEOUT_MS = 120_000;

type ClaudeEnvironmentFactory = (
  authentication: ClaudeAuthentication,
  options?: ClaudeEnvironmentScopeOptions,
) => Effect.Effect<ClaudeEnvironmentScope, ProviderFailure, Scope.Scope>;

export interface ClaudePagePublishingOptions {
  readonly instanceId: ProviderInstanceId;
  /** The instance's display name, which the card names as the account the page goes out under. */
  readonly displayName: string;
  readonly binaryPath: string;
  readonly authentication: ClaudeAuthentication;
  /** Claude-owned directory for this account. */
  readonly configDirectory?: string;
  readonly sdk: Pick<ClaudeAgentSdkPort, "openQuery">;
  readonly runtimeRegistry: Pick<ProviderRuntimeRegistry, "observedState">;
  readonly makeEnvironmentScope: ClaudeEnvironmentFactory;
  readonly timeoutMs?: number;
}

export const CLAUDE_PAGE_API_KEY_REFUSAL =
  "Claude is signed in with an API key, which cannot publish pages. Sign in to Claude with the official application.";
const RUNTIME_REFUSED = "The Claude runtime refused to publish the page.";
const GATE_REFUSED = "Claude asked to publish something other than the approved page.";
const NOT_FINISHED = "Claude did not finish publishing the page.";
const NOT_PUBLISHED = "Claude did not publish the page.";
const NOT_STARTED = "Claude could not be started to publish the page.";
const TIMED_OUT = "Claude did not publish the page in time.";
const NOT_THIS_ACCOUNT = "This Claude provider does not hold the account asked to publish.";
const MALFORMED_REQUEST = "The page is not one Claude can publish.";

/**
 * Whether this instance can publish right now. Readiness is the probe's
 * observation, the same one a thread launch trusts, and the capability it
 * declared: a runtime that does not say `artifactPublish` is not asked to. An
 * API-key account is refused rather than tried, because pages live with a
 * Claude sign-in, not a console key, and the runtime would fail the publish
 * after the session started. Any other instance id is absent: a driver holds
 * one account.
 */
function availabilityOf(
  options: ClaudePagePublishingOptions,
  instanceId: ProviderInstanceId,
): PagePublishAvailability {
  if (String(instanceId) !== String(options.instanceId)) return { kind: "absent" };
  const observed = options.runtimeRegistry.observedState(options.instanceId);
  if (observed?.readiness !== "ready" || observed.capabilities.artifactPublish !== "supported") {
    return { kind: "not-signed-in" };
  }
  if (options.authentication !== "subscription") {
    return { kind: "refused", reason: CLAUDE_PAGE_API_KEY_REFUSAL };
  }
  return { kind: "ready", account: options.displayName };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `PreToolUse` answer for the one-shot. Only an `Artifact` publish of the
 * approved file is allowed, and its input is replaced wholesale with the file
 * and title the person approved, so nothing the model added (another file, a
 * page to overwrite, a pin, a capability) reaches the runtime. A hook "allow"
 * is final, so this is the whole decision; the permission callback denies
 * whatever still reaches it.
 */
export function claudePagePublishDecision(
  request: ClaudePreToolRequest,
  approved: { readonly filePath: string; readonly title: string },
): ClaudePreToolDecision {
  const deny = (message: string): ClaudePreToolDecision => ({ behavior: "deny", message });
  if (request.toolName !== ARTIFACT_TOOL || !isRecord(request.input)) {
    return deny("Only the approved page may be published.");
  }
  const action = request.input.action ?? "publish";
  if (action !== "publish") return deny("Only a publish of the approved page is allowed.");
  const named = request.input.file_path;
  if (typeof named !== "string" || named.trim().length === 0) {
    return deny("Claude may publish only the approved page.");
  }
  const resolved = isAbsolute(named) ? named : resolve(request.projectRoot, named);
  if (resolved !== approved.filePath) return deny("Claude may publish only the approved page.");
  return {
    behavior: "allow",
    updatedInput: { file_path: approved.filePath, title: approved.title },
  };
}

/**
 * The one-shot's hook: the first approved publish is allowed and every call
 * after it is denied, so one approval makes at most one page. A session that
 * asked twice would otherwise publish twice while only the first address was
 * reported.
 */
export function claudePagePublishOnce(approved: {
  readonly filePath: string;
  readonly title: string;
}): (request: ClaudePreToolRequest) => ClaudePreToolDecision {
  let published = false;
  return (request) => {
    if (published) return { behavior: "deny", message: "The approved page was already published." };
    const decision = claudePagePublishDecision(request, approved);
    if (decision.behavior === "allow") published = true;
    return decision;
  };
}

interface PublishTally {
  readonly artifactCalls: Set<string>;
  publishedAddress?: string;
  artifactRefused: boolean;
  gateDenied: boolean;
  result?: "success" | "error";
}

function tally(state: PublishTally, message: ClaudeDecodedMessage): PublishTally {
  switch (message.kind) {
    case "assistant":
      for (const content of message.content) {
        if (content.kind === "tool-use" && content.toolName === ARTIFACT_TOOL) {
          state.artifactCalls.add(content.toolUseId);
        }
      }
      return state;
    case "stream-event":
      if (
        message.event.kind === "content-start" &&
        message.event.content.kind === "tool-use" &&
        message.event.content.toolName === ARTIFACT_TOOL
      ) {
        state.artifactCalls.add(message.event.content.toolUseId);
      }
      return state;
    case "tool-results":
      for (const result of message.results) {
        if (!state.artifactCalls.has(result.toolUseId)) continue;
        if (result.isError) state.artifactRefused = true;
        else if (result.artifactUrl !== undefined) state.publishedAddress ??= result.artifactUrl;
      }
      return state;
    case "result":
      state.result = message.outcome;
      if (message.permissionDenials.length > 0) state.gateDenied = true;
      return state;
    default:
      return state;
  }
}

/**
 * What the session's messages add up to. A published address wins; a refused
 * tool call is a refusal; anything else is not known to have published, and
 * says so rather than guessing.
 */
function outcomeOf(state: PublishTally): PagePublishOutcome {
  if (state.publishedAddress !== undefined) {
    return { kind: "published", address: state.publishedAddress };
  }
  if (state.artifactRefused) return { kind: "refused", message: RUNTIME_REFUSED };
  if (state.gateDenied) return { kind: "refused", message: GATE_REFUSED };
  if (state.result === "error") return { kind: "unavailable", message: NOT_FINISHED };
  return { kind: "unavailable", message: NOT_PUBLISHED };
}

function outcomeOfFailure(failed: ProviderFailure): PagePublishOutcome {
  if (failed.category === "unauthenticated") return { kind: "not-signed-in" };
  if (failed.category === "unavailable" && failed.message === TIMED_OUT) {
    return { kind: "unavailable", message: TIMED_OUT };
  }
  return { kind: "unavailable", message: NOT_STARTED };
}

/**
 * The folder the one-shot binds as its project root: owner-only, named by its
 * real path (the runtime reports its working directory resolved, and the port
 * holds the hook to the root it was given), and removed with the page once the
 * session closes, whatever the outcome.
 */
const privatePageFolder = Effect.acquireRelease(
  Effect.tryPromise({
    try: async () => realpath(await mkdtemp(join(tmpdir(), "octant-claude-page-"))),
    catch: () =>
      failure("provider-failed", "Claude page publish could not create a private folder."),
  }),
  (folder) =>
    Effect.promise(() => rm(folder, { recursive: true, force: true }).catch(() => undefined)),
);

function prompt(fileName: string, title: string): string {
  return `Publish the file ${fileName} in this folder as a private page with the Artifact tool, titled ${JSON.stringify(title)}. Make that one tool call and nothing else, then reply "done".`;
}

export function makeClaudePagePublishing(
  options: ClaudePagePublishingOptions,
): ProviderPagePublishingSource {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;

  const run = (request: PagePublishRequest): Effect.Effect<PagePublishOutcome, ProviderFailure> =>
    Effect.scoped(
      Effect.gen(function* () {
        // The same account environment a thread of this instance launches
        // with. Acquired before the folder and the query, so it outlives both.
        const environment = yield* options.makeEnvironmentScope(
          options.authentication,
          options.configDirectory === undefined ? {} : { configDirectory: options.configDirectory },
        );
        const folder = yield* privatePageFolder;
        const filePath = join(folder, request.fileName);
        yield* Effect.tryPromise({
          try: () =>
            writeFile(filePath, request.html, { encoding: "utf8", mode: 0o600, flag: "wx" }),
          catch: () => failure("provider-failed", "Claude page publish could not write the page."),
        });
        const approved = { filePath, title: request.title };
        const publishOnce = claudePagePublishOnce(approved);
        const query = yield* options.sdk.openQuery({
          binaryPath: options.binaryPath,
          projectRoot: folder,
          authEnvironment: environment.environment,
          model: PUBLISH_MODEL,
          // The posture that runs the runtime in its ordinary permission mode
          // with Octant's hook deciding every call; Plan is refused the tool
          // by the runtime itself and Full access would need no hook at all.
          executionPolicy: "approval-gated",
          // The whole tool list. The port refuses any other tool before either
          // callback runs, so a session that asks for a shell, a file edit, or
          // the web is refused by name.
          tools: [ARTIFACT_TOOL],
          sandbox: {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: false,
            allowUnsandboxedCommands: false,
            filesystem: { denyRead: ["/"], allowRead: [folder], allowWrite: [folder] },
          },
          // The hook's "allow" is final, so a call that still reaches the
          // permission callback was not the approved publish.
          canUseTool: async () => ({
            behavior: "deny",
            message: "Only the approved page may be published.",
          }),
          preToolUse: async (hookRequest) => publishOnce(hookRequest),
        });
        yield* query.send({ text: prompt(request.fileName, request.title) });
        const initial: PublishTally = {
          artifactCalls: new Set(),
          artifactRefused: false,
          gateDenied: false,
        };
        const state = yield* Stream.runFold(
          query.messages.pipe(Stream.takeUntil((message) => message.kind === "result")),
          initial,
          tally,
        );
        return outcomeOf(state);
      }),
    ).pipe(
      Effect.timeoutFail({
        duration: timeoutMs,
        onTimeout: () => failure("unavailable", TIMED_OUT),
      }),
    );

  return {
    availability: ({ instanceId }) => availabilityOf(options, instanceId),
    publish: (input) => {
      const availability = availabilityOf(options, input.instanceId);
      if (availability.kind === "absent") {
        return Promise.resolve({ kind: "refused", message: NOT_THIS_ACCOUNT });
      }
      if (availability.kind === "refused") {
        return Promise.resolve({ kind: "refused", message: availability.reason });
      }
      if (availability.kind === "not-signed-in") return Promise.resolve({ kind: "not-signed-in" });
      // The host decodes the request before asking; this adapter writes the
      // file name into a folder, so it holds the same line on its own.
      let request: PagePublishRequest;
      try {
        request = decodePagePublishRequest({
          fileName: input.fileName,
          title: input.title,
          html: input.html,
        });
      } catch {
        return Promise.resolve({ kind: "refused", message: MALFORMED_REQUEST });
      }
      return Effect.runPromise(
        run(request).pipe(Effect.catchAll((failed) => Effect.succeed(outcomeOfFailure(failed)))),
      );
    },
  };
}
