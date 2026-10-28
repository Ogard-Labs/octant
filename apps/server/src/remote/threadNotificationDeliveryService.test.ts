import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Brand } from "effect";
import type {
  ChatAttemptUpdated,
  CodeOperationEventFrame,
  CodeRuntimeWorkUpdated,
  NativeHarnessApproval,
  RemotePushEnvelopeV1,
  RemotePushPreferencesV1,
  WorkRequestFrame,
  WorkTurnUpdated,
} from "@octant/contracts";
import { REMOTE_PUSH_RATE_LIMIT } from "@octant/domain/push-notification-policy";
import {
  createRecordingPushDeliveryTransport,
  type PushDeliverySendResult,
} from "../automation/pushDeliveryTransport";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import {
  openSealedPushNotification,
  phoneNotificationKeys,
} from "./pushNotificationSealing.test-support";
import {
  createPushNotificationTokenStore,
  PUSH_REGISTRATIONS_FILE,
} from "./pushNotificationTokenStore";
import {
  ThreadNotificationDeliveryService,
  type ThreadNotificationDeliveryOptions,
} from "./threadNotificationDeliveryService";

const hostId = "11111111-1111-4111-8111-111111111111";
const phone = "22222222-2222-4222-8222-222222222222";
const tablet = "33333333-3333-4333-8333-333333333333";
const hostActorId = "00000000-0000-4000-8000-000000000002";
const chatThread = "c0000000-0000-4000-8000-000000000001";
const workThread = "d0000000-0000-4000-8000-000000000001";
const codeThread = "e0000000-0000-4000-8000-000000000001";
const now = "2026-10-26T12:00:00.000Z";
const allKinds: RemotePushPreferencesV1 = {
  approvalNeeded: true,
  waiting: true,
  failure: true,
  completion: true,
  threadTitles: false,
};
const titles: Record<string, string> = {
  [chatThread]: "Acme renewal draft",
  [workThread]: "Quarterly plan",
  [codeThread]: "Fix the release build",
};
const modes: Record<string, "chat" | "work" | "code"> = {
  [chatThread]: "chat",
  [workThread]: "work",
  [codeThread]: "code",
};

