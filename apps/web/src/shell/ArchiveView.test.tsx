import { decodeChatThread } from "@octant/contracts/chat";
import { decodeProjectId } from "@octant/contracts/projects";
import { decodeProviderInstanceId, decodeProviderModelId } from "@octant/contracts/providers";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
import { ArchiveView, type ArchivedThreadEntry } from "./ArchiveView";

const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");

function archivedChatThread() {
  return decodeChatThread({
    id: "20000000-0000-4000-8000-000000000001",
    projectId,
    title: "Archived conversation",
    lifecycle: "archived",
    providerInstanceId: decodeProviderInstanceId("30000000-0000-4000-8000-000000000001"),
    modelId: decodeProviderModelId("fixture-model"),
    researchEnabled: false,
    researchRouting: "automatic",
    personalityInstructions: "Be precise.",
    version: 1,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-03T10:00:00.000Z",
  });
}

const codeEntry: ArchivedThreadEntry = {
  mode: "code",
  projectId: String(projectId),
  threadId: "40000000-0000-4000-8000-000000000001",
  title: "Archived implementation",
  updatedAt: "2026-08-02T10:00:00.000Z",
};

const unfiledWorkEntry: ArchivedThreadEntry = {
  mode: "work",
  threadId: "50000000-0000-4000-8000-000000000001",
  title: "Archived brief",
  updatedAt: "2026-08-01T10:00:00.000Z",
};

describe("ArchiveView", () => {
  it("lists archived threads from every mode and filters them by Project", async () => {
    const user = userEvent.setup();
    render(
      <ArchiveView
        chatClient={{ search: vi.fn(async () => [archivedChatThread()]) }}
        entries={[codeEntry, unfiledWorkEntry]}
        onClose={vi.fn()}
        onOpenThread={vi.fn()}
        projects={[{ id: String(projectId), name: "Octant" }]}
      />,
    );

    expect(await screen.findByRole("button", { name: /Archived conversation/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Archived implementation/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Archived brief/ })).toBeVisible();

    await chooseSelectFieldOption(user, screen.getByLabelText("Filter archive by Project"), "Octant");
    expect(screen.getByRole("button", { name: /Archived conversation/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Archived implementation/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Archived brief/ })).not.toBeInTheDocument();
  });

  it("opens an archived thread through the caller's authoritative route", async () => {
    const user = userEvent.setup();
    const onOpenThread = vi.fn();
    render(
      <ArchiveView
        chatClient={{ search: vi.fn(async () => []) }}
        entries={[codeEntry]}
        onClose={vi.fn()}
        onOpenThread={onOpenThread}
        projects={[{ id: String(projectId), name: "Octant" }]}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Archived implementation/ })).toBeVisible(),
    );
    await user.click(screen.getByRole("button", { name: /Archived implementation/ }));
    expect(onOpenThread).toHaveBeenCalledWith(codeEntry);
  });
});
