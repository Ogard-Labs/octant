import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  decodeCanvasActor,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderObservedState,
  decodeProviderRuntimeEvent,
  decodeWindowId,
  UtcTimestamp,
  type CanvasDefinition,
  type CanvasPresentation,
  type ChatSettings,
  type ProviderProbeResult,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { decodeCanvasBlock, type CanvasDesignBlock } from "@octant/contracts/canvas";
import { cartPrototypeExampleBlock, searchSpecExampleBlock } from "@octant/domain";
import { Effect, Queue, Schema, Stream } from "effect";
import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { CanvasEventStore } from "../apps/server/src/canvas/canvasEventStore";
import { CanvasService } from "../apps/server/src/canvas/canvasService";
import { ChatService } from "../apps/server/src/chat/chatService";
import { ResearchRouter } from "../apps/server/src/chat/research/researchRouter";
import { ThreadWorkService } from "../apps/server/src/chat/threadWorkService";
import { ContextHarnessService } from "../apps/server/src/context/contextHarnessService";
import { makeProviderCapacityScheduler } from "../apps/server/src/context/contextRuntime";
import { CHAT_SETTINGS_AGGREGATE_ID } from "../apps/server/src/persistence/chatProjection";
import {
  Persistence,
  makePersistenceLive,
  type PersistenceService,
} from "../apps/server/src/persistence/persistenceService";
import { ProjectService } from "../apps/server/src/projectService";
import { OCTANT_LOCAL_ACTOR_ID } from "../apps/server/src/shellService";

/**
 * Seeds one scratch data directory with a Chat Project and, for each requested
 * fixture, a Chat thread that holds one settled turn and the Canvas that turn
 * left behind. Everything goes through the host's own services and journal, so a
 * rendered check that needs a finished turn can run without a provider.
 *
 * The only thing standing in for the host is the provider connection: a scripted
 * driver that answers the one prompt and completes, the same shape of double the
 * server's own lifecycle tests drive the real Chat service with. It opens no
 * socket and spawns no process.
 */

export const CANVAS_FIXTURE_NAMES = [
  "document",
  "static-design",
  "running-design-document",
  "running-design-phone",
] as const;
export type CanvasFixtureName = (typeof CANVAS_FIXTURE_NAMES)[number];

/** Written first, so a directory this script began is recognisable even if it stopped midway. */
export const SEED_MARKER_FILE = "octant-canvas-fixtures.json";

export type SeedRefusalReason =
  | "relative-data-directory"
  | "protected-data-directory"
  | "unrecognised-data-directory"
  | "unknown-fixture";

export type SeedOutcome =
  | {
      readonly status: "seeded";
      readonly dataDirectory: string;
      readonly projectId: string;
      readonly threads: ReadonlyArray<SeededThread>;
      readonly alreadySeeded: ReadonlyArray<CanvasFixtureName>;
    }
  | {
      readonly status: "refused";
      readonly reason: SeedRefusalReason;
      readonly message: string;
    };

export interface SeededThread {
  readonly fixture: CanvasFixtureName;
  readonly threadId: string;
  readonly canvasId: string;
  /** Where the thread draws the Canvas: inline in the transcript, or as a row that expands. */
  readonly presentation: CanvasPresentation;
}

export interface SeedCanvasFixturesInput {
  readonly dataDirectory: string;
  readonly fixtures?: ReadonlyArray<string>;
  /** Directories no seed may touch, beyond the host's default data directory. */
  readonly protectedDirectories?: ReadonlyArray<string>;
}

interface SeedMarker {
  readonly kind: "octant-canvas-fixtures";
  readonly projectId: string | null;
  readonly fixtures: ReadonlyArray<{
    readonly fixture: CanvasFixtureName;
    readonly threadId: string;
  }>;
}

interface CanvasFixture {
  readonly title: string;
  readonly prompt: string;
  readonly reply: string;
  readonly presentation: CanvasPresentation;
  readonly blocks: ReadonlyArray<CanvasDefinition["blocks"][number]>;
}

