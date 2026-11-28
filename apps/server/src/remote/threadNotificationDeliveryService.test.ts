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
  RemotePushPreferencesV1,
  WorkRequestFrame,
  WorkTurnUpdated,
} from "@octant/contracts";
import { REMOTE_PUSH_RATE_LIMIT } from "@octant/domain/push-notification-policy";
import type { PushDeliverySendResult } from "../automation/pushDeliveryTransport";
import { createRecordingPushDeliveryTransport } from "../automation/pushDeliveryTransport.test-support";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
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
const projects: Record<string, string | undefined> = {
  [chatThread]: undefined,
  [workThread]: "Finance",
  [codeThread]: "Octant",
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
  const register = (
    deviceId: typeof phone | typeof tablet,
    preferences: RemotePushPreferencesV1 = allKinds,
  ) =>
    registrations.register({
      hostId,
      deviceId,
      platform: "ios",
      token: `apns-token-${deviceId}`,
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
      const projectName = projects[threadId];
      return mode === undefined || title === undefined
        ? undefined
        : { mode, title, ...(projectName === undefined ? {} : { projectName }) };
    },
    computerLabel: () => "Studio Mac",
    readHeldSecrets: async () => ({ status: "ready", values: [] }),
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
  const moveReceipts = () =>
    (
      connection
        .prepare(
          "SELECT payload_json FROM event_journal WHERE event_name = 'remote.push-move-waiting-delivery-recorded@1' ORDER BY global_sequence",
        )
        .all() as ReadonlyArray<{ readonly payload_json: string }>
    ).map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
  const joinedReceipts = () =>
    (
      connection
        .prepare(
          "SELECT payload_json FROM event_journal WHERE event_name = 'remote.push-device-joined-delivery-recorded@1' ORDER BY global_sequence",
        )
        .all() as ReadonlyArray<{ readonly payload_json: string }>
    ).map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
  return {
    connection,
    dataDirectory,
    journal,
    options,
    registrations,
    register,
    receipts,
    moveReceipts,
    joinedReceipts,
    service,
    transport: options.transport === transport ? transport : undefined,
  };
}

function committed(
  eventName: string,
  payload: unknown,
  aggregateId = "55555555-5555-4555-8555-555555555555",
) {
  return { events: [{ eventName, aggregateId, payload }] };
}

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
  workCarried: () =>
    committed("work.turn-updated@1", {
      kind: "turn-updated",
      carried: true,
      threadId: workThread,
      turnId: "f0000000-0000-4000-8000-000000000002",
      status: "completed",
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
  codeQuestion: (requestId: string) =>
    committed("code.operation-event-recorded@1", {
      threadId: codeThread,
      operationId: "e1000000-0000-4000-8000-000000000001",
      cursor: 5,
      event: { kind: "input-requested", requestId },
    } satisfies Shape<CodeOperationEventFrame>),
};

describe("ordinary-thread notifications", () => {
  it("notifies a paired phone of every kind in Chat, Work, and Code with checked v2 alerts and no titles by default", async () => {
    const { register, service, transport, receipts, connection } = host();
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

    const alerts = (transport?.sent ?? []).map((send) => {
      expect(send.message.type).toBe("alert");
      if (send.message.type !== "alert") throw new Error("expected alert");
      return send.message.alert;
    });
    expect(alerts.map(({ kind, mode, threadId }) => ({ kind, mode, threadId }))).toEqual([
      { kind: "completion", mode: "chat", threadId: chatThread },
      { kind: "approval-needed", mode: "chat", threadId: chatThread },
      { kind: "failure", mode: "work", threadId: workThread },
      { kind: "approval-needed", mode: "work", threadId: workThread },
      { kind: "waiting", mode: "code", threadId: codeThread },
    ]);
    for (const alert of alerts) {
      expect(alert.version).toBe(2);
      expect(alert.hostId).toBe(hostId);
      expect(alert.body).toBe("On Studio Mac");
      expect(alert.title).not.toContain(":");
    }
    expect(JSON.stringify(alerts)).not.toContain("Acme");
    expect(JSON.stringify(alerts)).not.toContain("Finance");

    const written = connection
      .prepare("SELECT DISTINCT aggregate_type FROM event_journal ORDER BY aggregate_type")
      .all() as ReadonlyArray<{ readonly aggregate_type: string }>;
    expect(written.map((row) => row.aggregate_type)).toEqual([
      "remote-push-delivery",
      "remote-push-registration",
    ]);
  });

  it("drops planted secrets in thread title, project name, active/remembered secrets, and fails closed when keyring is unreadable", async () => {
    const activeThreadSecret = "custom-active-thread-secret-7731";
    const rememberedSecret = "custom-remembered-secret-8842";
    const prevTitle = titles[codeThread];
    const prevProject = projects[codeThread];
    try {
      titles[codeThread] = `Deploy ${activeThreadSecret} to prod`;
      projects[codeThread] = `Repo ${rememberedSecret}`;
      const withSecrets = host({
        readHeldSecrets: async () => ({
          status: "ready",
          values: [activeThreadSecret, rememberedSecret],
        }),
      });
      withSecrets.register(phone, { ...allKinds, threadTitles: true });
      withSecrets.service.onCommittedAppend(facts.codeApproval());
      await vi.waitFor(() => expect(withSecrets.receipts()).toHaveLength(1));

      const sent = withSecrets.transport?.sent[0]?.message;
      expect(sent?.type).toBe("alert");
      if (sent?.type === "alert") {
        expect(sent.alert.title).toBe("Approval needed");
        expect(sent.alert.body).toBe("On Studio Mac");
        expect(JSON.stringify(sent)).not.toContain(activeThreadSecret);
        expect(JSON.stringify(sent)).not.toContain(rememberedSecret);
      }

      // Unreadable keyring fails closed to generic placeholder even for clean titles.
      titles[codeThread] = "Ship release";
      projects[codeThread] = "Octant";
      const locked = host({
        readHeldSecrets: async () => ({ status: "unavailable" }),
      });
      locked.register(phone, { ...allKinds, threadTitles: true });
      locked.service.onCommittedAppend(facts.codeApproval("e2000000-0000-4000-8000-000000000009"));
      await vi.waitFor(() => expect(locked.receipts()).toHaveLength(1));

      const lockedSent = locked.transport?.sent[0]?.message;
      expect(lockedSent?.type).toBe("alert");
      if (lockedSent?.type === "alert") {
        expect(lockedSent.alert.title).toBe("Octant");
        expect(lockedSent.alert.body).toBe("A paired computer has an update");
        expect(JSON.stringify(lockedSent)).not.toContain("Ship release");
        expect(JSON.stringify(lockedSent)).not.toContain("Studio Mac");
      }
    } finally {
      titles[codeThread] = prevTitle ?? "Fix the release build";
      projects[codeThread] = prevProject;
    }
  });

  it("sends one notification per thread, kind, and run, even across a restart", async () => {
    const first = host();
    first.register(phone);
    first.service.onCommittedAppend(facts.chatCompleted());
    first.service.onCommittedAppend(facts.chatCompleted());
    first.service.onCommittedAppend(facts.codeWaiting());
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

  it("sends nothing for the finished turns a Work fork copies from its source", async () => {
    const fixture = host();
    fixture.register(phone);
    fixture.service.onCommittedAppend(facts.workCarried());
    fixture.service.onCommittedAppend(facts.workFailed());
    await vi.waitFor(() => expect(fixture.receipts()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fixture.receipts()).toHaveLength(1);
  });

  it("notifies each approval and question a Code turn asks, and waiting asks held outside the journal", async () => {
    const { register, service, transport, receipts } = host();
    register(phone);
    service.onCommittedAppend(facts.codeApproval());
    service.onCommittedAppend(facts.codeApproval("e2000000-0000-4000-8000-000000000002"));
    service.onCommittedAppend(facts.codeQuestion("provider-question-1"));
    service.onCommittedAppend(facts.codeQuestion("provider-question-2"));
    service.onCommittedAppend(facts.codeApproval());
    const ask = { threadId: workThread, askId: "f1000000-0000-4000-8000-000000000001" };
    service.notifyWaitingAsk(ask);
    service.notifyWaitingAsk(ask);
    await vi.waitFor(() => expect(receipts()).toHaveLength(5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transport?.sent).toHaveLength(5);
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

  it("sends each phone only the kinds it asked for, and thread/project names only to a phone that opted in", async () => {
    const { register, service, transport, receipts } = host();
    register(phone, { ...allKinds, completion: false });
    register(tablet, { ...allKinds, threadTitles: true });
    service.onCommittedAppend(facts.chatCompleted());
    service.onCommittedAppend(facts.workFailed());
    await vi.waitFor(() => expect(receipts()).toHaveLength(3));

    const byDevice = (transport?.sent ?? []).map((send) => {
      if (send.message.type !== "alert") throw new Error("expected alert");
      return [
        send.destination.deviceId,
        send.message.alert.kind,
        send.message.alert.title,
        send.message.alert.body,
      ];
    });
    expect(byDevice).toEqual([
      [tablet, "completion", "Thread completed: Acme renewal draft", "On Studio Mac"],
      [phone, "failure", "Thread failed", "On Studio Mac"],
      [tablet, "failure", "Thread failed: Quarterly plan", "Finance · On Studio Mac"],
    ]);
  });

  it("sends nothing for unreadable threads, devices without standing, or while delivery is unavailable, and clears gone destinations", async () => {
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

    const gone: PushDeliverySendResult = { kind: "destination-gone" };
    const goneHost = host({
      transport: createRecordingPushDeliveryTransport({ send: async () => gone }),
    });
    goneHost.register(phone);
    goneHost.service.onCommittedAppend(facts.workFailed());

    await vi.waitFor(() => expect(revoked.receipts()).toHaveLength(1));
    await vi.waitFor(() => expect(goneHost.receipts()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(unreadable.transport?.sent).toHaveLength(0);
    expect(revoked.transport?.sent.map((send) => send.destination.deviceId)).toEqual([tablet]);
    expect(unavailable.receipts()).toEqual([]);
    expect(goneHost.registrations.get({ hostId, deviceId: phone })).toBeUndefined();
  });

  it("keeps tokens, collapse keys, and display text out of the journal, the store, and logs", async () => {
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
      const { register, service, receipts, registrations, dataDirectory } = host({
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
        ...([phone, tablet] as const).flatMap((deviceId) => {
          const record = registrations.get({ hostId, deviceId });
          return [
            { name: "collapse key", value: record?.collapseKey ?? "missing" },
            { name: "token", value: record?.token ?? "missing" },
          ];
        }),
      ];

      const registrationFile = join(dataDirectory, PUSH_REGISTRATIONS_FILE);
      const leaks: string[] = [];
      const scan = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) {
            scan(path);
            continue;
          }
          if (path === registrationFile) continue;
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
      expect(leaks).toEqual([]);
    } finally {
      titles[codeThread] = "Fix the release build";
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });
});

describe("held-move and new-device notifications", () => {
  const waitId = "66666666-6666-4666-8666-666666666666";
  const wait = {
    waitId,
    destinationName: "Office iMac",
    confirmsMoves: (deviceId: string) => deviceId === phone,
  };
  const alertId = "77777777-7777-4777-8777-777777777777";

  it("tells each owner phone once that a move waits, naming only the destination", async () => {
    const { register, service, transport, moveReceipts, receipts } = host();
    register(phone, { ...allKinds, threadTitles: true });
    register(tablet);
    service.notifyMoveWaiting(wait);
    service.notifyMoveWaiting(wait);
    await vi.waitFor(() => expect(moveReceipts()).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(transport?.sent.map((send) => send.destination.deviceId)).toEqual([phone]);
    expect(transport?.sent[0]?.message).toMatchObject({
      type: "alert",
      alert: {
        version: 2,
        kind: "move-waiting",
        hostId,
        title: "A move is waiting for your phone",
        body: "To Office iMac",
        urgency: "high",
      },
    });
    expect(receipts()).toEqual([]);
  });

  it("tells every standing phone once when a new device joins, without privateAddress or alertId in the push payload", async () => {
    const { register, service, transport, joinedReceipts, receipts } = host();
    register(phone);
    register(tablet);
    service.notifyDeviceJoined({
      alertId,
      deviceName: "Ada's laptop",
      joined: "host",
    });
    service.notifyDeviceJoined({
      alertId,
      deviceName: "Ada's laptop",
      joined: "host",
    });
    await vi.waitFor(() => expect(joinedReceipts()).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const sent = transport?.sent.find((entry) => entry.destination.deviceId === phone)?.message;
    expect(sent).toMatchObject({
      type: "alert",
      alert: {
        version: 2,
        kind: "device-joined",
        hostId,
        title: "New device: Ada's laptop",
        body: "Paired with Studio Mac",
        urgency: "high",
      },
    });
    expect(JSON.stringify(sent)).not.toContain("alertId");
    expect(JSON.stringify(sent)).not.toContain("privateAddress");
    expect(receipts()).toEqual([]);
  });

  it("tells neither the new device itself nor a phone that turned new devices off", async () => {
    const { register, service, transport, joinedReceipts } = host();
    register(phone, { ...allKinds, newDevices: false });
    register(tablet);
    service.notifyDeviceJoined({
      alertId,
      deviceName: "Ada's laptop",
      joined: "host",
      newDeviceId: tablet,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(transport?.sent).toHaveLength(0);
    expect(joinedReceipts()).toEqual([]);
  });
});
