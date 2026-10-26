import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderContextBlock,
  type ProviderInstanceId,
  type ProviderModelId,
  type ProviderResumeCursor,
  type ProviderRuntimeEvent,
  type ProviderSessionId,
} from "@octant/contracts";
import type { ProviderConnection, ProviderDriver } from "@octant/provider-sdk/driver";
import { access, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { Effect, Exit, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { createClaudeSmokeHarness } from "./claudeSmokeTestHelpers";
import { makeCodexDriver } from "./codexDriver";
import { makeCodexProcessLive } from "./codexProcess";
import { HeldTurnContext } from "./heldTurnContext";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

/**
 * Before and after for held standing context on a real Claude or Codex Code
 * session: one arm sends the whole standing context with every turn (how
 * provider-owned sessions were sent turns before), the other sends only what
 * the session does not already hold. Each arm runs the same four Plan turns,
 * reopening the session by resume before the third, and reports per turn the
 * time to the first streamed text, the whole turn's time, the input the
 * runtime counted, how much of it came from its prompt cache, and the
 * standing context left out.
 *
 * Opt-in, because it spends a real account's turns: set
 * OCTANT_HELD_CONTEXT_MEASURE_CLAUDE=1 (the installed Claude Code, signed in)
 * or OCTANT_HELD_CONTEXT_MEASURE_CODEX=1 (the installed Codex, signed in).
 * Without it the cases are skipped; a skipped run is not a measurement. The
 * table is written to the test output; nothing is asserted about the
 * figures, only that each turn completed and reported usage.
 */
const claudeEnabled = process.env.OCTANT_HELD_CONTEXT_MEASURE_CLAUDE === "1";
const codexEnabled = process.env.OCTANT_HELD_CONTEXT_MEASURE_CODEX === "1";
const TIMEOUT_MS = 900_000;

/** A standing context the size of Octant's own instructions and two skills. */
const STANDING: ReadonlyArray<ProviderContextBlock> = [
  {
    kind: "instructions",
    text: Array.from(
      { length: 60 },
      (_, index) =>
        `Guideline ${index + 1}: keep answers short, name files by their path from the repository root, and say when something could not be checked.`,
    ).join("\n"),
  },
  {
    kind: "instructions",
    text: Array.from(
      { length: 30 },
      (_, index) =>
        `Review step ${index + 1}: read the change, list what it touches, and state one risk before suggesting anything.`,
    ).join("\n"),
  },
  {
    kind: "project-memory",
    text: "This repository is a scratch Git repository created for a measurement run.",
  },
];

const PROMPTS = [
  "In one sentence, what kind of directory is this?",
  "Name one file you would expect in a new Git repository.",
  "In one sentence, what does a Plan turn not do?",
  "Reply with the single word: done.",
] as const;

interface TurnFigures {
  readonly arm: "full" | "held";
  readonly turn: number;
  readonly resumed: boolean;
  readonly firstTextMs: number | undefined;
  readonly turnMs: number;
  readonly inputTokens: number | undefined;
  readonly cacheReadInputTokens: number | undefined;
  readonly cacheWriteInputTokens: number | undefined;
  readonly standingCharactersSent: number;
}

interface Acquired {
  readonly connection: ProviderConnection;
  readonly close: () => Promise<void>;
}

describe("held standing context, measured on a real Code session", () => {
  it.skipIf(!claudeEnabled)(
    "reports Claude turn latency and cache use with and without held context",
    async () => {
      const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000781");
      const harness = await createClaudeSmokeHarness("subscription", instanceId);
      try {
        await harness.prepareRepository();
        const probe = await Effect.runPromise(Effect.scoped(harness.driver.probe({ instanceId })));
        const modelId = probe.models[0]?.id;
        expect(modelId).toBeDefined();
        const figures = await measureBothArms({
          acquire: () => acquire(harness.driver, instanceId, harness.projectRoot),
          modelId: modelId as ProviderModelId,
          sessionIds: [
            decodeProviderSessionId("90000000-0000-4000-8000-000000000781"),
            decodeProviderSessionId("90000000-0000-4000-8000-000000000782"),
          ],
        });
        report("Claude", figures);
      } finally {
        await harness.cleanupOwnedResources();
        await harness.removeTemporaryRepository();
      }
    },
    TIMEOUT_MS,
  );

  it.skipIf(!codexEnabled)(
    "reports Codex turn latency and cache use with and without held context",
    async () => {
      const binaryPath = await findExecutable("codex");
      expect(binaryPath, "the measurement needs an installed Codex").toBeDefined();
      const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000791");
      const registry = new ProviderRuntimeRegistry();
      const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "octant-held-codex.")));
      const driver = makeCodexDriver({
        instanceId,
        binaryPath: binaryPath ?? "codex",
        process: makeCodexProcessLive({ shutdownTimeoutMs: 2_000, startupTimeoutMs: 20_000 }),
        runtimeRegistry: registry,
        idleLeaseMs: 0,
        permissionPersistence: () => "current-session",
      });
      try {
        const probe = await Effect.runPromise(Effect.scoped(driver.probe({ instanceId })));
        registry.setObservedState(probe);
        const modelId = probe.models[0]?.id;
        expect(modelId).toBeDefined();
        const figures = await measureBothArms({
          acquire: () => acquire(driver, instanceId, projectRoot),
          modelId: modelId as ProviderModelId,
          sessionIds: [
            decodeProviderSessionId("90000000-0000-4000-8000-000000000791"),
            decodeProviderSessionId("90000000-0000-4000-8000-000000000792"),
          ],
        });
        report("Codex", figures);
      } finally {
        await registry.closeAll();
        await rm(projectRoot, { recursive: true, force: true });
      }
    },
    TIMEOUT_MS,
  );
});

