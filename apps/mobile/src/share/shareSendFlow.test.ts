import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MOBILE_ATTACHMENT_MAX_BYTES,
  RESTRICTED_REMOTE_SESSION,
  type MobileInboxRow,
  type MobileModelOption,
  type MobileRemoteTransport,
} from "@octant/client-runtime";
import {
  composerTextReplaced,
  forgetTypedComposerText,
  noteTypedComposerText,
  typedClaimFor,
} from "@octant/client-runtime/typed-composer-text";
import { OutboxStore } from "../outbox/outboxStore";
import { pendingAttachmentsReducer } from "../inbox/thread/pendingAttachments";
import { MOBILE_COPY } from "../copy";
import {
  combineComposerWithSharedText,
  evaluateShareHosts,
  listShareDestinations,
  mapShareForDestination,
  reconcileSelectedShareHost,
} from "./shareDestinations";
import { prepareShareForThread, sendSharedNewChat } from "./sendSharedNewChat";
import { SHARE_REFUSAL_MESSAGES, type ValidatedStagedShare } from "./shareValidation";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const HOST_READY = { hostId: "host-ready", label: "Studio Mac" };
const HOST_STALE = { hostId: "host-stale", label: "Old Laptop" };
const HOST_WATCHING = { hostId: "host-watch", label: "Workstation" };

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nbody");

const CHAT_ROW: MobileInboxRow = {
  hostId: HOST_READY.hostId,
  mode: "chat",
  threadId: "00000000-0000-4000-8000-000000000010",
  title: "Weekly notes",
  status: "active",
  freshness: "2026-11-28T11:00:00.000Z",
  version: 2,
  providerInstanceId: "p1",
};

const WORK_ROW: MobileInboxRow = {
  hostId: HOST_READY.hostId,
  mode: "work",
  threadId: "00000000-0000-4000-8000-000000000020",
  title: "Q4 budget review",
  status: "active",
  freshness: "2026-11-28T10:30:00.000Z",
  version: 1,
  projectId: "proj-1",
  providerInstanceId: "p1",
};

const CODE_ROW: MobileInboxRow = {
  hostId: HOST_READY.hostId,
  mode: "code",
  threadId: "00000000-0000-4000-8000-000000000030",
  title: "Fix upload retry",
  status: "active",
  freshness: "2026-11-28T10:00:00.000Z",
  version: 3,
  projectId: "proj-2",
  providerInstanceId: "p1",
};

function makeShare(overrides: Partial<ValidatedStagedShare> = {}): ValidatedStagedShare {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-11-28T11:55:00.000Z",
    textParts: ["https://octant.sh/docs"],
    attachments: [
      { kind: "image", displayName: "photo.png", mediaType: "image/png", bytes: PNG_BYTES },
    ],
    ...overrides,
  };
}

function makeTransport(
  hostId: string,
  handler: (input: {
    readonly method: string;
    readonly path: string;
    readonly body?: string | Uint8Array | undefined;
    readonly contentType?: string | undefined;
  }) => Promise<Response> | Response,
): MobileRemoteTransport {
  return {
    hostId,
    authenticatedFetch: async (request) => handler(request),
  };
}

afterEach(() => {
  forgetTypedComposerText();
});