const FIXTURE_PROVIDER_INSTANCE = "5eed0000-0000-4000-8000-000000000001";
const FIXTURE_MODEL = "octant-fixture-model";
const PROJECT_NAME = "Canvas fixtures";

const noAuthority = {
  filesystem: false,
  shell: false,
  git: false,
  network: false,
  tools: false,
  subagents: false,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
} as const;

function designBlock(value: unknown): CanvasDesignBlock {
  const block = decodeCanvasBlock(value);
  if (block.kind !== "design") throw new Error("Fixture design did not decode as a design.");
  return block;
}

const runningDocumentDesign = designBlock({
  ...cartPrototypeExampleBlock,
  blockId: "cart-prototype-document",
  title: "Cart at document size",
  size: "document",
});

/**
 * An agent may only ask for an inline Canvas made of reading blocks or one
 * document-size design that runs nothing; a prototype that runs is always drawn
 * as a row the person expands and starts. The fixtures keep that boundary, so
 * the seeded thread draws what a real turn would have drawn.
 */
const FIXTURES: Readonly<Record<CanvasFixtureName, CanvasFixture>> = {
  document: {
    title: "Weekly signups brief",
    prompt: "Summarise this week's signups as a short brief.",
    reply: "I wrote the brief as a Canvas, shown just below.",
    presentation: "inline",
    blocks: [
      { blockId: "intro", schemaVersion: 1, kind: "heading", level: 2, text: "Signups this week" },
      {
        blockId: "signups",
        schemaVersion: 1,
        kind: "metric",
        label: "New signups",
        value: 1284,
        delta: 0.12,
      },
      {
        blockId: "summary",
        schemaVersion: 1,
        kind: "rich-text",
        text: "Signups grew for the third week running. Most of the lift came from the referral page.",
      },
      {
        blockId: "sources",
        schemaVersion: 1,
        kind: "table",
        columns: [
          { id: "channel", label: "Channel", type: "text" },
          { id: "signups", label: "Signups", type: "number" },
        ],
        rows: [
          ["Referral page", 612],
          ["Search", 431],
          ["Direct", 241],
        ],
      },
      {
        blockId: "watch",
        schemaVersion: 1,
        kind: "callout",
        tone: "info",
        title: "Worth watching",
        text: "Direct signups are flat. Check whether the new landing page changed the funnel.",
      },
    ].map((block) => decodeCanvasBlock(block)),
  },
  "static-design": {
    title: "Search ranking spec",
    prompt: "Draft the search ranking spec as a page I can read.",
    reply: "The spec is a document-size design, shown just below.",
    presentation: "inline",
    blocks: [searchSpecExampleBlock],
  },
  "running-design-document": {
    title: "Cart prototype (document size)",
    prompt: "Make the cart a prototype I can click through.",
    reply: "The prototype is ready. Expand it in the thread and press Run to start it.",
    presentation: "sidebar",
    blocks: [runningDocumentDesign],
  },
  "running-design-phone": {
    title: "Cart prototype (phone size)",
    prompt: "Make the cart a phone prototype I can click through.",
    reply: "The phone prototype is ready. Expand it in the thread and press Run to start it.",
    presentation: "sidebar",
    blocks: [cartPrototypeExampleBlock],
  },
};

function isFixtureName(value: string): value is CanvasFixtureName {
  return (CANVAS_FIXTURE_NAMES as ReadonlyArray<string>).includes(value);
}

/**
 * The nearest existing ancestor resolved through symlinks plus the path that
 * does not exist yet, so a directory that is not created yet is still judged
 * against where it would really land.
 */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const missing: Array<string> = [];
  let current = absolute;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return absolute;
    missing.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  return join(realpathSync(current), ...missing);
}

