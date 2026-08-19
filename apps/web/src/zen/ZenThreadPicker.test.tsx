import {
  LOCAL_HOST_ID,
  decodeChatThreadId,
  decodeProjectId,
  decodeProviderInstanceId,
  decodeZenThreadCatalogEntry,
  decodeZenThreadCatalogRef,
} from "@octant/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ZenThreadPicker } from "./ZenThreadPicker";

const threadId = decodeChatThreadId("00000000-0000-4000-8000-000000000001");
const catalogRef = decodeZenThreadCatalogRef(`chat:${threadId}`);
const entry = decodeZenThreadCatalogEntry({
  catalogRef,
  hostId: LOCAL_HOST_ID,
  hostLabel: "This Mac",
  mode: "chat",
  projectId: decodeProjectId("00000000-0000-4000-8000-000000000002"),
  projectLabel: "AuroraDocs",
  threadId,
  title: "Release blocker",
  status: "active",
  recentActivityAt: "2026-07-28T12:00:00.000Z",
  providerInstanceId: decodeProviderInstanceId("00000000-0000-4000-8000-000000000003"),
  modelId: "model-local",
  sourceContext: {
    hostId: LOCAL_HOST_ID,
    mode: "chat",
    projectId: "00000000-0000-4000-8000-000000000002",
    threadKind: "chat",
    threadId,
  },
});

describe("ZenThreadPicker", () => {
  it("shows source identity and pins the exact catalog reference", () => {
    const onPin = vi.fn();
    const onQueryChange = vi.fn();
    render(
      <ZenThreadPicker
        entries={[entry]}
        onPin={onPin}
        onClose={vi.fn()}
        onQueryChange={onQueryChange}
        query=""
      />,
    );

    expect(screen.getByText("Release blocker")).toBeInTheDocument();
    expect(screen.getByText(/This Mac.*Chat.*AuroraDocs.*active/i)).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "release" } });
    fireEvent.click(screen.getByRole("button", { name: "Pin Release blocker" }));
    expect(onQueryChange).toHaveBeenCalledWith("release");
    expect(onPin).toHaveBeenCalledWith(catalogRef);
  });
});
