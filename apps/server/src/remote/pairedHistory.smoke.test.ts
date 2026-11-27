import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { connect as connectTcp, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import {
  createInMemoryDeviceKeyStore,
  createRemoteProductFetch,
  createRemoteSessionBridge,
  loadMobileChatThread,
  loadMobileCodeConversation,
  loadMobileWorkTranscript,
  subscribeMobileChatEvents,
  type MobileRemoteTransport,
  openAppPairingCode,
  openPairingTicket,
} from "@octant/client-runtime";
import { testOnlyListenerTls } from "@octant/client-runtime/remote-listener-tls-node";
import { createChatClient } from "@octant/client-runtime/chat-client";
import { createCodeClient } from "@octant/client-runtime/code-client";
import { createWorkTurnClient } from "@octant/client-runtime/work-turn-client";
import { WorkTurnLiveStore } from "../work/workTurnLiveStore";
import { CodeEvidenceStore } from "../code/codeEvidenceStore";
import { CodeOperationEventStore } from "../code/codeOperationEventStore";
import {
  MAX_CODE_EVIDENCE_BATCH_ITEMS,
  MAX_WORK_TRANSCRIPT_TURNS,
  decodeChatThreadId,
  decodeCodeOperationId,
  decodeCodeThreadId,
  decodeEventActor,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderSessionId,
  decodeWorkThreadId,
  type CodeConversationTurn,
} from "@octant/contracts";
import { resolvePrivateListenerHostIdentity } from "./privateListenerHostIdentity";
import { buildPairingCode } from "@octant/domain";
import { nodeServe } from "../nodeServe";
import { writeChatContent } from "../persistence/chatProjection";
import {
  makePersistenceLive,
  Persistence,
  type PersistenceService,
} from "../persistence/persistenceService";
import { startOctantServer, type ServeOptions } from "../server";
import { createSelfMadeListenerCertificateStore } from "./selfMadeListenerCertificate";

const address = "100.101.102.103";
const localOrigin = "http://127.0.0.1";
const build = "0.1.0";
const pageSize = 30;
// Encoded response-body bytes. Baselines for a 30-row window are about 82 KB
// in Chat and 133 KB in Work. Code's 20 rows plus evidence and the active turn
// replay are about 54 KB. Window budgets allow room for envelope growth while
// rejecting twice the measured payload. The assertions also pin row identities,
// frame cursors, and request counts so fewer rows and smaller duplicates fail.
const chatWindowBytes = 100_000;
const workWindowBytes = 160_000;
const codeWindowBytes = 65_000;
const desktopBridgeSecret = "disposable-history-host";
const threadId = decodeChatThreadId("83000000-0000-4000-8000-000000000001");
const actor = decodeEventActor({ kind: "system", actorId: randomUUID() });
const aggregate = { aggregateType: "chat-thread", aggregateId: threadId };

function chatPrompt(sequence: number) {
  return `Investigation step ${sequence}. ${"Compare the recorded result with the expected state and list the outstanding questions. ".repeat(12).trim()}`;
}

function projectPrompt(sequence: number) {
  return `Investigation step ${sequence}. ${"Describe expected behavior and compare it with the recorded observations. ".repeat(12).trim()}`;
}

function projectReply(sequence: number) {
  return `Step ${sequence}. ${"The recorded observations match the expected behavior. ".repeat(15).trim()}`;
}

function seedChat(persistence: PersistenceService) {
  const now = new Date().toISOString();
  const providerInstanceId = decodeProviderInstanceId(randomUUID());
  const pending = (eventName: string, payload: object) => ({
    eventId: randomUUID(),
    eventName,
    eventVersion: 1,
    correlationId: randomUUID(),
    actor,
    occurredAt: now,
    payload,
  });
  persistence.journal.append({
    aggregate,
    expectedVersion: 0,
    events: [
      pending("chat.thread-created@1", {
        kind: "thread-created",
        thread: {
          id: threadId,
          title: "Synthetic investigation",
          lifecycle: "active",
          providerInstanceId,
          modelId: decodeProviderModelId("fixture-model"),
          researchEnabled: false,
          researchRouting: "automatic",
          personalityInstructions: "Summarize the investigation.",
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      }),
    ],
  });
  let sequence = 0;
  return (count: number) => {
    const committedSequences = [];
    for (let index = 0; index < count; index++) {
      sequence++;
      const body = chatPrompt(sequence);
      const contentId = randomUUID();
      const digest = createHash("sha256").update(body).digest("hex");
      const content = { contentId, digest, byteLength: Buffer.byteLength(body) };
      const committed = persistence.journal.append(
        {
          aggregate,
          expectedVersion: sequence,
          events: [
            pending("chat.turn-created@1", {
              kind: "turn-created",
              turn: {
                id: randomUUID(),
                threadId,
                sequence,
                userMessageRef: content,
                attachmentIds: [],
                attempts: [],
                createdAt: now,
              },
            }),
          ],
        },
        {
          beforeEvents(connection) {
            writeChatContent(connection, { ...content, body, threadId, role: "user" });
          },
        },
      );
      committedSequences.push(committed.lastSequence);
    }
    return committedSequences;
  };
}

function seedProjectHistory(persistence: PersistenceService, total: number) {
  const now = new Date().toISOString();
  const workProjectId = randomUUID();
  const codeProjectId = randomUUID();
  const providerInstanceId = decodeProviderInstanceId(randomUUID());
  const bindingRevisionId = randomUUID();
  const providerSessionId = decodeProviderSessionId(randomUUID());
  const work = decodeWorkThreadId(randomUUID());
  const code = decodeCodeThreadId(randomUUID());
  const checkoutId = randomUUID();
  const append = (
    aggregateType: string,
    aggregateId: string,
    expectedVersion: number,
    eventName: string,
    payload: object,
  ) =>
    persistence.journal.append({
      aggregate: { aggregateType, aggregateId },
      expectedVersion,
      events: [
        {
          eventId: randomUUID(),
          eventName,
          eventVersion: 1,
          correlationId: randomUUID(),
          actor,
          occurredAt: now,
          payload,
        },
      ],
    });
  const binding = { canonicalRoot: persistence.dataDirectory };
  for (const [projectId, type] of [
    [workProjectId, "work"],
    [codeProjectId, "code"],
  ] as const) {
    append("project", projectId, 0, "project.created@1", {
      project: {
        id: projectId,
        type,
        name: `Synthetic ${type} project`,
        lifecycle: "active",
        pinned: false,
        rank: "0/1",
        version: 1,
        createdAt: now,
        updatedAt: now,
        ...(type === "code" ? { codeAccessPersistence: "project-default" } : {}),
        binding,
        bindingHistory: [
          {
            revisionId: bindingRevisionId,
            revision: 1,
            currentBinding: binding,
            actor,
            changedAt: now,
          },
        ],
      },
    });
  }
  const thread = {
    title: "Synthetic investigation",
    lifecycle: "active",
    providerInstanceId,
    modelId: decodeProviderModelId("fixture-model"),
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  append("work-thread", work, 0, "work.thread-created@1", {
    kind: "thread-created",
    thread: { ...thread, id: work, projectId: workProjectId },
  });
  append("code-thread", code, 0, "code.thread-created@1", {
    kind: "thread-created",
    thread: {
      ...thread,
      id: code,
      projectId: codeProjectId,
      bindingRevisionId,
      checkoutId,
      repositoryId: `repo_${"a".repeat(64)}`,
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
      deliveryTarget: {
        branchIntent: "feature/investigation",
        remoteName: "origin",
        proposedBaseRepository: "example/project",
        proposedBaseBranch: "main",
        outcomeKind: "opened-pr",
        confirmedAt: now,
      },
    },
  });

  const evidence = new CodeEvidenceStore({ connection: persistence.connection });
  const codeEvents = new CodeOperationEventStore({
    journal: persistence.journal,
    actor,
    clock: () => now,
    uuid: randomUUID,
  });
  const codeOperations = [];
  for (const sequence of sequences(1, total)) {
    const prompt = projectPrompt(sequence);
    const response = projectReply(sequence);
    const requestId = randomUUID();
    const turnId = randomUUID();
    append("work-turn", requestId, 0, "work.turn-accepted@1", {
      kind: "turn-accepted",
      requestId,
      threadId: work,
      turnId,
      projectId: workProjectId,
      authority: {
        hostId: "local",
        projectId: workProjectId,
        bindingRevisionId,
        workingDirectory: ".",
        confinementPosture: "project-root-confined",
        providerInstanceId,
        modelId: thread.modelId,
      },
      providerSessionId,
      prompt,
      capabilities: {
        workspace: "project-backed",
        confinement: "project-root-confined",
        shell: "denied",
        git: "denied",
        worktree: "denied",
        pullRequest: "denied",
        code: "denied",
      },
      acceptedAt: now,
    });
    append("work-turn", requestId, 1, "work.turn-updated@1", {
      kind: "turn-updated",
      requestId,
      threadId: work,
      turnId,
      status: "completed",
      response,
      updatedAt: now,
    });

    const operation = { threadId: code, operationId: decodeCodeOperationId(randomUUID()) };
    codeOperations.push(operation.operationId);
    codeEvents.append({
      ...operation,
      expectedCursor: 0,
      event: {
        kind: "conversation-turn-started",
        providerInstanceId,
        modelId: thread.modelId,
        sessionId: providerSessionId,
        prompt: evidence.put(prompt),
      },
    });
    codeEvents.append({
      ...operation,
      expectedCursor: 1,
      event: {
        kind: "provider-content",
        channel: "message",
        content: evidence.put(response),
      },
    });
    if (sequence < total) {
      codeEvents.append({
        ...operation,
        expectedCursor: 2,
        event: {
          kind: "operation-state",
          state: "completed",
        },
      });
    }
  }
  const activeOperation = codeOperations.at(-1);
  if (activeOperation === undefined) throw new Error("Missing active Code operation");
  const appendCodeReply = (texts: ReadonlyArray<string>) => {
    texts.forEach((text, index) =>
      codeEvents.append({
        threadId: code,
        operationId: activeOperation,
        expectedCursor: index + 2,
        event: { kind: "provider-content", channel: "message", content: evidence.put(text) },
      }),
    );
  };
  return { work, code, codeOperations, activeOperation, appendCodeReply };
}

function sequences(first: number, count: number) {
  return Array.from({ length: count }, (_, index) => first + index);
}

it.each([
  { total: 120, transport: "browser session" },
  { total: 1200, transport: "browser session" },
  { total: 120, transport: "pinned TLS" },
  { total: 1200, transport: "pinned TLS" },
])(
  "bounds paired conversation history with $total turns over $transport",
  // The transfer budgets measure bytes and rows. Allow for building the large journal on shared CI runners.
  { timeout: 120_000 },
  async ({ total, transport }) => {
    const directory = mkdtempSync(join(tmpdir(), "octant-paired-history-"));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const persistence = yield* Persistence;
            const certificate = createSelfMadeListenerCertificateStore({
              dataDirectory: directory,
            }).ensure(address);
            if (certificate.status !== "ready") throw new Error(certificate.code);

            const projectThreads = persistence.journal.transaction(() =>
              seedProjectHistory(persistence, total),
            );
            let localFetch: ServeOptions["fetch"] | undefined;
            let remoteFetch: ServeOptions["fetch"] | undefined;
            let peer = 0;
            const remoteFacts = () =>
              ({
                listenerTrust: "remote",
                sourceClass: "tailscale",
                sourceKey: `paired-history-fixture-${peer}`,
              }) as const;
            const listener =
              transport === "pinned TLS"
                ? yield* Effect.acquireRelease(
                    Effect.promise(() =>
                      nodeServe({
                        hostname: "127.0.0.1",
                        port: 0,
                        tls: certificate.tls,
                        tailnetTls: { ...certificate.tls, serverName: address },
                        listenerTrust: "remote",
                        fetch(request) {
                          if (remoteFetch === undefined) throw new Error("Host did not bind");
                          return remoteFetch(request, remoteFacts());
                        },
                      }),
                    ),
                    (binding) =>
                      Effect.promise(async () => {
                        await binding.stop(true);
                      }),
                  )
                : undefined;
            const port = listener === undefined ? 8443 : Number(listener.url.port);
            const origin = `https://${address}:${port}`;
            const server = yield* startOctantServer({
              hostname: "127.0.0.1",
              port: 0,
              version: build,
              desktopBridgeSecret,
              serve(options) {
                localFetch = options.fetch;
                return { url: new URL(localOrigin), stop() {} };
              },
              remoteServe(options) {
                remoteFetch = options.fetch;
                return { url: new URL(origin), stop() {} };
              },
              remoteListener: {
                config: { hostname: address, port, origin, tls: certificate.tls },
                services: {
                  ...resolvePrivateListenerHostIdentity({
                    dataDirectory: directory,
                    connection: persistence.connection,
                  }),
                  connection: persistence.connection,
                  journal: persistence.journal,
                  serverBuildVersion: build,
                  webAssets: async () => new Response(null, { status: 404 }),
                },
              },
            });
            expect(server.remoteListenerError).toBeUndefined();

            yield* Effect.promise(async () => {
              if (localFetch === undefined || remoteFetch === undefined)
                throw new Error("Host did not bind");
              const dispatchLocal = localFetch;
              const dispatchRemote = remoteFetch;
              const capability = "A".repeat(43);
              const registered = await dispatchLocal(
                new Request(`${localOrigin}/api/desktop/window-authorities`, {
                  method: "POST",
                  headers: { "x-octant-desktop-secret": desktopBridgeSecret },
                  body: JSON.stringify({ windowId: randomUUID(), capability }),
                }),
              );
              expect(registered.ok).toBe(true);
              const admin = (path: string, body: object) =>
                dispatchLocal(
                  new Request(`${localOrigin}/api/desktop/remote/${path}`, {
                    method: "POST",
                    headers: {
                      "content-type": "application/json",
                      "x-octant-desktop-secret": desktopBridgeSecret,
                      "x-octant-window-capability": capability,
                    },
                    body: JSON.stringify(body),
                  }),
                );
              const addTurns = seedChat(persistence);
              persistence.journal.transaction(() => addTurns(total));
              const ticketResponse = await admin("pairing-tickets", { sourceClass: "tailscale" });
              expect(ticketResponse.status).toBe(201);
              const { ticket } = await ticketResponse.json();
              const built = buildPairingCode({
                origin,
                ticketId: ticket.ticketId,
                ticketProof: ticket.ticketProof,
                pin: certificate.tlsPin,
              });
              if (built.status !== "built") throw new Error(built.reason);
              const deviceKeyStore = createInMemoryDeviceKeyStore();
              const dispatchFetch: typeof fetch = Object.assign(
                async (...args: Parameters<typeof fetch>) => {
                  const request = new Request(...args);
                  request.headers.set("host", new URL(origin).host);
                  return await dispatchRemote(request, remoteFacts());
                },
                { preconnect() {} },
              );
              const pinned = (
                trust: Parameters<typeof testOnlyListenerTls.createListenerFetchOver>[0]["trust"],
              ) =>
                testOnlyListenerTls.createListenerFetchOver(
                  { origin, trust },
                  {
                    resolve: async () => [address],
                    dial: () =>
                      new Promise<Socket>((resolve, reject) => {
                        const socket = connectTcp({ host: "127.0.0.1", port });
                        socket.once("error", reject);
                        socket.once("connect", () => {
                          Object.defineProperty(socket, "remoteAddress", { value: address });
                          resolve(socket);
                        });
                      }),
                    handshakeTimeoutMs: 5_000,
                  },
                );
              const pairing = {
                transport: ({ trust }: { trust: Parameters<typeof pinned>[0] }) => ({
                  status: "available" as const,
                  fetch: listener === undefined ? dispatchFetch : pinned(trust),
                }),
                webBuildVersion: build,
                deviceKeyStore,
              };
              const opened =
                listener === undefined
                  ? await openPairingTicket({
                      ...pairing,
                      origin,
                      ticket: { ticketId: ticket.ticketId, ticketProof: ticket.ticketProof },
                      listenerTrust: { kind: "platform" },
                    })
                  : await openAppPairingCode({ ...pairing, code: built.code });
              if (opened.status !== "opened") throw new Error(opened.message);
              const claimed = await opened.claim("History benchmark client");
              if (claimed.status !== "claimed") throw new Error(claimed.message);
              expect(
                (await admin("pairing-requests/approve", { ticketId: ticket.ticketId })).status,
              ).toBe(201);
              const status = await opened.client.pollPairingStatus({
                ticket: opened.ticket,
                claim: claimed.claim,
              });
              if (status.kind !== "approved") throw new Error(`Pairing ${status.kind}`);
              const bridge = createRemoteSessionBridge({
                fetch:
                  listener === undefined ? dispatchFetch : pinned(status.approval.listenerTrust),
                deviceKeyStore,
              });
              const connect = async () => {
                bridge.connect(status.approval);
                await vi.waitFor(() => expect(bridge.getState().kind).toBe("ready"));
              };
              const workHeads = vi.spyOn(WorkTurnLiveStore.prototype, "head");
              try {
                await connect();
                const fetchProduct = createRemoteProductFetch({ bridge });
                const measurements: Array<{
                  requests: number;
                  bytes: number;
                  rows: number;
                  frames?: number;
                  scenario: string;
                }> = [];
                let requests = 0;
                let bytes = 0;
                const meter = async (pendingResponse: Promise<Response>) => {
                  requests++;
                  const response = await pendingResponse;
                  if (response.body === null) return response;
                  return new Response(
                    response.body.pipeThrough(
                      new TransformStream({
                        transform(chunk, stream) {
                          bytes += chunk.byteLength;
                          stream.enqueue(chunk);
                        },
                      }),
                    ),
                    response,
                  );
                };
                const clientOptions = {
                  baseUrl: localOrigin,
                  windowCapability: "",
                  fetch: Object.assign(
                    (...args: Parameters<typeof fetch>) => meter(fetchProduct(...args)),
                    { preconnect() {} },
                  ),
                };
                const mobile: MobileRemoteTransport = {
                  hostId: status.approval.hostId,
                  authenticatedFetch(request) {
                    const connection = bridge.connection();
                    if (connection === undefined) throw new Error("Missing paired connection");
                    return meter(connection.authenticatedFetch(request));
                  },
                };
                const chat = createChatClient(clientOptions);
                const work = createWorkTurnClient(clientOptions);
                const code = createCodeClient({ ...clientOptions, threadEvents: "poll" });
                const record = (
                  scenario: string,
                  rows: number,
                  budget: number,
                  expectedRequests = 1,
                  frames?: number,
                ) => {
                  expect(requests).toBe(expectedRequests);
                  expect(bytes).toBeLessThanOrEqual(budget);
                  measurements.push({
                    scenario,
                    requests,
                    bytes,
                    rows,
                    ...(frames === undefined ? {} : { frames }),
                  });
                  requests = 0;
                  bytes = 0;
                };
                const newest = await chat.threadWindow(threadId, { limit: pageSize });
                expect(newest).toMatchObject({ hasEarlier: true, hasLater: false });
                const verifyChatContents = (view: typeof newest.view, first: number) => {
                  const bodies = new Map(
                    view.contents.map((content) => [String(content.contentId), content.body]),
                  );
                  expect(
                    view.turns.map((turn) => bodies.get(String(turn.userMessageRef.contentId))),
                  ).toEqual(sequences(first, pageSize).map(chatPrompt));
                };
                expect(newest.view.turns.map((turn) => turn.sequence)).toEqual(
                  sequences(total - pageSize + 1, pageSize),
                );
                verifyChatContents(newest.view, total - pageSize + 1);
                record("Chat cold open", newest.view.turns.length, chatWindowBytes);
                const before = newest.view.turns[0]?.id;
                if (before === undefined) throw new Error("Missing previous-page anchor");
                const older = await chat.threadWindow(threadId, { limit: pageSize, before });
                expect(older).toMatchObject({ hasEarlier: true, hasLater: true });
                expect(older.view.turns.map((turn) => turn.sequence)).toEqual(
                  sequences(total - 2 * pageSize + 1, pageSize),
                );
                verifyChatContents(older.view, total - 2 * pageSize + 1);
                record("Chat previous page", older.view.turns.length, chatWindowBytes);
                const newestWork = await work.transcriptWindow(projectThreads.work, {
                  limit: pageSize,
                });
                expect(newestWork).toMatchObject({ hasEarlier: true, hasLater: false });
                const verifyWorkContents = (
                  rows: typeof newestWork.turns,
                  first: number,
                  count: number,
                ) => {
                  expect(rows.map(({ prompt, response }) => [prompt, response])).toEqual(
                    sequences(first, count).map((sequence) => [
                      projectPrompt(sequence),
                      projectReply(sequence),
                    ]),
                  );
                };
                verifyWorkContents(newestWork.turns, total - pageSize + 1, pageSize);
                record("Work cold open", newestWork.turns.length, workWindowBytes);
                const liveWork = workHeads.mock.contexts.at(-1);
                if (!(liveWork instanceof WorkTurnLiveStore))
                  throw new Error("Missing Work live feed");
                const liveRequest = newestWork.turns.at(-1)?.requestId;
                if (liveRequest === undefined) throw new Error("Missing Work live request");
                const beforeWork = newestWork.turns[0]?.requestId;
                if (beforeWork === undefined) throw new Error("Missing Work page anchor");
                const olderWork = await work.transcriptWindow(projectThreads.work, {
                  limit: pageSize,
                  before: beforeWork,
                });
                expect(olderWork).toMatchObject({ hasEarlier: true, hasLater: true });
                verifyWorkContents(olderWork.turns, total - 2 * pageSize + 1, pageSize);
                record("Work previous page", olderWork.turns.length, workWindowBytes);

                const codePageSize = 20;
                const newestCode = await code.conversationWindow?.(projectThreads.code, {
                  limit: codePageSize,
                });
                if (newestCode === undefined) throw new Error("Missing Code window");
                expect(newestCode).toMatchObject({ hasEarlier: true, hasLater: false });
                expect(newestCode.turns.map((turn) => turn.operationId)).toEqual(
                  projectThreads.codeOperations.slice(-codePageSize),
                );
                const verifyCodeContent = async (
                  turns: ReadonlyArray<CodeConversationTurn>,
                  first: number,
                ) => {
                  const items = turns.flatMap((turn) =>
                    [turn.prompt, ...turn.assistant].map((reference) => ({
                      operationId: turn.operationId,
                      contentId: reference.contentId,
                    })),
                  );
                  const contents = new Map<string, string>();
                  for (
                    let start = 0;
                    start < items.length;
                    start += MAX_CODE_EVIDENCE_BATCH_ITEMS
                  ) {
                    const batch = await code.operationContents?.({
                      threadId: projectThreads.code,
                      items: items.slice(start, start + MAX_CODE_EVIDENCE_BATCH_ITEMS),
                    });
                    for (const item of batch?.items ?? []) {
                      contents.set(`${item.operationId}:${item.contentId}`, item.text);
                    }
                  }
                  expect(contents.size).toBe(turns.length * 2);
                  for (const [index, turn] of turns.entries()) {
                    expect(contents.get(`${turn.operationId}:${turn.prompt.contentId}`)).toBe(
                      projectPrompt(first + index),
                    );
                    expect(
                      turn.assistant.map((ref) =>
                        contents.get(`${turn.operationId}:${ref.contentId}`),
                      ),
                    ).toEqual([projectReply(first + index)]);
                  }
                };
                await verifyCodeContent(newestCode.turns, total - codePageSize + 1);
                const readCodeReplay = async (afterCursor: number) => {
                  const frames = [];
                  for await (const frame of code.subscribeOperation(
                    projectThreads.code,
                    projectThreads.activeOperation,
                    afterCursor,
                    AbortSignal.timeout(5_000),
                  ))
                    frames.push(frame);
                  return frames;
                };
                // This fixture opens on an active Code turn, which the paired
                // client follows by replaying that operation from its start.
                const openingFrames = await readCodeReplay(0);
                expect(openingFrames.map((frame) => frame.cursor)).toEqual([1, 2]);
                expect(openingFrames[1]?.displayText).toBe(projectReply(total));
                record(
                  "Code cold open",
                  newestCode.turns.length,
                  codeWindowBytes,
                  3,
                  openingFrames.length,
                );
                const beforeCode = newestCode.turns[0]?.operationId;
                if (beforeCode === undefined) throw new Error("Missing Code page anchor");
                const olderCode = await code.conversationWindow?.(projectThreads.code, {
                  limit: codePageSize,
                  before: beforeCode,
                });
                if (olderCode === undefined) throw new Error("Missing Code window");
                expect(olderCode).toMatchObject({ hasEarlier: true, hasLater: true });
                expect(olderCode.turns.map((turn) => turn.operationId)).toEqual(
                  projectThreads.codeOperations.slice(-2 * codePageSize, -codePageSize),
                );
                await verifyCodeContent(olderCode.turns, total - 2 * codePageSize + 1);
                record("Code previous page", olderCode.turns.length, codeWindowBytes, 2);
                const fullChat =
                  listener === undefined
                    ? await chat.thread(threadId)
                    : await loadMobileChatThread(mobile, threadId);
                expect(fullChat.turns).toHaveLength(total);
                expect(() =>
                  record("oversized Chat response", fullChat.turns.length, chatWindowBytes),
                ).toThrow(/less than or equal/);
                measurements.push({
                  scenario: "Chat full transcript rejected",
                  requests,
                  bytes,
                  rows: fullChat.turns.length,
                });
                requests = 0;
                bytes = 0;

                // An older Code host answers forward pages until hydration
                // reaches its end. Send those through the same authenticated
                // client and meter, outside the bounded window assertions.
                const compatibilityRows = [];
                let legacyCursor = 0;
                for (;;) {
                  const page = await code.conversation(projectThreads.code, legacyCursor, 50);
                  await verifyCodeContent(page.turns, compatibilityRows.length + 1);
                  compatibilityRows.push(...page.turns.map((turn) => turn.operationId));
                  if (!page.hasMore) break;
                  expect(page.nextCursor).toBeGreaterThan(legacyCursor);
                  legacyCursor = page.nextCursor;
                }
                expect(compatibilityRows).toEqual(projectThreads.codeOperations);
                measurements.push({
                  scenario: "Code compatibility forward hydration",
                  requests,
                  bytes,
                  rows: compatibilityRows.length,
                });
                requests = 0;
                bytes = 0;

                if (listener !== undefined) {
                  const mobileWork = await loadMobileWorkTranscript(mobile, projectThreads.work);
                  verifyWorkContents(
                    mobileWork.turns,
                    total - MAX_WORK_TRANSCRIPT_TURNS + 1,
                    MAX_WORK_TRANSCRIPT_TURNS,
                  );
                  measurements.push({
                    scenario: "Mobile Work transcript (64-row cap)",
                    requests,
                    bytes,
                    rows: mobileWork.turns.length,
                  });
                  requests = 0;
                  bytes = 0;

                  const mobileCode = await loadMobileCodeConversation(mobile, projectThreads.code);
                  expect(mobileCode).toMatchObject({ hasEarlier: true, hasLater: false });
                  expect(mobileCode.turns.map((turn) => turn.operationId)).toEqual(
                    projectThreads.codeOperations.slice(-codePageSize),
                  );
                  expect(
                    mobileCode.turns.map(({ prompt, assistant }) => [prompt, assistant]),
                  ).toEqual(
                    sequences(total - codePageSize + 1, codePageSize).map((sequence) => [
                      projectPrompt(sequence),
                      [projectReply(sequence)],
                    ]),
                  );
                  record("Mobile Code cold open", mobileCode.turns.length, codeWindowBytes, 2);
                  const through = projectThreads.codeOperations.at(-codePageSize - 1);
                  if (through === undefined) throw new Error("Missing Mobile Code page anchor");
                  const olderMobileCode = await loadMobileCodeConversation(
                    mobile,
                    projectThreads.code,
                    { through },
                  );
                  expect(olderMobileCode).toMatchObject({ hasEarlier: true, hasLater: true });
                  expect(olderMobileCode.turns.map((turn) => turn.operationId)).toEqual(
                    projectThreads.codeOperations.slice(-2 * codePageSize, -codePageSize),
                  );
                  expect(
                    olderMobileCode.turns.map(({ prompt, assistant }) => [prompt, assistant]),
                  ).toEqual(
                    sequences(total - 2 * codePageSize + 1, codePageSize).map((sequence) => [
                      projectPrompt(sequence),
                      [projectReply(sequence)],
                    ]),
                  );
                  record(
                    "Mobile Code anchored page",
                    olderMobileCode.turns.length,
                    codeWindowBytes,
                    2,
                  );
                }

                let cursor = newest.view.lastSequence;
                let workCursor = newestWork.liveCursor;
                for (const gap of [0, 3]) {
                  bridge.disconnect();
                  peer++;
                  const committedSequences = addTurns(gap);
                  const missedText = sequences(1, gap).map(
                    (step) => `Missed reply fragment ${step}.`,
                  );
                  projectThreads.appendCodeReply(missedText);
                  for (const text of missedText)
                    liveWork.appendResponse(projectThreads.work, liveRequest, text);
                  await connect();

                  // The live Work stream waits for future frames. A marker
                  // published after the subscription opens delimits its replay.
                  const workSubscription = vi.spyOn(liveWork, "subscribe");
                  const stopWork = new AbortController();
                  const workFrames = [];
                  try {
                    const consume = (async () => {
                      for await (const frame of work.subscribe(
                        projectThreads.work,
                        workCursor,
                        AbortSignal.any([stopWork.signal, AbortSignal.timeout(5_000)]),
                      )) {
                        workFrames.push(frame);
                        if (frame.kind === "response-delta" && frame.text === "Replay boundary.")
                          break;
                      }
                    })();
                    const lastWorkSequence = workCursor + gap + 1;
                    try {
                      await vi.waitFor(() => expect(workSubscription).toHaveBeenCalledTimes(1));
                      liveWork.appendResponse(projectThreads.work, liveRequest, "Replay boundary.");
                      await consume;
                    } finally {
                      stopWork.abort();
                      await consume;
                    }
                    expect(workFrames.map((frame) => frame.sequence)).toEqual(
                      sequences(workCursor + 1, gap + 1),
                    );
                    expect(
                      workFrames.map((frame) =>
                        frame.kind === "response-delta" ? frame.text : frame.kind,
                      ),
                    ).toEqual([...missedText, "Replay boundary."]);
                    workCursor = lastWorkSequence;
                    record(
                      `Work reconnect, gap ${gap} (includes boundary marker)`,
                      workFrames.length,
                      gap === 0 ? 220 : 900,
                    );
                  } finally {
                    workSubscription.mockRestore();
                  }
                  const codeFrames = await readCodeReplay(openingFrames.length);
                  expect(codeFrames.map((frame) => frame.cursor)).toEqual(sequences(3, gap));
                  expect(codeFrames.map((frame) => frame.displayText)).toEqual(missedText);
                  record(`Code reconnect, gap ${gap}`, codeFrames.length, gap === 0 ? 0 : 1_600);
                  const signal = AbortSignal.timeout(12_000);
                  const frames = [];
                  const replay =
                    listener === undefined
                      ? chat.subscribe(threadId, cursor, signal)
                      : subscribeMobileChatEvents({
                          transport: mobile,
                          threadId,
                          afterSequence: cursor,
                          signal,
                        });
                  for await (const frame of replay) frames.push(frame);
                  expect(frames.map((frame) => frame.sequence)).toEqual(committedSequences);
                  cursor = frames.at(-1)?.sequence ?? cursor;
                  record(`Chat reconnect, gap ${gap}`, frames.length, gap === 0 ? 0 : 1_800);
                  if (listener !== undefined) {
                    if (gap > 0) {
                      const refreshed = await loadMobileChatThread(mobile, threadId);
                      expect(refreshed.turns.slice(-gap).map((turn) => turn.sequence)).toEqual(
                        sequences(total + 1, gap),
                      );
                      measurements.push({
                        scenario: "Mobile Chat refresh after replay (full transcript)",
                        requests,
                        bytes,
                        rows: refreshed.turns.length,
                      });
                      requests = 0;
                      bytes = 0;
                    }
                    const refreshedCode = await loadMobileCodeConversation(
                      mobile,
                      projectThreads.code,
                    );
                    expect(refreshedCode.turns.map((turn) => turn.operationId)).toEqual(
                      projectThreads.codeOperations.slice(-codePageSize),
                    );
                    expect(refreshedCode.turns.at(-1)?.assistant.slice(1)).toEqual(missedText);
                    record(
                      `Mobile Code refresh, gap ${gap}`,
                      refreshedCode.turns.length,
                      codeWindowBytes,
                      2,
                    );
                  }
                }
                process.stdout.write(
                  `${JSON.stringify({ build, total, transport, pageSize, codePageSize, measurements })}\n`,
                );
              } finally {
                workHeads.mockRestore();
                bridge.disconnect();
              }
            });
          }),
        ).pipe(Effect.provide(makePersistenceLive({ dataDirectory: directory }))),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
