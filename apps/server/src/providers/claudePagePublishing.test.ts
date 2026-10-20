import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  decodeProviderInstanceId,
  type ClaudeAuthentication,
  type ProviderFailure,
} from "@octant/contracts";
import { Effect, PubSub, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import type {
  ClaudeDecodedMessage,
  ClaudeJsonValue,
  ClaudeOpenQueryInput,
  ClaudeQueryPort,
} from "./claudeAgentSdkPort";
import { failure } from "./claudeAgentSdkDecoder";
import type { ClaudeEnvironmentScope } from "./claudeEnvironment";
import {
  CLAUDE_PAGE_API_KEY_REFUSAL,
  claudePagePublishDecision,
  claudePagePublishOnce,
  makeClaudePagePublishing,
} from "./claudePagePublishing";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000901");
const otherInstanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000902");
const observedAt = "2026-10-20T12:00:00.000Z";
const pageUrl = "https://claude.ai/artifact/abc-123";

function ready(registry: ProviderRuntimeRegistry) {
  registry.setObservedState({
    instanceId,
    readiness: "ready",
    processState: "stopped",
    detectedVersion: "2.1.304",
    models: [],
    capabilities: {
      streaming: "supported",
      resume: "supported",
      interruption: "supported",
      approvals: "supported",
      userQuestions: "supported",
      reasoning: "supported",
      usage: "supported",
      toolActivity: "supported",
      fileChanges: "supported",
      diffs: "supported",
      taskProgress: "supported",
      nativeChildAgents: "unsupported",
      harnessAutoReview: "supported",
      nativeAttachments: "unsupported",
      nativeWebResearch: "unsupported",
      appManagedTools: "supported",
      citations: "unsupported",
      artifactPublish: "supported",
    },
    lastSuccessfulProbeAt: observedAt,
    observedAt,
  });
}

/** A query whose messages the test writes after the publisher sends its prompt. */
class FakeQuery implements ClaudeQueryPort {
  readonly initialization: ClaudeQueryPort["initialization"] = {
    models: [],
    account: { ready: true, apiProvider: "firstParty" },
    compactAnnounced: true,
  };
  readonly sent: string[] = [];
  readonly messages: Stream.Stream<ClaudeDecodedMessage, ProviderFailure>;
  readonly sessionId = Effect.succeed("sdk-session-1");
  readonly #pubsub = Effect.runSync(PubSub.unbounded<ClaudeDecodedMessage>());
  readonly #onSend: (query: FakeQuery) => Promise<void>;
  closed = false;
  /** An assertion that failed inside the scripted answer; rethrown by the harness. */
  error: unknown;

  constructor(onSend: (query: FakeQuery) => Promise<void>) {
    this.#onSend = onSend;
    this.messages = Stream.fromPubSub(this.#pubsub);
  }

  send: ClaudeQueryPort["send"] = ({ text }) =>
    Effect.promise(async () => {
      this.sent.push(text);
      // The runtime answers after the prompt lands; a subscriber is already
      // attached by then, as the publisher folds the stream right after send.
      // A failed assertion in the script still ends the session, so the test
      // reports it instead of waiting out the publisher's timeout.
      setTimeout(() => {
        void this.#onSend(this).catch((error: unknown) => {
          this.error = error;
          return this.emit(finished("error"));
        });
      }, 0);
    });
  emit(message: ClaudeDecodedMessage): Promise<boolean> {
    return Effect.runPromise(PubSub.publish(this.#pubsub, message));
  }
  requestCompaction = () => Effect.void;
  interrupt = () => Effect.void;
  setPermissionMode = () => Effect.void;
  supportedModels = () => Effect.succeed([]);
  accountInfo = () => Effect.succeed(this.initialization.account);
  readPlanUsage = () => Effect.succeed(undefined);
  close = () =>
    Effect.sync(() => {
      this.closed = true;
    });
}

const toolUse = (
  toolUseId: string,
  input: { readonly [key: string]: ClaudeJsonValue },
): ClaudeDecodedMessage => ({
  kind: "assistant",
  sessionId: "sdk-session-1",
  messageId: "message-1",
  content: [{ kind: "tool-use", toolUseId, toolName: "Artifact", input }],
  usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
});

const toolResult = (
  toolUseId: string,
  result: { readonly isError: boolean; readonly artifactUrl?: string },
): ClaudeDecodedMessage => ({
  kind: "tool-results",
  sessionId: "sdk-session-1",
  results: [{ toolUseId, ...result }],
});

const finished = (outcome: "success" | "error", denials = 0): ClaudeDecodedMessage => ({
  kind: "result",
  sessionId: "sdk-session-1",
  outcome,
  subtype: outcome === "success" ? "success" : "error_during_execution",
  stopReason: "end_turn",
  usage: { inputTokens: 1, outputTokens: 1, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
  permissionDenials: Array.from({ length: denials }, (_, index) => ({
    toolName: "Artifact",
    toolUseId: `denied-${index}`,
  })),
});

function harness(input: {
  readonly authentication?: ClaudeAuthentication;
  readonly signedIn?: boolean;
  readonly onSend?: (query: FakeQuery) => Promise<void>;
  readonly openFailure?: ProviderFailure;
  readonly timeoutMs?: number;
}) {
  const registry = new ProviderRuntimeRegistry();
  if (input.signedIn !== false) ready(registry);
  const authentication = input.authentication ?? "subscription";
  const opens: ClaudeOpenQueryInput[] = [];
  const queries: FakeQuery[] = [];
  const releasedEnvironments: string[] = [];
  const source = makeClaudePagePublishing({
    instanceId,
    displayName: "Claude",
    binaryPath: "/opt/homebrew/bin/claude",
    authentication,
    ...(authentication === "api-key" ? { configDirectory: "/accounts/claude-key" } : {}),
    runtimeRegistry: registry,
    sdk: {
      openQuery: (openInput) =>
        input.openFailure !== undefined
          ? Effect.fail(input.openFailure)
          : Effect.acquireRelease(
              Effect.sync(() => {
                opens.push(openInput);
                const query = new FakeQuery(input.onSend ?? (async () => undefined));
                queries.push(query);
                return query;
              }),
              (query) => query.close(),
            ),
    },
    makeEnvironmentScope: (mode, options) =>
      Effect.acquireRelease(
        Effect.succeed({
          environment: {
            PATH: "/usr/bin",
            CLAUDE_CONFIG_DIR: options?.configDirectory ?? `/provider-native/${mode}`,
          },
        } satisfies ClaudeEnvironmentScope),
        () =>
          Effect.sync(() => {
            releasedEnvironments.push(mode);
          }),
      ) as Effect.Effect<ClaudeEnvironmentScope, ProviderFailure, Scope.Scope>,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
  });
  const publish = async (page: typeof request, target = instanceId) => {
    const outcome = await source.publish({ instanceId: target, ...page });
    for (const query of queries) if (query.error !== undefined) throw query.error;
    return outcome;
  };
  return { source, publish, opens, queries, releasedEnvironments };
}

const request = {
  fileName: "Launch plan.html",
  title: "Launch plan",
  html: "<!doctype html><p>Scope</p>",
};

describe("publishing a Canvas page through the Claude runtime", () => {
  it("runs one session offered only the Artifact tool, bound to a private folder holding the page, and reports the address", async () => {
    let folder: string | undefined;
    let fileExistedDuringSession = false;
    let fileMode = 0;
    const { publish, opens, queries, releasedEnvironments } = harness({
      onSend: async (query) => {
        const open = opens[0];
        folder = open?.projectRoot;
        const filePath = join(folder ?? "", request.fileName);
        fileExistedDuringSession = existsSync(filePath);
        fileMode = statSync(filePath).mode & 0o777;
        expect(readFileSync(filePath, "utf8")).toBe(request.html);
        await query.emit(toolUse("tool-1", { file_path: filePath, title: "Launch plan" }));
        await query.emit(toolResult("tool-1", { isError: false, artifactUrl: pageUrl }));
        await query.emit(finished("success"));
      },
    });

    const outcome = await publish(request);

    expect(outcome).toEqual({ kind: "published", address: pageUrl });
    expect(opens).toHaveLength(1);
    const open = opens[0];
    if (open === undefined) throw new Error("Expected one session.");
    // The whole tool list: no file edit, shell, web, or MCP tool is offered.
    expect(open.tools).toEqual(["Artifact"]);
    expect(open.executionPolicy).toBe("approval-gated");
    expect(open.binaryPath).toBe("/opt/homebrew/bin/claude");
    expect(open.authEnvironment).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/provider-native/subscription",
    });
    // The session's root is a folder only this publish names, and its sandbox
    // reads and writes nothing outside it.
    expect(folder).toBeDefined();
    expect(open.sandbox?.filesystem).toEqual({
      denyRead: ["/"],
      allowRead: [folder],
      allowWrite: [folder],
    });
    expect(fileExistedDuringSession).toBe(true);
    expect(fileMode).toBe(0o600);
    expect(queries[0]?.sent).toEqual([
      'Publish the file Launch plan.html in this folder as a private page with the Artifact tool, titled "Launch plan". Make that one tool call and nothing else, then reply "done".',
    ]);
    // The session closes and the page leaves the machine's disk with it.
    expect(queries[0]?.closed).toBe(true);
    expect(existsSync(folder ?? "")).toBe(false);
    expect(releasedEnvironments).toEqual(["subscription"]);
  });

  it("allows exactly one publish of the approved file and pins its input; everything else is denied", async () => {
    const { publish, opens } = harness({
      onSend: async (query) => {
        const open = opens[0];
        if (open === undefined) throw new Error("Expected one session.");
        const filePath = join(open.projectRoot, request.fileName);
        const hook = (toolName: string, input: unknown) =>
          open.preToolUse({
            sessionId: "sdk-session-1",
            projectRoot: open.projectRoot,
            toolName,
            input,
            toolUseId: "tool-x",
            signal: new AbortController().signal,
          });
        // A relative path is the runtime's own working-directory form and
        // names the same file; the allow replaces the model's input wholesale.
        await expect(
          hook("Artifact", { file_path: request.fileName, title: "Whatever", pin: true, url: "x" }),
        ).resolves.toEqual({
          behavior: "allow",
          updatedInput: { file_path: filePath, title: "Launch plan" },
        });
        // One approval is one page: a second publish of the same file is denied.
        await expect(hook("Artifact", { file_path: filePath })).resolves.toMatchObject({
          behavior: "deny",
        });
        await expect(hook("Artifact", { action: "list" })).resolves.toMatchObject({
          behavior: "deny",
        });
        await expect(hook("Artifact", { action: "read", url: pageUrl })).resolves.toMatchObject({
          behavior: "deny",
        });
        await expect(
          hook("Artifact", { file_path: join(open.projectRoot, "other.html") }),
        ).resolves.toMatchObject({ behavior: "deny" });
        await expect(
          hook("Artifact", { file_path: "/Users/person/secret.html" }),
        ).resolves.toMatchObject({ behavior: "deny" });
        await expect(hook("Bash", { command: "cat ~/.ssh/id_rsa" })).resolves.toMatchObject({
          behavior: "deny",
        });
        await expect(hook("Write", { file_path: filePath, content: "" })).resolves.toMatchObject({
          behavior: "deny",
        });
        // A call that still reaches the permission callback was not the pinned publish.
        await expect(
          open.canUseTool({
            toolName: "Artifact",
            input: { file_path: filePath },
            toolUseId: "tool-x",
            signal: new AbortController().signal,
          }),
        ).resolves.toMatchObject({ behavior: "deny" });
        await query.emit(toolUse("tool-1", { file_path: filePath }));
        await query.emit(toolResult("tool-1", { isError: false, artifactUrl: pageUrl }));
        await query.emit(finished("success"));
      },
    });

    await expect(publish(request)).resolves.toEqual({ kind: "published", address: pageUrl });
  });

  it("reports a runtime refusal as a refusal, never as published", async () => {
    const { publish, opens } = harness({
      onSend: async (query) => {
        const filePath = join(opens[0]?.projectRoot ?? "", request.fileName);
        await query.emit(toolUse("tool-1", { file_path: filePath }));
        await query.emit(toolResult("tool-1", { isError: true }));
        await query.emit(finished("success"));
      },
    });

    await expect(publish(request)).resolves.toEqual({
      kind: "refused",
      message: "The Claude runtime refused to publish the page.",
    });
  });

  it("reports a session that published nothing as unavailable, not as a success", async () => {
    const { publish } = harness({
      onSend: async (query) => {
        await query.emit(finished("error"));
      },
    });

    await expect(publish(request)).resolves.toEqual({
      kind: "unavailable",
      message: "Claude did not finish publishing the page.",
    });
  });

  it("reports a refusal when the gate denied what Claude asked to publish", async () => {
    const { publish } = harness({
      onSend: async (query) => {
        await query.emit(finished("success", 1));
      },
    });

    await expect(publish(request)).resolves.toEqual({
      kind: "refused",
      message: "Claude asked to publish something other than the approved page.",
    });
  });

  it("gives up on a session that never finishes and removes its folder", async () => {
    const { publish, opens, queries } = harness({ timeoutMs: 50 });

    await expect(publish(request)).resolves.toEqual({
      kind: "unavailable",
      message: "Claude did not publish the page in time.",
    });
    expect(queries[0]?.closed).toBe(true);
    expect(existsSync(opens[0]?.projectRoot ?? "")).toBe(false);
  });

  it("reports not signed in when the runtime refuses the account, and when the account is not ready", async () => {
    const unauthenticated = harness({
      openFailure: failure("unauthenticated", "Claude authentication is required."),
    });
    await expect(unauthenticated.publish(request)).resolves.toEqual({ kind: "not-signed-in" });

    const unobserved = harness({ signedIn: false });
    expect(unobserved.source.availability({ instanceId })).toEqual({ kind: "not-signed-in" });
    await expect(unobserved.publish(request)).resolves.toEqual({ kind: "not-signed-in" });
    expect(unobserved.opens).toHaveLength(0);
  });

  it("names the account when ready, and holds no other instance", async () => {
    const { source, publish, opens } = harness({});
    expect(source.availability({ instanceId })).toEqual({ kind: "ready", account: "Claude" });
    expect(source.availability({ instanceId: otherInstanceId })).toEqual({ kind: "absent" });
    await expect(publish(request, otherInstanceId)).resolves.toMatchObject({ kind: "refused" });
    expect(opens).toHaveLength(0);
  });

  it("refuses an account signed in with an API key without starting a session", async () => {
    const keyed = harness({ authentication: "api-key" });
    expect(keyed.source.availability({ instanceId })).toEqual({
      kind: "refused",
      reason: CLAUDE_PAGE_API_KEY_REFUSAL,
    });
    await expect(keyed.publish(request)).resolves.toEqual({
      kind: "refused",
      message: CLAUDE_PAGE_API_KEY_REFUSAL,
    });
    expect(keyed.opens).toHaveLength(0);
  });

  it("refuses a request that names a folder instead of a file without starting a session", async () => {
    const { publish, opens } = harness({});
    await expect(publish({ ...request, fileName: "../Launch plan.html" })).resolves.toMatchObject({
      kind: "refused",
    });
    expect(opens).toHaveLength(0);
  });
});

describe("the one-shot publish decision", () => {
  const approved = { filePath: "/pages/one/Launch plan.html", title: "Launch plan" };
  const hookRequest = (toolName: string, input: unknown) => ({
    sessionId: "s",
    projectRoot: "/pages/one",
    toolName,
    input,
    toolUseId: "t",
    signal: new AbortController().signal,
  });

  it("treats an absent action as a publish, as the runtime does", () => {
    expect(
      claudePagePublishDecision(
        hookRequest("Artifact", { file_path: "Launch plan.html" }),
        approved,
      ),
    ).toEqual({ behavior: "allow", updatedInput: approved_input() });
    expect(
      claudePagePublishDecision(
        hookRequest("Artifact", { action: "publish", file_path: approved.filePath }),
        approved,
      ),
    ).toEqual({ behavior: "allow", updatedInput: approved_input() });
  });

  it("denies an input that is not an object or names no file", () => {
    expect(claudePagePublishDecision(hookRequest("Artifact", "page"), approved)).toMatchObject({
      behavior: "deny",
    });
    expect(claudePagePublishDecision(hookRequest("Artifact", {}), approved)).toMatchObject({
      behavior: "deny",
    });
    expect(
      claudePagePublishDecision(hookRequest("Artifact", { file_path: "  " }), approved),
    ).toMatchObject({ behavior: "deny" });
  });

  it("allows one publish per approval and denies every call after it", () => {
    const hook = claudePagePublishOnce(approved);
    const call = hookRequest("Artifact", { file_path: "Launch plan.html" });
    expect(hook(call)).toEqual({ behavior: "allow", updatedInput: approved_input() });
    expect(hook(call)).toMatchObject({ behavior: "deny" });
  });

  it("still allows the approved publish after a refused call", () => {
    const hook = claudePagePublishOnce(approved);
    expect(hook(hookRequest("Artifact", { file_path: "other.html" }))).toMatchObject({
      behavior: "deny",
    });
    expect(hook(hookRequest("Artifact", { file_path: "Launch plan.html" }))).toMatchObject({
      behavior: "allow",
    });
  });

  function approved_input() {
    return { file_path: approved.filePath, title: approved.title };
  }
});
