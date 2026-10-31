import type { BrowserAutomationSnapshot } from "@octant/contracts/browser-automation-rpc";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrowserPreviewThumbnail } from "./BrowserPreviewThumbnail";

function snapshot(profile: unknown): BrowserAutomationSnapshot {
  return {
    status: "running",
    threadId: "50000000-0000-4000-8000-000000000001",
    context: {
      contextId: "30000000-0000-4000-8000-000000000001",
      state: "active",
      policy: { profileMode: "isolated", ...(profile === undefined ? {} : { profile }) },
    },
    observation: {
      title: "Your account",
      url: "https://github.com/settings",
      screenshotDataUrl: "data:image/jpeg;base64,AQID",
      stale: false,
    },
    evidence: [],
  } as unknown as BrowserAutomationSnapshot;
}

describe("BrowserPreviewThumbnail", () => {
  it("names the profile of a signed-in page beside the page", () => {
    render(
      <BrowserPreviewThumbnail
        onClose={() => undefined}
        snapshot={snapshot({ kind: "personal" })}
      />,
    );

    expect(screen.getByText("Personal")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open Browser: Your account, Personal profile" }),
    ).toBeInTheDocument();
  });

  it("names a Project profile as a Project", () => {
    render(
      <BrowserPreviewThumbnail
        onClose={() => undefined}
        snapshot={snapshot({ kind: "project", projectId: "40000000-0000-4000-8000-000000000001" })}
      />,
    );

    expect(screen.getByText("Project")).toBeInTheDocument();
  });

  it("says nothing about the profile of a Private page or one with none", () => {
    const { rerender } = render(
      <BrowserPreviewThumbnail
        onClose={() => undefined}
        snapshot={snapshot({ kind: "private" })}
      />,
    );
    expect(screen.getByRole("button", { name: "Open Browser: Your account" })).toBeInTheDocument();

    rerender(<BrowserPreviewThumbnail onClose={() => undefined} snapshot={snapshot(undefined)} />);
    expect(screen.getByRole("button", { name: "Open Browser: Your account" })).toBeInTheDocument();
    expect(screen.queryByText("Personal")).not.toBeInTheDocument();
  });
});
