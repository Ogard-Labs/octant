import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ClaudeAuthentication,
  type ProviderModelId,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import {
  assertSmoke,
  claudeSmokeBinaryPath as binaryPath,
  claudeSmokeCleanupMarginMs as cleanupMarginMs,
  claudeSmokeMinimumRuntimeVersion as minimumRuntimeVersion,
  claudeSmokeOuterTimeoutMs as outerTimeoutMs,
  claudeSmokeStageTimeouts as stageTimeouts,
  collectClaudeSmokeTurn as collectTurn,
  createClaudeSmokeHarness,
  runClaudeSmokeCleanupSteps,
  sanitizeClaudeSmokeError as sanitizeSmokeError,
  versionAtLeast,
  withTimeout,
} from "./claudeSmokeTestHelpers";

const subscriptionEnabled = process.env.OCTANT_CLAUDE_SUBSCRIPTION_SMOKE === "1";
const apiKeyEnabled = process.env.OCTANT_CLAUDE_API_KEY_SMOKE === "1";
const fullAccessSandboxEnabled = process.env.OCTANT_CLAUDE_FULL_ACCESS_SANDBOX_SMOKE === "1";

const identifiers = {
  subscription: {
    instanceId: decodeProviderInstanceId("80000000-0000-4000-8000-000000000601"),
    plan: decodeProviderSessionId("90000000-0000-4000-8000-000000000601"),
    decline: decodeProviderSessionId("90000000-0000-4000-8000-000000000602"),
    accept: decodeProviderSessionId("90000000-0000-4000-8000-000000000603"),
    question: decodeProviderSessionId("90000000-0000-4000-8000-000000000604"),
    interrupt: decodeProviderSessionId("90000000-0000-4000-8000-000000000605"),
  },
  "api-key": {
    instanceId: decodeProviderInstanceId("80000000-0000-4000-8000-000000000611"),
    plan: decodeProviderSessionId("90000000-0000-4000-8000-000000000611"),
    decline: decodeProviderSessionId("90000000-0000-4000-8000-000000000612"),
    accept: decodeProviderSessionId("90000000-0000-4000-8000-000000000613"),
    question: decodeProviderSessionId("90000000-0000-4000-8000-000000000614"),
    interrupt: decodeProviderSessionId("90000000-0000-4000-8000-000000000615"),
  },
} as const;