function isInside(directory: string, candidate: string): boolean {
  const path = relative(directory, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** Where the host keeps its data when nothing overrides it, without creating it. */
function defaultDataDirectory(environment: Readonly<Record<string, string | undefined>>): string {
  const home = homedir();
  if (process.platform === "darwin") return join(home, "Library", "Application Support", "Octant");
  const dataHome = environment.XDG_DATA_HOME;
  return join(
    dataHome !== undefined && isAbsolute(dataHome) ? dataHome : join(home, ".local", "share"),
    "octant",
  );
}

function readMarker(dataDirectory: string): SeedMarker | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dataDirectory, SEED_MARKER_FILE), "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "kind" in parsed &&
      parsed.kind === "octant-canvas-fixtures" &&
      "fixtures" in parsed &&
      Array.isArray(parsed.fixtures)
    ) {
      const fixtures = parsed.fixtures.filter(
        (entry): entry is SeedMarker["fixtures"][number] =>
          typeof entry === "object" &&
          entry !== null &&
          "fixture" in entry &&
          typeof entry.fixture === "string" &&
          isFixtureName(entry.fixture) &&
          "threadId" in entry &&
          typeof entry.threadId === "string",
      );
      const projectId = "projectId" in parsed ? parsed.projectId : null;
      return {
        kind: "octant-canvas-fixtures",
        projectId: typeof projectId === "string" ? projectId : null,
        fixtures,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function judgeDataDirectory(input: {
  readonly dataDirectory: string;
  readonly protectedDirectories: ReadonlyArray<string>;
}):
  | {
      readonly status: "ok";
      readonly dataDirectory: string;
      readonly marker: SeedMarker | undefined;
    }
  | { readonly status: "refused"; readonly reason: SeedRefusalReason; readonly message: string } {
  if (!isAbsolute(input.dataDirectory)) {
    return {
      status: "refused",
      reason: "relative-data-directory",
      message: "Pass an absolute data directory; a scratch directory is never guessed.",
    };
  }
  const dataDirectory = canonicalPath(input.dataDirectory);
  for (const protectedDirectory of input.protectedDirectories) {
    const protectedPath = canonicalPath(protectedDirectory);
    if (isInside(protectedPath, dataDirectory) || isInside(dataDirectory, protectedPath)) {
      return {
        status: "refused",
        reason: "protected-data-directory",
        message: "That directory is, contains, or sits inside a real Octant data directory.",
      };
    }
  }
  if (!existsSync(dataDirectory)) return { status: "ok", dataDirectory, marker: undefined };
  if (!lstatSync(dataDirectory).isDirectory()) {
    return {
      status: "refused",
      reason: "unrecognised-data-directory",
      message: "That path exists and is not a directory.",
    };
  }
  if (readdirSync(dataDirectory).length === 0) {
    return { status: "ok", dataDirectory, marker: undefined };
  }
  const marker = readMarker(dataDirectory);
  if (marker === undefined) {
    return {
      status: "refused",
      reason: "unrecognised-data-directory",
      message: "That directory is not empty and was not seeded by this script.",
    };
  }
  return { status: "ok", dataDirectory, marker };
}

/**
 * Hands out times a minute in the past, one tick apart, so the turn is always
 * accepted before the Canvas it produced and nothing is dated in the future.
 */
function makeClock(): () => string {
  let next = Date.now() - 10 * 60_000;
  return () => {
    next += 100;
    return new Date(next).toISOString();
  };
}

function fixtureProbe(observedAt: string): ProviderProbeResult {
  return decodeProviderObservedState({
    instanceId: decodeProviderInstanceId(FIXTURE_PROVIDER_INSTANCE),
    readiness: "ready",
    processState: "running",
    models: [
      {
        id: FIXTURE_MODEL,
        displayName: "Octant fixture model",
        contextLimit: 8_000,
        reasoning: "unsupported",
        inputModalities: ["text"],
        options: [],
        source: "discovered",
        verification: "verified",
      },
    ],
    capabilities: {
      streaming: "supported",
      resume: "unsupported",
      interruption: "unsupported",
      approvals: "unsupported",
      userQuestions: "unsupported",
      reasoning: "unsupported",
      usage: "unsupported",
      toolActivity: "unsupported",
      fileChanges: "unsupported",
      diffs: "unsupported",
      taskProgress: "unsupported",
      nativeChildAgents: "unsupported",
      harnessAutoReview: "unsupported",
      nativeAttachments: "unsupported",
      nativeWebResearch: "unsupported",
      appManagedTools: "unsupported",
      citations: "unsupported",
    },
    observedAt,
  });
}

/** Answers each prompt with the reply the current fixture set, then completes the turn. */
function scriptedDriver(input: {
  readonly reply: () => string;
  readonly clock: () => string;
}): ProviderDriver {
  const instanceId = decodeProviderInstanceId(FIXTURE_PROVIDER_INSTANCE);
  return {
    kind: "openai-compatible",
    probe: () => Effect.sync(() => fixtureProbe(input.clock())),
    acquire: () => {
      const events = Effect.runSync(Queue.unbounded<ProviderRuntimeEvent>());
      let sequence = 0;
      const emit = (
        sessionId: string,
        event: {
          readonly kind: string;
          readonly text?: string;
          readonly inputTokens?: number;
          readonly outputTokens?: number;
        },
      ) =>
        Queue.offer(
          events,
          decodeProviderRuntimeEvent({
            instanceId,
            sessionId,
            sequence: ++sequence,
            correlationId: randomUUID(),
            occurredAt: input.clock(),
            ...event,
          }),
        );
      return Effect.succeed({
        subscribe: Effect.succeed(Stream.fromQueue(events)),
        start: (session) => Effect.succeed({ sessionId: session.sessionId }),
        resume: (session) => Effect.succeed({ sessionId: session.sessionId }),
        send: (turn) =>
          Effect.gen(function* () {
            yield* emit(turn.sessionId, { kind: "text-delta", text: input.reply() });
            // A turn that reports no usage leaves its capacity reservation
            // ambiguous, which would queue the next seeded turn behind it.
            yield* emit(turn.sessionId, { kind: "usage", inputTokens: 24, outputTokens: 16 });
            yield* emit(turn.sessionId, { kind: "completed" });
          }),
        interrupt: () => Effect.void,
        stop: () => Effect.void,
        answerApproval: () => Effect.void,
        answerUserInput: () => Effect.void,
        answerTool: () => Effect.void,
      });
    },
  };
}

const decodeUtcTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

async function settled(read: () => string | undefined): Promise<string> {
  const startedAt = Date.now();
  for (;;) {
    const outcome = read();
    if (outcome !== undefined && outcome !== "queued" && outcome !== "streaming") return outcome;
    if (Date.now() - startedAt > 10_000) throw new Error("The seeded turn did not settle.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

async function seedInto(input: {
  readonly persistence: PersistenceService;
  readonly dataDirectory: string;
  readonly fixtures: ReadonlyArray<CanvasFixtureName>;
  readonly marker: SeedMarker;
}): Promise<{
  readonly projectId: string;
  readonly threads: ReadonlyArray<SeededThread>;
}> {
  const { persistence } = input;
  const clock = makeClock();
  const uuid = randomUUID;

  if (persistence.readChatSettings()?.settings.defaultProviderInstanceId === undefined) {
    const settings = {
      defaultProviderInstanceId: decodeProviderInstanceId(FIXTURE_PROVIDER_INSTANCE),
      defaultModelId: decodeProviderModelId(FIXTURE_MODEL),
      defaultResearchEnabled: false,
      defaultResearchRouting: "automatic",
      defaultPersonalityInstructions: "Be concise.",
      version: 1,
      updatedAt: clock(),
    } as ChatSettings;
    persistence.journal.append({
      aggregate: { aggregateType: "chat-settings", aggregateId: CHAT_SETTINGS_AGGREGATE_ID },
      expectedVersion: 0,
      events: [
        {
          eventId: uuid(),
          eventName: "chat.settings-updated@1",
          eventVersion: 1,
          correlationId: uuid(),
          actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
          occurredAt: clock(),
          payload: { kind: "settings-updated", settings },
        },
      ],
    });
  }

  const projects = new ProjectService({
    persistence,
    bindingReceiptStore: {
      consume: () => {
        throw new Error("Seeding binds no folder.");
      },
    },
    projectRootPort: {
      validate: async () => {
        throw new Error("Seeding binds no folder.");
      },
    },
    uuid,
    clock,
  });
  let projectId = input.marker.projectId;
  if (projectId === null || persistence.readProject(decodeProjectId(projectId)) === undefined) {
    projectId = uuid();
    await projects.executeProject(decodeWindowId(uuid()), {
      kind: "create-chat-project",
      projectId,
      expectedVersion: 0,
      name: PROJECT_NAME,
      hostId: "local",
    });
  }
  const project = persistence.readProject(decodeProjectId(projectId));
  if (project === undefined || project.type !== "chat" || project.lifecycle !== "active") {
    throw new Error("The seeded Chat Project is not available.");
  }

  let reply = "";
  const driver = scriptedDriver({ reply: () => reply, clock });
  const contextHarness = new ContextHarnessService({ persistence, uuid, clock });
  const chat = new ChatService({
    persistence,
    dataDirectory: input.dataDirectory,
    uuid,
    clock,
    threadWork: new ThreadWorkService({ persistence, uuid, clock }),
    driver: () => driver,
    contextHarness,
    capacityScheduler: makeProviderCapacityScheduler({
      now: () => Date.now(),
      random: () => 0.5,
      maxRetryJitterMs: 0,
      ambiguousReservationTtlMs: 60_000,
    }),
    researchRouter: new ResearchRouter({
      searxngClient: {
        search: async () => {
          throw new Error("Seeding makes no network calls.");
        },
      },
      providerNativeExecute: async () => {
        throw new Error("Seeding makes no network calls.");
      },
    }),
    turnTimeoutMs: 10_000,
  });

  const canvases = new CanvasService(
    {
      projection: persistence.canvasProjection,
      eventStore: new CanvasEventStore({
        journal: persistence.journal,
        uuid,
        actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      }),
      uuid,
      clock: () => decodeUtcTimestamp(clock()),
      providerInstanceId: decodeProviderInstanceId(FIXTURE_PROVIDER_INSTANCE),
      modelId: decodeProviderModelId(FIXTURE_MODEL),
    },
    // Seeding only creates; nothing here reads a Canvas back through the service.
    { authorize: () => false },
  );

  const marker: { projectId: string; fixtures: Array<SeedMarker["fixtures"][number]> } = {
    projectId,
    fixtures: [...input.marker.fixtures],
  };
  const threads: Array<SeededThread> = [];
  for (const name of input.fixtures) {
    const fixture = FIXTURES[name];
    const created = await chat.execute({
      kind: "create-chat-thread",
      hostId: "local",
      title: fixture.title,
      projectId,
    });
    if (created.kind !== "thread-created") throw new Error("Expected a created Chat thread.");
    reply = fixture.reply;
    await chat.execute({
      kind: "send-chat-turn",
      threadId: created.thread.id,
      expectedVersion: created.thread.version,
      prompt: fixture.prompt,
    });
    const outcome = await settled(
      () => chat.read(created.thread.id).turns[0]?.attempts[0]?.outcome,
    );
    if (outcome !== "completed") throw new Error(`The seeded turn ended as ${outcome}.`);

    const threadId = String(created.thread.id);
    const workspace = { kind: "chat-virtual", projectId: decodeProjectId(projectId) } as const;
    const result = canvases.create(
      {
        schemaVersion: 1,
        kind: "canvas-create",
        requestId: uuid(),
        intent: "blank",
        hostId: "local",
        mode: "chat",
        workspace,
        originThreadId: threadId,
        title: fixture.title,
        sourceManifest: [],
        requestedAuthority: noAuthority,
      },
      { mode: "chat", projectId, hostId: "local", workspace, originThreadId: threadId },
      { id: projectId, type: "chat", lifecycle: "active" },
      fixture.blocks,
      decodeCanvasActor({ kind: "agent", actorId: uuid() }),
      fixture.presentation,
    );
    if (result.kind !== "accepted") {
      throw new Error(`The Canvas for ${name} was refused: ${result.message}`);
    }
    threads.push({
      fixture: name,
      threadId,
      canvasId: String(result.card.canvasId),
      presentation: result.card.presentation ?? "sidebar",
    });
    marker.fixtures.push({ fixture: name, threadId });
    await writeMarker(input.dataDirectory, marker);
  }
  return { projectId, threads };
}

async function writeMarker(
  dataDirectory: string,
  marker: { readonly projectId: string | null; readonly fixtures: SeedMarker["fixtures"] },
): Promise<void> {
  const body: SeedMarker = { kind: "octant-canvas-fixtures", ...marker };
  await writeFile(join(dataDirectory, SEED_MARKER_FILE), `${JSON.stringify(body, null, 2)}\n`);
}

export async function seedCanvasFixtures(input: SeedCanvasFixturesInput): Promise<SeedOutcome> {
  const requested = input.fixtures ?? CANVAS_FIXTURE_NAMES;
  const unknown = requested.find((name) => !isFixtureName(name));
  if (unknown !== undefined) {
    return {
      status: "refused",
      reason: "unknown-fixture",
      message: `Unknown fixture "${unknown}". Choose from: ${CANVAS_FIXTURE_NAMES.join(", ")}.`,
    };
  }
  const fixtures = [...new Set(requested.filter(isFixtureName))];
  const environmentDirectory = process.env.OCTANT_DATA_DIR;
  const judged = judgeDataDirectory({
    dataDirectory: input.dataDirectory,
    protectedDirectories: [
      defaultDataDirectory(process.env),
      ...(environmentDirectory === undefined ? [] : [environmentDirectory]),
      ...(input.protectedDirectories ?? []),
    ],
  });
  if (judged.status === "refused") return judged;

  const marker: SeedMarker = judged.marker ?? {
    kind: "octant-canvas-fixtures",
    projectId: null,
    fixtures: [],
  };
  const done = new Set(marker.fixtures.map((entry) => entry.fixture));
  const alreadySeeded = fixtures.filter((name) => done.has(name));
  const pending = fixtures.filter((name) => !done.has(name));

  mkdirSync(judged.dataDirectory, { recursive: true, mode: 0o700 });
  if (judged.marker === undefined) await writeMarker(judged.dataDirectory, marker);

  const seeded = await Effect.runPromise(
    Effect.flatMap(Persistence, (persistence) =>
      Effect.tryPromise(() =>
        seedInto({
          persistence,
          dataDirectory: judged.dataDirectory,
          fixtures: pending,
          marker,
        }),
      ),
    ).pipe(
      Effect.provide(
        makePersistenceLive({ environment: { OCTANT_DATA_DIR: judged.dataDirectory } }),
      ),
    ),
  );
  return {
    status: "seeded",
    dataDirectory: judged.dataDirectory,
    projectId: seeded.projectId,
    threads: seeded.threads,
    alreadySeeded,
  };
}

async function runCli(argv: ReadonlyArray<string>): Promise<number> {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        "data-dir": { type: "string" },
        fixture: { type: "string", multiple: true },
      },
      strict: true,
    }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Could not read the arguments.");
    return 2;
  }
  const dataDirectory = values["data-dir"];
  if (dataDirectory === undefined) {
    console.error(
      "Usage: bun run seed:canvas-fixtures --data-dir <absolute scratch directory> [--fixture <name>]...\n" +
        `Fixtures: ${CANVAS_FIXTURE_NAMES.join(", ")} (all by default).`,
    );
    return 2;
  }
  const outcome = await seedCanvasFixtures({
    dataDirectory,
    ...(values.fixture === undefined ? {} : { fixtures: values.fixture }),
  });
  if (outcome.status === "refused") {
    console.error(`Refused: ${outcome.message}`);
    return 1;
  }
  console.log(`Seeded ${outcome.dataDirectory}`);
  console.log(`Chat Project ${PROJECT_NAME}: ${outcome.projectId}`);
  for (const thread of outcome.threads) {
    console.log(
      `  ${thread.fixture}: thread ${thread.threadId}, Canvas ${thread.canvasId} (${thread.presentation})`,
    );
  }
  for (const name of outcome.alreadySeeded) console.log(`  ${name}: already seeded, left as is`);
  console.log(
    `Open it with: OCTANT_DATA_DIR=${outcome.dataDirectory} bun run packages/cli/src/bin.ts server run`,
  );
  return 0;
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