describe("Send to… destination list, host eligibility, and mapping", () => {
  it("lists all paired computers and disables stale, unreachable, and restricted ones with a reason", () => {
    const dummyTransport = makeTransport(HOST_READY.hostId, () => new Response("{}"));
    const options = evaluateShareHosts({
      hosts: [HOST_READY, HOST_STALE, HOST_WATCHING],
      health: [
        { hostId: HOST_READY.hostId, label: HOST_READY.label, origin: "https://a", kind: "ready" },
        { hostId: HOST_STALE.hostId, label: HOST_STALE.label, origin: "https://b", kind: "stale" },
        {
          hostId: HOST_WATCHING.hostId,
          label: HOST_WATCHING.label,
          origin: "https://c",
          kind: "ready",
        },
      ],
      transportForHost: (hostId) => (hostId === HOST_STALE.hostId ? undefined : dummyTransport),
      standingForHost: (hostId) =>
        hostId === HOST_WATCHING.hostId
          ? { actsAsHostPerson: false, accessLevel: "read-only" }
          : { actsAsHostPerson: true },
    });

    expect(options).toEqual([
      { hostId: HOST_READY.hostId, label: HOST_READY.label, enabled: true },
      {
        hostId: HOST_STALE.hostId,
        label: HOST_STALE.label,
        enabled: false,
        disabledReason: MOBILE_COPY.shareComputerStale,
      },
      {
        hostId: HOST_WATCHING.hostId,
        label: HOST_WATCHING.label,
        enabled: false,
        disabledReason: MOBILE_COPY.shareComputerRestricted,
      },
    ]);
  });

  it("offers New chat, loaded threads, and bots in one union and searches across all loaded titles", () => {
    const bots = [
      { hostId: HOST_READY.hostId, botId: "bot-1", title: "Release helper", subtitle: "Ops bot" },
    ];
    const all = listShareDestinations({
      hostId: HOST_READY.hostId,
      rows: [CHAT_ROW, WORK_ROW, CODE_ROW],
      bots,
      projectName: (row) => (row.projectId === "proj-1" ? "Finance" : undefined),
      query: "",
    });
    expect(all.map((item) => item.kind)).toEqual(["new-chat", "thread", "thread", "thread", "bot"]);

    expect(
      listShareDestinations({
        hostId: HOST_READY.hostId,
        rows: [CHAT_ROW, WORK_ROW, CODE_ROW],
        bots,
        projectName: (row) => (row.projectId === "proj-1" ? "Finance" : undefined),
        query: "release",
      }).map((item) => item.kind),
    ).toEqual(["bot"]);

    expect(
      listShareDestinations({
        hostId: HOST_READY.hostId,
        rows: [CHAT_ROW, WORK_ROW, CODE_ROW],
        bots,
        projectName: (row) => (row.projectId === "proj-1" ? "Finance" : undefined),
        query: "finance",
      }).map((item) => (item.kind === "thread" ? item.threadId : "")),
    ).toEqual([WORK_ROW.threadId]);
  });

  it("refuses uncleanable images, oversized files, over-limit counts per mode, and models that do not take images", () => {
    const uncleanable = mapShareForDestination({
      share: makeShare({
        refusal: { reason: "uncleanable-image", message: SHARE_REFUSAL_MESSAGES.uncleanableImage },
      }),
      mode: "chat",
    });
    expect(uncleanable).toEqual({
      status: "refused",
      reason: SHARE_REFUSAL_MESSAGES.uncleanableImage,
    });

    const tooLarge = mapShareForDestination({
      share: makeShare({
        attachments: [
          {
            kind: "file",
            displayName: "big.pdf",
            mediaType: "application/pdf",
            bytes: new Uint8Array(MOBILE_ATTACHMENT_MAX_BYTES + 1),
          },
        ],
      }),
      mode: "chat",
    });
    expect(tooLarge).toEqual({ status: "refused", reason: SHARE_REFUSAL_MESSAGES.tooLarge });

    const nineFiles = Array.from({ length: 9 }, (_, i) => ({
      kind: "file" as const,
      displayName: `f-${i}.pdf`,
      mediaType: "application/pdf",
      bytes: PDF_BYTES,
    }));
    // Chat takes up to 16; Work and Code take at most 8.
    expect(
      mapShareForDestination({ share: makeShare({ attachments: nineFiles }), mode: "chat" }).status,
    ).toBe("ready");
    expect(
      mapShareForDestination({ share: makeShare({ attachments: nineFiles }), mode: "work" }),
    ).toEqual({
      status: "refused",
      reason: MOBILE_COPY.attachLimit(8),
    });
    expect(
      mapShareForDestination({ share: makeShare({ attachments: nineFiles }), mode: "code" }),
    ).toEqual({
      status: "refused",
      reason: MOBILE_COPY.attachLimit(8),
    });

    const textOnlyModel: MobileModelOption = {
      id: "p1:text-only",
      providerInstanceId: "p1",
      modelId: "text-only",
      label: "Text only",
      detail: "Local",
      attachmentModalities: [],
    };
    expect(
      mapShareForDestination({
        share: makeShare(),
        mode: "chat",
        model: textOnlyModel,
      }),
    ).toEqual({
      status: "refused",
      reason: MOBILE_COPY.shareModelNoImages,
    });
  });
});

