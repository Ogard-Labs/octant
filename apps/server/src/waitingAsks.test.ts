import { decodeProjectMemoryProposal, RoutineAgentRequest } from "@octant/contracts";
import { decodeBrowserToolApproval } from "@octant/contracts/browser-automation-rpc";
import { decodeExtensionToolApproval } from "@octant/contracts/extension-rpc";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { waitingAsksFrom, type WaitingAskThread } from "./waitingAsks";

const projectId = "00000000-0000-4000-8000-000000000a01";
const workThread = "00000000-0000-4000-8000-000000000a02";
const chatThread = "00000000-0000-4000-8000-000000000a03";
const hiddenThread = "00000000-0000-4000-8000-000000000a04";
const threads: Record<string, WaitingAskThread> = {
  [workThread]: { mode: "work", title: "Quarterly report", projectId },
  [chatThread]: { mode: "chat", title: "Trip plan" },
};
const readThread = (threadId: string) => threads[threadId];

const toolApproval = (overrides: Record<string, unknown> = {}) =>
  decodeExtensionToolApproval({
    approvalId: "00000000-0000-4000-8000-000000000b01",
    threadId: workThread,
    projectId,
    extensionId: "00000000-0000-4000-8000-000000000b10",
    packageId: "00000000-0000-4000-8000-000000000b11",
    componentId: "linear-mcp",
    serverName: "Linear",
    providerToolName: "mcp__linear__search_issues",
    mcpToolName: "search_issues",
    inputJson: '{"query":"renewals"}',
    requestedAt: "2026-11-13T08:02:00.000Z",
    rememberable: true,
    ...overrides,
  });

const none = {
  toolApprovals: [],
  browserApprovals: [],
  memoryProposals: [],
  routineProposals: [],
  imageOffers: [],
};