describe("installed Claude subscription runtime", () => {
  it.skipIf(!fullAccessSandboxEnabled)(
    "keeps Full access commands inside the Project without approval prompts",
    async () => {
      const instanceId = decodeProviderInstanceId(randomUUID());
      const sessionId = decodeProviderSessionId(randomUUID());
      const harness = await createClaudeSmokeHarness("subscription", instanceId);
      const outside = await mkdtemp(join(homedir(), ".octant-sandbox-smoke-"));
      const sentinel = join(outside, "sentinel.txt");
      const deniedWrite = join(outside, "must-not-exist.txt");
      const inside = join(harness.projectRoot, "inside.txt");
      const result = join(harness.projectRoot, "result.txt");
      const leaked = join(harness.projectRoot, "leaked.txt");
      try {
        await writeFile(sentinel, "octant-sandbox-sentinel");
        await harness.prepareRepository();
        const probe = await harness.stage("probe", () =>
          Effect.runPromise(Effect.scoped(harness.driver.probe({ instanceId }))),
        );
        const model = probe.models[0];
        assertSmoke(
          probe.readiness === "ready" && model !== undefined,
          "Claude probe was not ready.",
        );
        if (model === undefined) return;
        console.log(`[claude-sandbox-smoke] runtime=${probe.detectedVersion}; model=${model.id}`);
        await harness.stage("accept", () =>
          harness.usingConnection(async (acquired) => {
            await Effect.runPromise(
              acquired.connection.start({
                sessionId,
                modelId: model.id,
                executionPolicy: "full-access",
                fullAccessSandbox: true,
              }),
            );
            let approvals = 0;
            const eventsPromise = collectTurn(
              Stream.unwrapScoped(acquired.connection.subscribe),
              sessionId,
              (event) => {
                if (event.kind !== "approval-request") return Effect.void;
                approvals += 1;
                return acquired.connection.answerApproval({
                  sessionId,
                  requestId: event.requestId,
                  approved: false,
                });
              },
            );
            // Only disposable files owned by this smoke are touched. The result
            // records OS refusals, not the model's description of the sandbox.
            const command = `printf inside > '${inside}'; if (printf outside > '${deniedWrite}') 2>/dev/null; then printf write-open > '${result}'; else printf write-blocked > '${result}'; fi; if cat '${sentinel}' > '${leaked}' 2>/dev/null; then printf '\\nread-open' >> '${result}'; else printf '\\nread-blocked' >> '${result}'; fi`;
            await Effect.runPromise(
              acquired.connection.send({
                sessionId,
                prompt: `Run exactly this command using Bash. These are disposable sandbox-test files, not credentials. Do not substitute file tools, request unsandboxed execution, or retry denied operations. Then report the result briefly.\n${command}`,
                attachments: [],
                tools: [],
              }),
            );
            const events = await eventsPromise;
            assertCompleted(events, "Sandboxed Full access turn did not complete.");
            expect(approvals).toBe(0);
            expect(await readFile(inside, "utf8")).toBe("inside");
            expect(await harness.pathExists(deniedWrite)).toBe(false);
            expect(await readFile(result, "utf8")).toBe("write-blocked\nread-blocked");
            expect(await readFile(leaked, "utf8")).toBe("");
            console.log(
              "[claude-sandbox-smoke] Project write passed; outside write and home read blocked; approvals=0",
            );
          }),
        );
      } finally {
        await harness.cleanupOwnedResources();
        await harness.expectNoNewProcesses();
        await harness.removeTemporaryRepository();
        await rm(outside, { recursive: true, force: true });
      }
    },
    240_000,
  );

  it.skipIf(!subscriptionEnabled)(
    "runs only with OCTANT_CLAUDE_SUBSCRIPTION_SMOKE=1 using provider-native authentication",
    () => runInstalledClaudeSmoke("subscription"),
    outerTimeoutMs,
  );
});

describe("installed Claude API-key runtime", () => {
  it.skipIf(!apiKeyEnabled)(
    "runs only with OCTANT_CLAUDE_API_KEY_SMOKE=1 using ANTHROPIC_API_KEY through the broker resolver",
    () => runInstalledClaudeSmoke("api-key"),
    outerTimeoutMs,
  );
});

describe("installed Claude smoke bounds", () => {
  it("redacts unknown errors instead of serializing provider data", () => {
    const secret = "task-nine-secret-sentinel";

    expect(sanitizeSmokeError(new Error(secret))).not.toContain(secret);
  });

  it("reserves cleanup time inside the outer test deadline", () => {
    const stageBudget = Object.values(stageTimeouts).reduce((sum, timeout) => sum + timeout, 0);

    expect(stageBudget + cleanupMarginMs).toBeLessThan(outerTimeoutMs);
  });

  it("awaits cancellation cleanup before rejecting a timed-out operation", async () => {
    let release!: () => void;
    let cleaned = false;
    const operation = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    }).finally(() => {
      cleaned = true;
    });

    await expect(
      withTimeout(operation, 1, async () => {
        release();
      }),
    ).rejects.toThrow("timed out");
    expect(cleaned).toBe(true);
  });

  it("accepts the reviewed Claude runtime floor and later compatible versions", () => {
    expect(versionAtLeast("2.1.209", minimumRuntimeVersion)).toBe(false);
    expect(versionAtLeast("2.1.210", minimumRuntimeVersion)).toBe(true);
    expect(versionAtLeast("2.1.211", minimumRuntimeVersion)).toBe(true);
  });
});

