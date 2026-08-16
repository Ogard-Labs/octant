import {
  decodeChatBootstrap,
  decodeChatThreadView,
  decodeProjectId,
  decodeWorkspaceTab,
  type ProjectSummary,
  type WorkspaceTab,
} from "@octant/contracts";
import { defaultEnvironmentPresentationState } from "@octant/domain/shell-policy";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatController } from "../chat/useChatController";
import { ChatThreadEnvironment } from "./ChatThreadEnvironment";

const now = "2026-07-28T16:00:00.000Z";
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000901");
const threadId = "00000000-0000-4000-8000-000000000701";
const providerId = "00000000-0000-4000-8000-000000000902";
const tabA = chatTab("30000000-0000-4000-8000-00000000000a");
const tabB = chatTab("30000000-0000-4000-8000-00000000000b");

function chatTab(id: string): Extract<WorkspaceTab, { readonly kind: "chat-thread" }> {
  return decodeWorkspaceTab({
    kind: "chat-thread",
    id,
    threadId,
    mode: "chat",
    title: "Release plan",
  }) as Extract<WorkspaceTab, { readonly kind: "chat-thread" }>;
}

function chatProject(): ProjectSummary {
  return {
    id: projectId,
    type: "chat",
    name: "Planning",
    lifecycle: "active",
    pinned: true,
    rank: "0/1" as ProjectSummary["rank"],
    version: 1 as ProjectSummary["version"],
    createdAt: now as ProjectSummary["createdAt"],
    updatedAt: now as ProjectSummary["updatedAt"],
  } as ProjectSummary;
}

function controller(): ChatController {
  const thread = {
    id: threadId,
    projectId,
    title: "Release plan",
    lifecycle: "active" as const,
    providerInstanceId: providerId,
    modelId: "model-a",
    researchEnabled: false,
    researchRouting: "automatic" as const,
    personalityInstructions: "Be concise.",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  const activeView = decodeChatThreadView({
    thread,
    turns: [],
    lastSequence: 0,
    contents: [],
    attachments: [
      {
        id: "10000000-0000-4000-8000-000000000001",
        threadId,
        displayName: "brief.txt",
        mediaType: "text/plain",
        byteLength: 5,
        digest: "a".repeat(64),
        status: "finalized",
        createdAt: now,
      },
    ],
    citations: [],
    workItems: [],
    workListVersion: 0,
    followUpVersion: 0,
  });
  return {
    activeView,
    bootstrap: decodeChatBootstrap({
      settings: {
        defaultProviderInstanceId: providerId,
        defaultModelId: "model-a",
        defaultResearchEnabled: false,
        defaultResearchRouting: "automatic",
        defaultPersonalityInstructions: "Be concise.",
        version: 1,
        updatedAt: now,
      },
      threads: [thread],
    }),
    errorMessage: undefined,
    execute: vi.fn(),
    navigation: [],
    pendingDraft: "",
    retry: vi.fn(),
    sendTurn: vi.fn(),
    setPendingDraft: vi.fn(),
    status: "ready",
    upload: vi.fn(),
    discard: vi.fn(),
  } as unknown as ChatController;
}

describe("ChatThreadEnvironment", () => {
  it("shares thread facts while retaining independent presentation for two tab views", () => {
    const presentation = {
      ...defaultEnvironmentPresentationState(),
      byTab: [
        { tabId: tabA.id, presentation: "pinned" as const, pinnedWidth: 360 },
        { tabId: tabB.id, presentation: "floating" as const, pinnedWidth: 360 },
      ],
    };
    const authoritative = controller();

    render(
      <>
        <ChatThreadEnvironment
          controller={authoritative}
          onChangePresentation={vi.fn()}
          presentation={presentation}
          projects={[chatProject()]}
          tab={tabA}
        >
          <div>First view</div>
        </ChatThreadEnvironment>
        <ChatThreadEnvironment
          controller={authoritative}
          onChangePresentation={vi.fn()}
          presentation={presentation}
          projects={[chatProject()]}
          tab={tabB}
        >
          <div>Second view</div>
        </ChatThreadEnvironment>
      </>,
    );

    expect(screen.getByRole("region", { name: "Environment for Planning" })).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Environment for Planning" })).toBeVisible();
    expect(screen.getAllByText("1 attachment")).toHaveLength(2);
    expect(screen.getByText("First view")).toBeVisible();
    expect(screen.getByText("Second view")).toBeVisible();
  });

  it("fails closed when the authoritative thread references an unresolved Project", () => {
    render(
      <ChatThreadEnvironment
        controller={controller()}
        onChangePresentation={vi.fn()}
        presentation={{
          ...defaultEnvironmentPresentationState(),
          byMode: { ...defaultEnvironmentPresentationState().byMode, chat: "pinned" },
        }}
        projects={[]}
        tab={tabA}
      >
        <div />
      </ChatThreadEnvironment>,
    );

    expect(screen.getByRole("region", { name: "Environment for Chat" })).toBeVisible();
    expect(screen.getByText("Project unavailable")).toBeVisible();
    expect(screen.getByText("Authoritative Chat context is unavailable.")).toBeVisible();
    expect(screen.queryByText("Unavailable for unfiled Chat")).not.toBeInTheDocument();
    expect(screen.queryByText("1 attachment")).not.toBeInTheDocument();
    expect(screen.queryByText("Git")).not.toBeInTheDocument();
    expect(screen.queryByText("Approvals")).not.toBeInTheDocument();
  });
});