async function measureBothArms(input: {
  readonly acquire: () => Promise<Acquired>;
  readonly modelId: ProviderModelId;
  readonly sessionIds: readonly [ProviderSessionId, ProviderSessionId];
}): Promise<ReadonlyArray<TurnFigures>> {
  const full = await measureArm({ ...input, arm: "full", sessionId: input.sessionIds[0] });
  const held = await measureArm({ ...input, arm: "held", sessionId: input.sessionIds[1] });
  return [...full, ...held];
}

async function measureArm(input: {
  readonly acquire: () => Promise<Acquired>;
  readonly modelId: ProviderModelId;
  readonly sessionId: ProviderSessionId;
  readonly arm: "full" | "held";
}): Promise<ReadonlyArray<TurnFigures>> {
  const ledger = new HeldTurnContext();
  const figures: TurnFigures[] = [];
  let cursor: ProviderResumeCursor | undefined;
  for (const [first, last] of [
    [0, 2],
    [2, 4],
  ] as const) {
    const acquired = await input.acquire();
    try {
      const resumed = cursor !== undefined;
      if (cursor === undefined) {
        const started = await Effect.runPromise(
          acquired.connection.start({
            sessionId: input.sessionId,
            modelId: input.modelId,
            executionPolicy: "plan",
          }),
        );
        cursor = started.resumeCursor;
        expect(cursor).toBeDefined();
      } else {
        await Effect.runPromise(
          acquired.connection.resume({
            sessionId: input.sessionId,
            modelId: input.modelId,
            resumeCursor: cursor,
            executionPolicy: "plan",
          }),
        );
      }
      for (let turn = first; turn < last; turn += 1) {
        // The turn runners pass `resumed` whenever the session already has a
        // recorded resume cursor, which every turn after the first does, even
        // on the native session the first turn opened.
        const context =
          input.arm === "full"
            ? STANDING
            : ledger.forTurn({ sessionId: input.sessionId, resumed: turn > 0, context: STANDING })
                .context;
        figures.push({
          arm: input.arm,
          turn: turn + 1,
          resumed,
          standingCharactersSent: context.reduce((sum, block) => sum + block.text.length, 0),
          ...(await runTurn(
            acquired.connection,
            input.sessionId,
            PROMPTS[turn] ?? "",
            context,
            ledger,
          )),
        });
      }
      await Effect.runPromise(acquired.connection.stop(input.sessionId));
    } finally {
      await acquired.close();
    }
  }
  return figures;
}