const directories: string[] = [];
const connections: SqliteConnection[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function host(overrides: Partial<ThreadNotificationDeliveryOptions> = {}) {
  const dataDirectory = mkdtempSync(join(tmpdir(), "octant-thread-notifications-"));
  directories.push(dataDirectory);
  const connection = openSqlite(join(dataDirectory, "store.sqlite3"));
  connections.push(connection);
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  let counter = 0;
  const uuid = () => `44444444-4444-4444-8444-${String(++counter).padStart(12, "0")}`;
  const registrations = createPushNotificationTokenStore({
    dataDirectory,
    journal,
    hostActorId,
    uuid,
  });
  const keys = { [phone]: phoneNotificationKeys(), [tablet]: phoneNotificationKeys() };
  const register = (
    deviceId: typeof phone | typeof tablet,
    preferences: RemotePushPreferencesV1 = allKinds,
  ) =>
    registrations.register({
      hostId,
      deviceId,
      platform: "ios",
      token: `apns-token-${deviceId}`,
      notificationPublicKey: keys[deviceId].publicKey,
      preferences,
      now,
    });
  const transport = createRecordingPushDeliveryTransport();
  const options: ThreadNotificationDeliveryOptions = {
    journal,
    registrations,
    transport,
    hasStanding: () => true,
    readThread: (threadId) => {
      const mode = modes[threadId];
      const title = titles[threadId];
      return mode === undefined || title === undefined ? undefined : { mode, title };
    },
    computerLabel: () => "Studio Mac",
    clock: () => now,
    uuid,
    hostActorId,
    ...overrides,
  };
  const service = new ThreadNotificationDeliveryService(options);
  const receipts = () =>
    (
      connection
        .prepare(
          "SELECT payload_json FROM event_journal WHERE event_name = 'remote.push-delivery-recorded@1' ORDER BY global_sequence",
        )
        .all() as ReadonlyArray<{ readonly payload_json: string }>
    ).map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
  const open = (
    envelope: RemotePushEnvelopeV1 | undefined,
    deviceId: typeof phone | typeof tablet,
  ) => {
    if (envelope === undefined) throw new Error("expected a sealed envelope");
    return openSealedPushNotification({
      envelope,
      recipient: keys[deviceId].privateKey,
      hostId,
      deviceId,
    }) as Record<string, unknown>;
  };
  return {
    connection,
    dataDirectory,
    journal,
    options,
    registrations,
    register,
    receipts,
    service,
    transport: options.transport === transport ? transport : undefined,
    keys,
    open,
  };
}

function committed(
  eventName: string,
  payload: unknown,
  aggregateId = "55555555-5555-4555-8555-555555555555",
) {
  return { events: [{ eventName, aggregateId, payload }] };
}

/**
 * The part of a journaled payload a fact below spells out. The service reads
 * these payloads leniently, so a field it reads that a contract renames would
 * silently stop notifications; typing each fact against its contract makes
 * that rename fail here instead.
 */
type Shape<T> =
  T extends Brand.Brand<string | symbol>
    ? string
    : T extends string | number | boolean
      ? T
      : T extends ReadonlyArray<infer Element>
        ? ReadonlyArray<Shape<Element>>
        : { readonly [Key in keyof T]?: Shape<T[Key]> };

const facts = {
  chatCompleted: (attemptId = "a0000000-0000-4000-8000-000000000001", threadId = chatThread) =>
    committed("chat.attempt-updated@1", {
      kind: "attempt-updated",
      attempt: { id: attemptId, threadId, outcome: "completed" },
    } satisfies Shape<ChatAttemptUpdated>),
  chatHarnessApproval: () =>
    committed(
      "native-harness-approval-asked@1",
      {
        id: "b0000000-0000-4000-8000-000000000001",
        status: "pending",
      } satisfies Shape<NativeHarnessApproval>,
      chatThread,
    ),
  workFailed: () =>
    committed("work.turn-updated@1", {
      kind: "turn-updated",
      threadId: workThread,
      turnId: "f0000000-0000-4000-8000-000000000001",
      status: "failed",
    } satisfies Shape<WorkTurnUpdated>),
  workApproval: () =>
    committed("work.request-recorded@1", {
      kind: "requested",
      request: {
        requestId: "f1000000-0000-4000-8000-000000000001",
        threadId: workThread,
        detail: { kind: "approval" },
      },
    } satisfies Shape<WorkRequestFrame>),
  codeWaiting: () =>
    committed("code.runtime-work-updated@1", {
      kind: "runtime-work-updated",
      work: {
        id: "e1000000-0000-4000-8000-000000000001",
        threadId: codeThread,
        kind: "provider-turn",
        state: "waiting",
      },
    } satisfies Shape<CodeRuntimeWorkUpdated>),
  codeApproval: (approvalId = "e2000000-0000-4000-8000-000000000001") =>
    committed("code.operation-event-recorded@1", {
      threadId: codeThread,
      operationId: "e1000000-0000-4000-8000-000000000001",
      cursor: 4,
      event: { kind: "approval-requested", approvalId },
    } satisfies Shape<CodeOperationEventFrame>),
  // A device lease or action only a person at a window on the host answers.
  codeLocalOnlyApproval: (approvalId: string, summary: string) =>
    committed("code.operation-event-recorded@1", {
      threadId: codeThread,
      operationId: "e1000000-0000-4000-8000-000000000001",
      cursor: 6,
      event: { kind: "approval-requested", approvalId, summary, localPersonOnly: true },
    } satisfies Shape<CodeOperationEventFrame>),
  codeQuestion: (requestId: string) =>
    committed("code.operation-event-recorded@1", {
      threadId: codeThread,
      operationId: "e1000000-0000-4000-8000-000000000001",
      cursor: 5,
      event: { kind: "input-requested", requestId },
    } satisfies Shape<CodeOperationEventFrame>),
};

describe("ordinary-thread notifications", () => {
  it("notifies a paired phone of every kind in Chat, Work, and Code with content only its key opens", async () => {
    const { register, service, transport, open, receipts, connection } = host();
    register(phone);
    for (const fact of [
      facts.chatCompleted(),
      facts.chatHarnessApproval(),
      facts.workFailed(),
      facts.workApproval(),
      facts.codeWaiting(),
    ]) {
      service.onCommittedAppend(fact);
    }
    await vi.waitFor(() => expect(receipts()).toHaveLength(5));

    const opened = transport?.sent.map((send) => open(send.envelope, phone)) ?? [];
    expect(opened.map(({ kind, mode, threadId }) => ({ kind, mode, threadId }))).toEqual([
      { kind: "completion", mode: "chat", threadId: chatThread },
      { kind: "approval-needed", mode: "chat", threadId: chatThread },
      { kind: "failure", mode: "work", threadId: workThread },
      { kind: "approval-needed", mode: "work", threadId: workThread },
      { kind: "waiting", mode: "code", threadId: codeThread },
    ]);
    for (const content of opened) {
      expect(content.hostId).toBe(hostId);
      expect(content.body).toBe("On Studio Mac");
      // Titles are off for this phone (decision M2).
      expect(String(content.title)).not.toContain(":");
    }
    for (const send of transport?.sent ?? []) {
      expect(send.destination).toEqual({
        deviceId: phone,
        platform: "ios",
        token: `apns-token-${phone}`,
      });
      const wire = JSON.stringify(send.envelope);
      for (const revealing of [hostId, chatThread, workThread, codeThread, "Acme", "Studio"]) {
        expect(wire).not.toContain(revealing);
      }
      expect(() => open(send.envelope, tablet)).toThrow();
    }

    expect(receipts()).toEqual([
      {
        hostId,
        deviceId: phone,
        threadId: chatThread,
        kind: "completion",
        outcome: "delivered",
        recordedAt: now,
      },
      {
        hostId,
        deviceId: phone,
        threadId: chatThread,
        kind: "approval-needed",
        outcome: "delivered",
        recordedAt: now,
      },
      {
        hostId,
        deviceId: phone,
        threadId: workThread,
        kind: "failure",
        outcome: "delivered",
        recordedAt: now,
      },
      {
        hostId,
        deviceId: phone,
        threadId: workThread,
        kind: "approval-needed",
        outcome: "delivered",
        recordedAt: now,
      },
      {
        hostId,
        deviceId: phone,
        threadId: codeThread,
        kind: "waiting",
        outcome: "delivered",
        recordedAt: now,
      },
    ]);
    // Delivery writes its receipts and nothing else: no thread, run, or
    // approval aggregate moves because a notification went out.
    const written = connection
      .prepare("SELECT DISTINCT aggregate_type FROM event_journal ORDER BY aggregate_type")
      .all() as ReadonlyArray<{ readonly aggregate_type: string }>;
    expect(written.map((row) => row.aggregate_type)).toEqual([
      "remote-push-delivery",
      "remote-push-registration",
    ]);
  });

  it("sends one notification per thread, kind, and run, even across a restart", async () => {
    const first = host();
    first.register(phone);
    first.service.onCommittedAppend(facts.chatCompleted());
    first.service.onCommittedAppend(facts.chatCompleted());
    first.service.onCommittedAppend(facts.codeWaiting());
    // The same turn's approval request is a different kind, so it is sent.
    first.service.onCommittedAppend(facts.codeApproval());
    await vi.waitFor(() => expect(first.receipts()).toHaveLength(3));

    const restarted = new ThreadNotificationDeliveryService(first.options);
    restarted.onCommittedAppend(facts.chatCompleted());
    restarted.onCommittedAppend(facts.chatCompleted("a0000000-0000-4000-8000-000000000002"));
    await vi.waitFor(() => expect(first.receipts()).toHaveLength(4));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(first.receipts()).toHaveLength(4);
    expect(first.transport?.sent).toHaveLength(4);
  });

  it("notifies each approval and question a Code turn asks, not only its first", async () => {
    const { register, service, transport, receipts } = host();
    register(phone);
    service.onCommittedAppend(facts.codeApproval());
    service.onCommittedAppend(facts.codeApproval("e2000000-0000-4000-8000-000000000002"));
    service.onCommittedAppend(facts.codeQuestion("provider-question-1"));
    service.onCommittedAppend(facts.codeQuestion("provider-question-2"));
    // A repeat of the same approval stays silent.
    service.onCommittedAppend(facts.codeApproval());
    await vi.waitFor(() => expect(receipts()).toHaveLength(4));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(receipts().map((receipt) => receipt.kind)).toEqual([
      "approval-needed",
      "approval-needed",
      "waiting",
      "waiting",
    ]);
    expect(transport?.sent).toHaveLength(4);
  });

  it("tells the phone an approval only the computer can answer is waiting there, and still asks for one it can answer", async () => {
    const { register, service, transport, open, receipts } = host();
    register(phone);
    register(tablet, { ...allKinds, threadTitles: true });
    service.onCommittedAppend(facts.codeApproval());
    service.onCommittedAppend(
      facts.codeLocalOnlyApproval(
        "e2000000-0000-4000-8000-000000000003",
        "Let this thread use Henrik's iPhone?",
      ),
    );
    await vi.waitFor(() => expect(receipts()).toHaveLength(4));

    const shown = (transport?.sent ?? []).map((send) => {
      const deviceId = send.destination.deviceId === phone ? phone : tablet;
      const { kind, title, body } = open(send.envelope, deviceId);
      return { deviceId, urgency: send.envelope.urgency, kind, title, body };
    });
    expect(shown).toEqual([
      {
        deviceId: phone,
        urgency: "high",
        kind: "approval-needed",
        title: "Approval needed",
        body: "On Studio Mac",
      },
      {
        deviceId: tablet,
        urgency: "high",
        kind: "approval-needed",
        title: "Approval needed: Fix the release build",
        body: "On Studio Mac",
      },
      // Sealed as a wait, not an ask, so the phone offers nothing to answer.
      {
        deviceId: phone,
        urgency: "high",
        kind: "waiting",
        title: "Waiting for you at Studio Mac",
        body: "Only an Octant window on that computer can answer",
      },
      {
        deviceId: tablet,
        urgency: "high",
        kind: "waiting",
        title: "Waiting for you at Studio Mac: Fix the release build",
        body: "Only an Octant window on that computer can answer",
      },
    ]);
    // The rule comes from the host's mark, never the approval's wording.
    for (const send of transport?.sent ?? []) {
      const content = JSON.stringify(
        open(send.envelope, send.destination.deviceId === phone ? phone : tablet),
      );
      expect(content).not.toContain("iPhone");
    }
    // The person asked to hear about approvals, and this is one: the phone's
    // approval preference governs it, and its receipt keeps the kind observed.
    expect(receipts().map((receipt) => receipt.kind)).toEqual([
      "approval-needed",
      "approval-needed",
      "approval-needed",
      "approval-needed",
    ]);
  });

  it("holds a local-only approval back from a phone that turned approvals off, even with waiting on", async () => {
    const { register, service, transport, receipts } = host();
    register(phone, { ...allKinds, approvalNeeded: false });
    register(tablet, { ...allKinds, waiting: false });
    service.onCommittedAppend(
      facts.codeLocalOnlyApproval("e2000000-0000-4000-8000-000000000004", "Launch the app?"),
    );
    await vi.waitFor(() => expect(receipts()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transport?.sent.map((send) => send.destination.deviceId)).toEqual([tablet]);
  });

  it("holds back a device's notifications past the rate limit and journals each one it held", async () => {
    const { register, service, transport, receipts } = host();
    register(phone);
    const sent = REMOTE_PUSH_RATE_LIMIT.maximum + 2;
    for (let index = 0; index < sent; index += 1) {
      service.onCommittedAppend(
        facts.chatCompleted(`a0000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`),
      );
    }
    await vi.waitFor(() => expect(receipts()).toHaveLength(sent));
    expect(transport?.sent).toHaveLength(REMOTE_PUSH_RATE_LIMIT.maximum);
    expect(receipts().map((receipt) => receipt.outcome)).toEqual([
      ...Array.from({ length: REMOTE_PUSH_RATE_LIMIT.maximum }, () => "delivered"),
      "rate-limited",
      "rate-limited",
    ]);
  });

  it("sends each phone only the kinds it asked for, and the thread title only to a phone that opted in", async () => {
    const { register, service, transport, open, receipts } = host();
    register(phone, { ...allKinds, completion: false });
    register(tablet, { ...allKinds, threadTitles: true });
    service.onCommittedAppend(facts.chatCompleted());
    service.onCommittedAppend(facts.workFailed());
    await vi.waitFor(() => expect(receipts()).toHaveLength(3));

    const byDevice = (transport?.sent ?? []).map((send) => ({
      deviceId: send.destination.deviceId,
      content: open(send.envelope, send.destination.deviceId === phone ? phone : tablet),
    }));
    expect(
      byDevice.map(({ deviceId, content }) => [deviceId, content.kind, content.title]),
    ).toEqual([
      [tablet, "completion", "Thread completed: Acme renewal draft"],
      [phone, "failure", "Thread failed"],
      [tablet, "failure", "Thread failed: Quarterly plan"],
    ]);
  });

  it("sends nothing for a thread no paired device could read, to a device without standing, or while delivery is unavailable", async () => {
    const unreadable = host({ readThread: () => undefined });
    unreadable.register(phone);
    unreadable.service.onCommittedAppend(facts.chatCompleted());

    const revoked = host({ hasStanding: (_hostId, deviceId) => deviceId !== phone });
    revoked.register(phone);
    revoked.register(tablet);
    revoked.service.onCommittedAppend(facts.chatCompleted());

    const unavailable = host({
      transport: createRecordingPushDeliveryTransport({ providerDelivery: "unavailable" }),
    });
    unavailable.register(phone);
    unavailable.service.onCommittedAppend(facts.chatCompleted());

    await vi.waitFor(() => expect(revoked.receipts()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unreadable.transport?.sent).toHaveLength(0);
    expect(unreadable.receipts()).toEqual([]);
    expect(revoked.transport?.sent.map((send) => send.destination.deviceId)).toEqual([tablet]);
    expect(unavailable.receipts()).toEqual([]);
  });

  it("clears a destination the delivery path refuses as gone and keeps the thread untouched", async () => {
    const gone: PushDeliverySendResult = { kind: "destination-gone" };
    const transport = createRecordingPushDeliveryTransport({ send: async () => gone });
    const { register, service, receipts, registrations, connection } = host({ transport });
    register(phone);
    service.onCommittedAppend(facts.workFailed());
    await vi.waitFor(() => expect(receipts()).toHaveLength(1));
    expect(receipts()[0]).toMatchObject({ outcome: "destination-gone", kind: "failure" });
    expect(registrations.get({ hostId, deviceId: phone })).toBeUndefined();
    const cleared = connection
      .prepare(
        "SELECT payload_json FROM event_journal WHERE event_name = 'remote.push-registration-cleared@1'",
      )
      .get() as { readonly payload_json: string } | undefined;
    expect(JSON.parse(cleared?.payload_json ?? "{}")).toMatchObject({
      deviceId: phone,
      reason: "destination-gone",
    });
  });

  it("keeps sealed content, keys, tokens, and display text out of the journal, the store, and logs", async () => {
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method),
    );
    const captured: string[] = [];
    for (const spy of consoleSpies) {
      spy.mockImplementation((...args: unknown[]) => {
        captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
    }
    try {
      const failing = createRecordingPushDeliveryTransport({
        send: async () => {
          throw new Error("delivery path exploded");
        },
      });
      const { register, service, receipts, registrations, dataDirectory, keys } = host({
        transport: failing,
        onError: (message) => console.error(message),
      });
      register(phone, { ...allKinds, threadTitles: true });
      register(tablet, { ...allKinds, threadTitles: true });
      titles[codeThread] = "TITLECANARY customer outage";
      service.onCommittedAppend(facts.codeApproval());
      await vi.waitFor(() => expect(receipts()).toHaveLength(2));
      expect(receipts().map((receipt) => receipt.outcome)).toEqual(["failed", "failed"]);

      const secrets = [
        { name: "thread title", value: "TITLECANARY" },
        ...failing.sent.flatMap((send) => [
          { name: "ciphertext", value: send.envelope.sealed.ciphertext.slice(0, 32) },
          { name: "encapsulated key", value: send.envelope.sealed.encapsulatedKey },
        ]),
        ...([phone, tablet] as const).flatMap((deviceId) => {
          const record = registrations.get({ hostId, deviceId });
          return [
            { name: "notification key", value: keys[deviceId].publicKey },
            { name: "collapse key", value: record?.collapseKey ?? "missing" },
            { name: "token", value: record?.token ?? "missing" },
          ];
        }),
      ];
      expect(failing.sent).toHaveLength(2);

      const registrationFile = join(dataDirectory, PUSH_REGISTRATIONS_FILE);
      const leaks: string[] = [];
      const scanned: string[] = [];
      const scan = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) {
            scan(path);
            continue;
          }
          if (path === registrationFile) continue;
          scanned.push(entry.name);
          const text = readFileSync(path).toString("latin1");
          for (const secret of secrets) {
            if (text.includes(secret.value)) leaks.push(`${entry.name} holds the ${secret.name}`);
          }
        }
      };
      scan(dataDirectory);
      const logs = captured.join("\n");
      for (const secret of secrets) {
        if (logs.includes(secret.value)) leaks.push(`a log line holds the ${secret.name}`);
      }
      expect(scanned).toContain("store.sqlite3");
      expect(scanned).toContain("store.sqlite3-wal");
      expect(captured.length).toBeGreaterThan(0);
      expect(leaks).toEqual([]);
    } finally {
      titles[codeThread] = "Fix the release build";
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });
});