describe("waiting asks", () => {
  it("lists a tool approval with its whole input, for its thread to answer", () => {
    expect(waitingAsksFrom({ ...none, toolApprovals: [toolApproval()] }, readThread)).toEqual([
      {
        kind: "tool-approval",
        askId: "00000000-0000-4000-8000-000000000b01",
        mode: "work",
        projectId,
        threadId: workThread,
        threadTitle: "Quarterly report",
        requestedAt: "2026-11-13T08:02:00.000Z",
        text: "Run search_issues from Linear?",
        detail: '{"query":"renewals"}',
      },
    ]);
  });

  it("answers neither of two plugins' same-named tools from the list, since the row cannot tell them apart", () => {
    const asks = waitingAsksFrom(
      {
        ...none,
        toolApprovals: [
          toolApproval(),
          toolApproval({
            approvalId: "00000000-0000-4000-8000-000000000b03",
            extensionId: "00000000-0000-4000-8000-000000000b20",
            packageId: "00000000-0000-4000-8000-000000000b21",
          }),
        ],
      },
      readThread,
    );
    expect(asks).toHaveLength(2);
    expect(asks.map((ask) => ask.inPlace)).toEqual([undefined, undefined]);
  });

  it("sends the person to the thread when a row cannot show all the card shows", () => {
    const [long, marked] = waitingAsksFrom(
      {
        ...none,
        toolApprovals: [
          toolApproval({ inputJson: JSON.stringify({ body: "x".repeat(5_000) }) }),
          toolApproval({
            approvalId: "00000000-0000-4000-8000-000000000b02",
            outsideContent: { sources: [], sourceCount: 2 },
          }),
        ],
      },
      readThread,
    );
    expect(long).not.toHaveProperty("inPlace");
    expect(long).not.toHaveProperty("detail");
    expect(marked).not.toHaveProperty("inPlace");
  });

  it("lists a Browser site, upload and sign-in ask, and only the sign-in card as one the page answers", () => {
    const browser = (overrides: Record<string, unknown>) =>
      decodeBrowserToolApproval({
        approvalId: "00000000-0000-4000-8000-000000000c01",
        threadId: chatThread,
        mode: "chat",
        origin: "https://example.com",
        requestedAt: "2026-11-13T08:01:00.000Z",
        ...overrides,
      });
    const asks = waitingAsksFrom(
      {
        ...none,
        browserApprovals: [
          browser({}),
          browser({
            approvalId: "00000000-0000-4000-8000-000000000c02",
            upload: { files: [{ name: "notes.txt", sizeBytes: 5 }] },
          }),
          browser({
            approvalId: "00000000-0000-4000-8000-000000000c03",
            signIn: { reason: "The dashboard needs your account." },
          }),
        ],
      },
      readThread,
    );
    expect(
      asks.map(({ kind, text, detail, inPlace }) => ({ kind, text, detail, inPlace })),
    ).toEqual([
      {
        kind: "browser-approval",
        text: "Let the agent use https://example.com in the Browser?",
        detail: undefined,
        inPlace: undefined,
      },
      {
        kind: "browser-approval",
        text: "Upload 1 file to https://example.com?",
        detail: "notes.txt (5 bytes)",
        inPlace: undefined,
      },
      {
        kind: "browser-sign-in",
        text: "Sign in at https://example.com",
        detail: "The dashboard needs your account.",
        inPlace: undefined,
      },
    ]);
    expect(asks[0]).not.toHaveProperty("projectId");
  });

  it("names the profile a signed-in page lives in and a terminal as the asker, and answers neither from the list", () => {
    const codeThread = "00000000-0000-4000-8000-000000000a05";
    const read = (threadId: string) =>
      threadId === codeThread
        ? ({ mode: "code", title: "Fix the parser", projectId } as const)
        : readThread(threadId);
    const browser = (overrides: Record<string, unknown>) =>
      decodeBrowserToolApproval({
        approvalId: "00000000-0000-4000-8000-000000000c11",
        threadId: workThread,
        mode: "work",
        origin: "https://example.com",
        requestedAt: "2026-11-13T08:01:00.000Z",
        ...overrides,
      });
    const asks = waitingAsksFrom(
      {
        ...none,
        browserApprovals: [
          browser({ profile: { kind: "personal" } }),
          browser({
            approvalId: "00000000-0000-4000-8000-000000000c12",
            profile: { kind: "project", projectId },
          }),
          browser({
            approvalId: "00000000-0000-4000-8000-000000000c13",
            threadId: codeThread,
            mode: "code",
          }),
        ],
      },
      read,
    );
    expect(asks.map(({ text, inPlace }) => ({ text, inPlace }))).toEqual([
      {
        text: "Let the agent use https://example.com in the Personal profile, signed in as you?",
        inPlace: undefined,
      },
      {
        text: "Let the agent use https://example.com in the Project profile, signed in as you?",
        inPlace: undefined,
      },
      {
        text: "A program in a terminal, not this thread's agent, asks to open https://example.com in the Browser",
        inPlace: undefined,
      },
    ]);
  });

  it("lists a memory proposal with the words it would keep, and a routine proposal by name", () => {
    const asks = waitingAsksFrom(
      {
        ...none,
        memoryProposals: [
          decodeProjectMemoryProposal({
            proposalId: "00000000-0000-4000-8000-000000000d01",
            projectId,
            mode: "work",
            threadId: workThread,
            change: { kind: "create", memoryKind: "fact", content: "Invoices are due on the 5th." },
            expectedVersion: 3,
            requestedAt: "2026-11-13T08:03:00.000Z",
          }),
        ],
        routineProposals: [
          Schema.decodeUnknownSync(RoutineAgentRequest)({
            kind: "routine-change-request",
            proposalId: "00000000-0000-4000-8000-000000000d02",
            threadId: workThread,
            mode: "work",
            projectId,
            automationId: "00000000-0000-4000-8000-000000000d03",
            change: "pause",
            displayName: "Morning digest",
            expectedVersion: 2,
            requestedAt: "2026-11-13T08:04:00.000Z",
          }),
        ],
      },
      readThread,
    );
    expect(
      asks.map(({ kind, text, detail, inPlace }) => ({ kind, text, detail, inPlace })),
    ).toEqual([
      {
        kind: "memory-proposal",
        text: "Add to Project memory?",
        detail: "Invoices are due on the 5th.",
        inPlace: undefined,
      },
      {
        kind: "routine-proposal",
        text: "Pause the routine Morning digest?",
        detail: undefined,
        inPlace: undefined,
      },
    ]);
  });

  it("leaves out an ask whose thread the reader's lists do not hold", () => {
    expect(
      waitingAsksFrom(
        { ...none, toolApprovals: [toolApproval({ threadId: hiddenThread })] },
        readThread,
      ),
    ).toEqual([]);
  });
});