async function runTurn(
  connection: ProviderConnection,
  sessionId: ProviderSessionId,
  prompt: string,
  context: ReadonlyArray<ProviderContextBlock>,
  ledger: HeldTurnContext,
): Promise<Omit<TurnFigures, "arm" | "turn" | "resumed" | "standingCharactersSent">> {
  const startedAt = performance.now();
  let firstTextAt: number | undefined;
  let usage: Extract<ProviderRuntimeEvent, { readonly kind: "usage" }> | undefined;
  const events = Effect.runPromise(
    Stream.runCollect(
      Stream.unwrapScoped(connection.subscribe).pipe(
        Stream.filter((event) => String(event.sessionId) === String(sessionId)),
        Stream.tap((event) =>
          Effect.sync(() => {
            ledger.observe(event);
            if (event.kind === "text-delta" && firstTextAt === undefined) {
              firstTextAt = performance.now();
            }
            if (event.kind === "usage") usage = event;
          }),
        ),
        Stream.takeUntil(
          (event) =>
            event.kind === "completed" || event.kind === "failed" || event.kind === "interrupted",
        ),
      ),
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  await Effect.runPromise(
    connection.send({ sessionId, prompt, context: [...context], attachments: [], tools: [] }),
  );
  const collected = [...(await events)];
  expect(collected.at(-1)?.kind).toBe("completed");
  expect(usage).toBeDefined();
  return {
    firstTextMs: firstTextAt === undefined ? undefined : Math.round(firstTextAt - startedAt),
    turnMs: Math.round(performance.now() - startedAt),
    inputTokens: usage?.inputTokens,
    cacheReadInputTokens: usage?.cacheReadInputTokens,
    cacheWriteInputTokens: usage?.cacheWriteInputTokens,
  };
}

function report(provider: string, figures: ReadonlyArray<TurnFigures>): void {
  const rows = figures.map((row) => {
    const read = row.cacheReadInputTokens;
    const hit =
      row.inputTokens === undefined || read === undefined || row.inputTokens === 0
        ? "unreported"
        : `${((read / row.inputTokens) * 100).toFixed(1)}%`;
    const uncached =
      row.inputTokens === undefined || read === undefined
        ? "unreported"
        : String(row.inputTokens - read - (row.cacheWriteInputTokens ?? 0));
    return [
      row.arm,
      String(row.turn),
      row.resumed ? "yes" : "no",
      row.firstTextMs === undefined ? "none" : String(row.firstTextMs),
      String(row.turnMs),
      row.inputTokens === undefined ? "unreported" : String(row.inputTokens),
      uncached,
      hit,
      String(row.standingCharactersSent),
    ].join(" | ");
  });
  console.info(
    [
      `${provider} held-context measurement (${new Date().toISOString()})`,
      "arm | turn | resumed | first text ms | turn ms | input | uncached input | cache hit | standing chars sent",
      ...rows,
    ].join("\n"),
  );
}

async function acquire(
  driver: ProviderDriver,
  instanceId: ProviderInstanceId,
  projectRoot: string,
): Promise<Acquired> {
  const scope = await Effect.runPromise(Scope.make());
  const connection = await Effect.runPromise(
    driver
      .acquire({ instanceId, projectRoot, mode: "code" })
      .pipe(Effect.provideService(Scope.Scope, scope)),
  );
  return { connection, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}

async function findExecutable(name: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, name);
    try {
      await access(candidate);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Continue through the inherited PATH without invoking a shell.
    }
  }
  return undefined;
}