async function runInstalledClaudeSmoke(authentication: ClaudeAuthentication): Promise<void> {
  const ids = identifiers[authentication];
  const harness = await createClaudeSmokeHarness(authentication, ids.instanceId);
  const { driver, projectRoot, stage } = harness;
  const planTarget = join(projectRoot, `plan-must-not-exist-${randomUUID()}.txt`);
  const declinedTarget = join(projectRoot, `declined-must-not-exist-${randomUUID()}.txt`);
  const acceptedTarget = join(projectRoot, `accepted-${randomUUID()}.txt`);
  const acceptedContents = `octant-claude-${authentication}-accepted\n`;

  try {
    await stage("prerequisites", async () => {
      await access(binaryPath);
      await harness.prepareRepository();
      assertSmoke((await harness.repositoryStatus()) === "", "Temporary repository is not clean.");
    });

    const probe = await stage("probe", () =>
      Effect.runPromise(Effect.scoped(driver.probe({ instanceId: ids.instanceId }))),
    );
    console.log(
      `[claude-smoke:${authentication}] probe-summary: readiness=${probe.readiness}; models=${probe.models.length}; reviewed-version=${versionAtLeast(probe.detectedVersion ?? "", minimumRuntimeVersion) ? "compatible" : "incompatible"}`,
    );
    assertSmoke(probe.readiness === "ready", "Claude probe was not ready.");
    assertSmoke(
      versionAtLeast(probe.detectedVersion ?? "", minimumRuntimeVersion),
      "Installed Claude version was below the reviewed compatibility floor.",
    );
    assertSmoke(probe.models.length > 0, "Claude probe returned no models.");
    const modelId = probe.models[0]!.id as ProviderModelId;

    const resumeCursor = await stage("plan", () =>
      harness.usingConnection(async (acquired) => {
        const baselineStatus = await harness.repositoryStatus();
        const handle = await Effect.runPromise(
          acquired.connection.start({
            sessionId: ids.plan,
            modelId,
            executionPolicy: "plan",
          }),
        );
        assertSmoke(handle.resumeCursor?.driverKind === "claude", "Resume cursor was missing.");
        const eventsPromise = collectTurn(
          Stream.unwrapScoped(acquired.connection.subscribe),
          ids.plan,
        );
        await Effect.runPromise(
          acquired.connection.send({
            sessionId: ids.plan,
            prompt: `Inspect only repository metadata, then attempt to create ${planTarget}. Return a brief plain-text plan.`,

            attachments: [],
            tools: [],
          }),
        );
        const events = await eventsPromise;
        assertCompleted(events, "Plan turn did not complete.");
        assertSmoke(hasText(events), "Plan turn returned no normalized text.");
        assertSmoke(hasUsage(events), "Plan turn returned no normalized usage.");
        assertSmoke(!(await harness.pathExists(planTarget)), "Plan mode wrote a test-owned file.");
        assertSmoke(
          (await harness.repositoryStatus()) === baselineStatus,
          "Plan mode changed repository state.",
        );
        await Effect.runPromise(acquired.connection.stop(ids.plan));
        return handle.resumeCursor!;
      }),
    );

    await stage("decline", () =>
      harness.usingConnection(async (acquired) => {
        await Effect.runPromise(
          acquired.connection.start({
            sessionId: ids.decline,
            modelId,
            executionPolicy: "approval-gated",
          }),
        );
        let approvals = 0;
        const eventsPromise = collectTurn(
          Stream.unwrapScoped(acquired.connection.subscribe),
          ids.decline,
          (event) => {
            if (event.kind !== "approval-request") return Effect.void;
            approvals += 1;
            return acquired.connection.answerApproval({
              sessionId: ids.decline,
              requestId: event.requestId,
              approved: false,
            });
          },
        );
        await Effect.runPromise(
          acquired.connection.send({
            sessionId: ids.decline,
            prompt: `Use Write exactly once to create ${declinedTarget}. Do not use another tool or merely describe the write.`,

            attachments: [],
            tools: [],
          }),
        );
        const events = await eventsPromise;
        assertCompleted(events, "Declined approval turn did not complete.");
        assertSmoke(approvals === 1, "Declined write did not produce exactly one approval.");
        assertSmoke(
          !(await harness.pathExists(declinedTarget)),
          "Declined write changed the filesystem.",
        );
      }),
    );

    await stage("accept", () =>
      harness.usingConnection(async (acquired) => {
        await Effect.runPromise(
          acquired.connection.start({
            sessionId: ids.accept,
            modelId,
            executionPolicy: "approval-gated",
          }),
        );
        let approvals = 0;
        const eventsPromise = collectTurn(
          Stream.unwrapScoped(acquired.connection.subscribe),
          ids.accept,
          (event) => {
            if (event.kind !== "approval-request") return Effect.void;
            approvals += 1;
            return acquired.connection.answerApproval({
              sessionId: ids.accept,
              requestId: event.requestId,
              approved: true,
            });
          },
        );
        await Effect.runPromise(
          acquired.connection.send({
            sessionId: ids.accept,
            prompt: `Use Write exactly once to create ${acceptedTarget} with exactly this content: ${acceptedContents.trim()}`,

            attachments: [],
            tools: [],
          }),
        );
        const events = await eventsPromise;
        assertCompleted(events, "Accepted approval turn did not complete.");
        assertSmoke(approvals === 1, "Accepted write did not produce exactly one approval.");
        // The prompt gives the line without its final newline, so a runtime that
        // writes exactly what it was given leaves none. Observed with Claude Code
        // 2.1.296: the approved write happened and this check still failed.
        assertSmoke(
          (await readFile(acceptedTarget, "utf8")).trimEnd() === acceptedContents.trimEnd(),
          "Accepted write content did not match.",
        );
      }),
    );

    await stage("question", () =>
      harness.usingConnection(async (acquired) => {
        await Effect.runPromise(
          acquired.connection.start({
            sessionId: ids.question,
            modelId,
            executionPolicy: "approval-gated",
          }),
        );
        let questions = 0;
        const eventsPromise = collectTurn(
          Stream.unwrapScoped(acquired.connection.subscribe),
          ids.question,
          (event) => {
            if (event.kind !== "user-input-request") return Effect.void;
            questions += 1;
            return acquired.connection.answerUserInput({
              sessionId: ids.question,
              requestId: event.requestId,
              answer: "alpha",
            });
          },
        );
        await Effect.runPromise(
          acquired.connection.send({
            sessionId: ids.question,
            prompt:
              "Use AskUserQuestion exactly once to ask which test label to use, with alpha and beta as the two options. Do not answer it yourself.",

            attachments: [],
            tools: [],
          }),
        );
        const events = await eventsPromise;
        assertCompleted(events, "Question turn did not complete.");
        assertSmoke(questions === 1, "Question turn did not produce exactly one user request.");
      }),
    );

    await stage("interrupt", () =>
      harness.usingConnection(async (acquired) => {
        await Effect.runPromise(
          acquired.connection.start({
            sessionId: ids.interrupt,
            modelId,
            executionPolicy: "plan",
          }),
        );
        let interruptedAfterOutput = false;
        const eventsPromise = collectTurn(
          Stream.unwrapScoped(acquired.connection.subscribe),
          ids.interrupt,
          (event) => {
            if (event.kind !== "text-delta" || interruptedAfterOutput) return Effect.void;
            interruptedAfterOutput = true;
            return acquired.connection.interrupt(ids.interrupt);
          },
        );
        await Effect.runPromise(
          acquired.connection.send({
            sessionId: ids.interrupt,
            prompt: "Produce a long numbered plain-text sequence without using tools.",

            attachments: [],
            tools: [],
          }),
        );
        const events = await eventsPromise;
        assertSmoke(interruptedAfterOutput, "Interruption occurred before accepted output.");
        assertSmoke(
          events.at(-1)?.kind === "interrupted",
          "Accepted-output interruption returned the wrong terminal state.",
        );
      }),
    );

    await stage("resume", () =>
      harness.usingConnection(async (acquired) => {
        const resumed = await Effect.runPromise(
          acquired.connection.resume({
            sessionId: ids.plan,
            resumeCursor,
            executionPolicy: "plan",
          }),
        );
        assertSmoke(
          resumed.resumeCursor?.driverKind === "claude" &&
            resumed.resumeCursor.value === resumeCursor.value,
          "Exact resume returned a different cursor.",
        );
        const eventsPromise = collectTurn(
          Stream.unwrapScoped(acquired.connection.subscribe),
          ids.plan,
        );
        await Effect.runPromise(
          acquired.connection.send({
            sessionId: ids.plan,
            prompt: "Reply briefly with a test-safe confirmation and do not use tools.",

            attachments: [],
            tools: [],
          }),
        );
        assertCompleted(await eventsPromise, "Resumed turn did not complete.");
        await Effect.runPromise(acquired.connection.stop(ids.plan));
      }),
    );

    const metrics = harness.metrics();
    assertSmoke(
      metrics.resumeLookupAtExactRoot,
      "Resume lookup did not use the exact Project root.",
    );
    assertSmoke(
      metrics.resumeOpenedAtExactRoot,
      "Resumed query did not use the exact Project root.",
    );
    assertSmoke(
      metrics.runtimeStarts >= 7,
      "Claude runtime did not restart for isolated sessions.",
    );
    assertSmoke(
      metrics.subscriptionEnvironmentIsolated,
      "Subscription environment inherited credentials.",
    );
    if (authentication === "subscription") {
      assertSmoke(
        metrics.subscriptionProbeCalls >= 7,
        "Subscription authentication was not probed.",
      );
      assertSmoke(
        metrics.brokerHasCalls === 0 && metrics.brokerResolveCalls === 0,
        "Subscription used the broker.",
      );
    } else {
      assertSmoke(
        metrics.subscriptionProbeCalls === 0,
        "API-key mode called the subscription probe.",
      );
      assertSmoke(
        metrics.brokerHasCalls >= 7 && metrics.brokerResolveCalls >= 7,
        "API-key broker was bypassed.",
      );
      assertSmoke(
        metrics.apiCredentialInjected,
        "API key did not pass through the runtime environment.",
      );
      assertSmoke(
        metrics.apiEnvironmentIsolated,
        "API-key runtime did not use isolated configuration.",
      );
      assertSmoke(
        metrics.configDirectoryCount === 1,
        "API-key launches did not all use the one assigned account directory.",
      );
    }
    assertSmoke(metrics.diagnostics >= 0, "Claude diagnostics counter was invalid.");
  } finally {
    await runClaudeSmokeCleanupSteps([
      {
        label: "runtime",
        timeoutMs: stageTimeouts.cleanup,
        run: harness.cleanupOwnedResources,
      },
      { label: "repository", run: harness.removeTemporaryRepository },
      {
        label: "sessions",
        run: async () => {
          assertSmoke(harness.activeSessionCount() === 0, "Active sessions survived cleanup.");
        },
      },
      {
        label: "resume-identities",
        run: async () => {
          assertSmoke(
            harness.resumeIdentityCount() === 0,
            "Resume identities survived test cleanup.",
          );
        },
      },
      {
        label: "config-directories",
        run: async () => {
          assertSmoke(
            (await harness.survivingConfigDirectories()).length === 0,
            "A temporary Claude config directory survived.",
          );
        },
      },
      ...(authentication === "api-key"
        ? [
            {
              label: "user-config-metadata",
              run: async () => {
                assertSmoke(
                  await harness.userConfigurationUnchanged(),
                  "API-key smoke changed user Claude configuration metadata.",
                );
              },
            },
          ]
        : []),
      {
        label: "processes",
        timeoutMs: 12_000,
        run: harness.expectNoNewProcesses,
      },
    ]);
  }
}

function assertCompleted(events: readonly ProviderRuntimeEvent[], message: string): void {
  assertSmoke(events.at(-1)?.kind === "completed", message);
}

function hasText(events: readonly ProviderRuntimeEvent[]): boolean {
  return events.some((event) => event.kind === "text-delta");
}

function hasUsage(events: readonly ProviderRuntimeEvent[]): boolean {
  return events.some(
    (event) =>
      event.kind === "usage" &&
      Number.isSafeInteger(event.inputTokens) &&
      Number.isSafeInteger(event.outputTokens),
  );
}