describe("Send to… execution, composer handoff, and stale computer refusal", () => {
  it("a stale computer shows a refusal, sends nothing, keeps staged items, and leaves the outbox empty", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    const cleanupSpy = vi.fn(async () => undefined);
    const outbox = new OutboxStore({
      now: () => new Date("2026-11-28T12:00:00.000Z"),
      reasons: { tooOld: "old", otherComputer: "other", pairedAgain: "again" },
      load: async () => null,
      keep: async () => undefined,
      send: async () => ({ status: "unreachable" }),
    });

    const transport = makeTransport(HOST_STALE.hostId, fetchSpy);
    const result = await sendSharedNewChat({
      hostId: HOST_STALE.hostId,
      hostLabel: HOST_STALE.label,
      health: {
        hostId: HOST_STALE.hostId,
        label: HOST_STALE.label,
        origin: "https://b",
        kind: "stale",
      },
      transport,
      standing: { actsAsHostPerson: true },
      prompt: "Shared link",
      attachments: [],
      onCleanupStaged: cleanupSpy,
    });

    expect(result).toEqual({
      status: "refused",
      message: MOBILE_COPY.shareComputerStale,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(cleanupSpy).not.toHaveBeenCalled();
    expect(outbox.read().outbox.messages).toEqual([]);

    const restricted = await prepareShareForThread({
      hostLabel: HOST_WATCHING.label,
      health: {
        hostId: HOST_WATCHING.hostId,
        label: HOST_WATCHING.label,
        origin: "https://c",
        kind: "ready",
      },
      transport,
      standing: RESTRICTED_REMOTE_SESSION,
      row: { ...CHAT_ROW, hostId: HOST_WATCHING.hostId },
      attachments: makeShare().attachments,
    });
    expect(restricted.status).toBe("refused");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("New chat creates its thread on Send, uploads through /api/chat/attachments, sends without typedByPerson, and deletes staged items", async () => {
    const calls: Array<{
      readonly method: string;
      readonly path: string;
      readonly body?: unknown;
    }> = [];
    const threadId = "00000000-0000-4000-8000-000000000099";
    const attachmentId = "00000000-0000-4000-8000-000000000199";
    const threadPayload = {
      id: threadId,
      title: "https://octant.sh/docs",
      createdAt: "2026-11-28T12:00:00.000Z",
      updatedAt: "2026-11-28T12:00:01.000Z",
      version: 1,
      lifecycle: "active",
      providerInstanceId: "10000000-0000-4000-8000-000000000001",
      modelId: "m1",
      researchEnabled: false,
      researchRouting: "automatic",
      personalityInstructions: "Be clear.",
    };

    const transport = makeTransport(HOST_READY.hostId, (request) => {
      const parsedBody =
        typeof request.body === "string"
          ? (JSON.parse(request.body) as Record<string, unknown>)
          : undefined;
      calls.push({ method: request.method, path: request.path, body: parsedBody });
      if (request.path === "/api/chat/commands" && parsedBody?.kind === "create-chat-thread") {
        return new Response(JSON.stringify({ kind: "thread-created", thread: threadPayload }));
      }
      if (request.path === "/api/chat/attachments") {
        return new Response(
          JSON.stringify({
            id: attachmentId,
            threadId,
            displayName: "photo.png",
            mediaType: "image/png",
            byteLength: PNG_BYTES.byteLength,
            digest: "a".repeat(64),
            status: "pending",
            createdAt: "2026-11-28T12:00:00.000Z",
          }),
        );
      }
      if (request.path === "/api/chat/commands" && parsedBody?.kind === "send-chat-turn") {
        return new Response(JSON.stringify({ kind: "turn-accepted" }));
      }
      if (request.path.startsWith("/api/chat/threads/")) {
        return new Response(
          JSON.stringify({
            thread: { ...threadPayload, version: 2 },
            turns: [],
            contents: [],
            attachments: [],
            citations: [],
            workItems: [],
            workListVersion: 0,
            followUpVersion: 0,
            lastSequence: 2,
          }),
        );
      }
      return new Response("unexpected", { status: 404 });
    });

    const cleanupSpy = vi.fn(async () => undefined);
    const scope = "mobile-share-new-chat";
    // Shared text placed into composer without user typing must never claim typedByPerson.
    composerTextReplaced(scope, "https://octant.sh/docs");
    const claim = typedClaimFor(scope, "https://octant.sh/docs");
    expect(claim).toEqual({});

    const outcome = await sendSharedNewChat({
      hostId: HOST_READY.hostId,
      hostLabel: HOST_READY.label,
      health: {
        hostId: HOST_READY.hostId,
        label: HOST_READY.label,
        origin: "https://a",
        kind: "ready",
      },
      transport,
      standing: { actsAsHostPerson: true },
      prompt: "https://octant.sh/docs",
      ...claim,
      attachments: makeShare().attachments,
      onCleanupStaged: cleanupSpy,
    });

    expect(outcome.status).toBe("sent");
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "POST /api/chat/commands",
      "POST /api/chat/attachments",
      "POST /api/chat/commands",
      `GET /api/chat/threads/${threadId}`,
    ]);
    const sendTurnBody = calls[2]?.body as Record<string, unknown>;
    expect(sendTurnBody.kind).toBe("send-chat-turn");
    expect(sendTurnBody.attachmentIds).toEqual([attachmentId]);
    expect(sendTurnBody).not.toHaveProperty("typedByPerson");
    expect(cleanupSpy).toHaveBeenCalledTimes(1);

    // If the person edits the text themselves, the composer's normal typing rule applies.
    noteTypedComposerText(scope, "Please summarize https://octant.sh/docs");
    expect(typedClaimFor(scope, "Please summarize https://octant.sh/docs")).toEqual({
      typedByPerson: true,
    });
  });

  it("populates an existing Work or Code thread composer through its existing attachment route without auto-sending", async () => {
    const paths: string[] = [];
    const transport = makeTransport(HOST_READY.hostId, (request) => {
      paths.push(`${request.method} ${request.path}`);
      if (request.path === "/api/work/attachments") {
        return new Response(
          JSON.stringify({
            attachmentId: "00000000-0000-4000-8000-000000000201",
            displayName: "photo.png",
            mediaType: "image/png",
            byteLength: PNG_BYTES.byteLength,
            digest: "b".repeat(64),
          }),
        );
      }
      if (request.path === "/api/code/attachments") {
        return new Response("unsupported", { status: 415 });
      }
      return new Response("unexpected", { status: 404 });
    });

    const workPrepared = await prepareShareForThread({
      hostLabel: HOST_READY.label,
      health: {
        hostId: HOST_READY.hostId,
        label: HOST_READY.label,
        origin: "https://a",
        kind: "ready",
      },
      transport,
      standing: { actsAsHostPerson: true },
      row: WORK_ROW,
      attachments: makeShare().attachments,
    });
    expect(workPrepared).toEqual({
      status: "ready",
      uploaded: [{ id: "00000000-0000-4000-8000-000000000201", displayName: "photo.png" }],
    });
    // Only the attachment upload ran — no turn command was sent automatically.
    expect(paths).toEqual(["PUT /api/work/attachments"]);

    const pending = pendingAttachmentsReducer([], {
      type: "staged",
      attachments: workPrepared.status === "ready" ? workPrepared.uploaded : [],
    });
    expect(pending).toEqual([
      { id: "00000000-0000-4000-8000-000000000201", displayName: "photo.png" },
    ]);
    expect(combineComposerWithSharedText("Existing draft", "https://octant.sh/docs")).toBe(
      "Existing draft\n\nhttps://octant.sh/docs",
    );

    // An older host refusing a file with 415 returns a refusal so items stay for Retry or Discard.
    const olderHostRefused = await prepareShareForThread({
      hostLabel: HOST_READY.label,
      health: {
        hostId: HOST_READY.hostId,
        label: HOST_READY.label,
        origin: "https://a",
        kind: "ready",
      },
      transport,
      standing: { actsAsHostPerson: true },
      row: CODE_ROW,
      attachments: makeShare().attachments,
    });
    expect(olderHostRefused.status).toBe("refused");
  });

  it("preserves New chat send success when reloading the created thread fails after the turn was accepted", async () => {
    const threadId = "00000000-0000-4000-8000-000000000111";
    const cleanupSpy = vi.fn(async () => undefined);
    const transport = makeTransport(HOST_READY.hostId, (request) => {
      if (request.method === "POST" && request.path === "/api/chat/commands") {
        const payload = JSON.parse(String(request.body ?? "{}")) as { readonly kind?: string };
        if (payload.kind === "create-chat-thread") {
          return new Response(
            JSON.stringify({
              kind: "thread-created",
              thread: {
                id: threadId,
                title: "Shared note",
                createdAt: "2026-11-28T12:00:00.000Z",
                updatedAt: "2026-11-28T12:00:01.000Z",
                version: 1,
                lifecycle: "active",
                providerInstanceId: "10000000-0000-4000-8000-000000000001",
                modelId: "m1",
                researchEnabled: false,
                researchRouting: "automatic",
                personalityInstructions: "Be clear.",
              },
            }),
          );
        }
        return new Response(JSON.stringify({ kind: "turn-accepted" }));
      }
      // Subsequent thread reload fails with 503.
      return new Response("temporarily unavailable", { status: 503 });
    });

    const result = await sendSharedNewChat({
      hostId: HOST_READY.hostId,
      hostLabel: HOST_READY.label,
      health: {
        hostId: HOST_READY.hostId,
        label: HOST_READY.label,
        origin: "https://a",
        kind: "ready",
      },
      transport,
      standing: { actsAsHostPerson: true },
      prompt: "Shared note",
      attachments: [],
      onCleanupStaged: cleanupSpy,
    });

    expect(result.status).toBe("sent");
    if (result.status === "sent") {
      expect(result.row.threadId).toBe(threadId);
      expect(result.row.title).toBe("Shared note");
    }
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps the chosen computer while editing a New chat draft or sending if its availability flaps", () => {
    const hostsAfterDisconnect = [
      { hostId: "host-placement", enabled: false },
      { hostId: "host-backup", enabled: true },
    ];
    expect(
      reconcileSelectedShareHost({
        currentHostId: "host-placement",
        defaultHostId: "host-backup",
        hostOptions: hostsAfterDisconnect,
        step: "new-chat",
        busy: false,
      }),
    ).toBe("host-placement");
    expect(
      reconcileSelectedShareHost({
        currentHostId: "host-placement",
        defaultHostId: "host-backup",
        hostOptions: hostsAfterDisconnect,
        step: "pick",
        busy: true,
      }),
    ).toBe("host-placement");
    expect(
      reconcileSelectedShareHost({
        currentHostId: "host-placement",
        defaultHostId: "host-backup",
        hostOptions: hostsAfterDisconnect,
        step: "pick",
        busy: false,
      }),
    ).toBe("host-backup");
    expect(
      reconcileSelectedShareHost({
        currentHostId: undefined,
        defaultHostId: "host-backup",
        hostOptions: hostsAfterDisconnect,
        step: "pick",
        busy: false,
      }),
    ).toBe("host-backup");
  });

  it("keeps the host remote route policy free of any new share route", () => {
    const policy = readFileSync(
      join(repoRoot, "apps", "server", "src", "remoteRoutePolicy.ts"),
      "utf8",
    );
    expect(policy).toContain("/api/chat/attachments");
    expect(policy).toContain("/api/work/attachments");
    expect(policy).toContain("/api/code/attachments");
    expect(policy).not.toMatch(/\/api\/(?:mobile\/)?share\b/);
  });
});
