import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OctantCommandProvider } from "../palette/CommandRegistry";
import { ShellDialogHost, type ShellDialogHostProps } from "./ShellDialogHost";

// The wizard is fetched on demand, and importing its module is the launch cost
// this host exists to avoid once first run has been answered. Counting the
// import is the only way to observe that from here.
const { importedOnboarding } = vi.hoisted(() => ({ importedOnboarding: vi.fn() }));
vi.mock("../onboarding/FirstRunOnboarding", () => {
  importedOnboarding();
  return { FirstRunOnboarding: () => <div data-testid="first-run" /> };
});

describe("ShellDialogHost", () => {
  it("keeps the command palette inert while Zen is active", () => {
    render(
      <OctantCommandProvider commands={[]}>
        <ShellDialogHost {...hostProps()} zenActive />
      </OctantCommandProvider>,
    );

    expect(screen.queryByRole("combobox", { name: "Search commands" })).not.toBeInTheDocument();
  });

  it("leaves the first-run wizard unfetched once first run has been answered", async () => {
    render(
      <OctantCommandProvider commands={[]}>
        <ShellDialogHost {...hostProps()} />
      </OctantCommandProvider>,
    );

    await waitFor(() => expect(screen.queryByTestId("first-run")).not.toBeInTheDocument());
    expect(importedOnboarding).not.toHaveBeenCalled();
  });
});

function hostProps(): ShellDialogHostProps {
  return {
    announcement: "",
    announcementSequence: 0,
    createOpen: false,
    folderBrowseClient: { browse: vi.fn(), select: vi.fn() } as never,
    firstRun: {
      chatModelGroups: [],
      controller: {
        visible: false,
        status: "complete",
        currentStep: "profile",
        canContinue: false,
        busy: false,
        finish: vi.fn(),
        goBack: vi.fn(),
        goTo: vi.fn(),
      },
      navigatorModelGroups: [],
      onClearNavigatorDefault: vi.fn(),
      onOpenProviderSettings: vi.fn(),
      onRescan: vi.fn(),
      onSaveProfile: vi.fn(),
      onSelectChatDefault: vi.fn(),
      onSelectColorScheme: vi.fn(),
      onSelectModeSwitcher: vi.fn(),
      onSelectNavigatorDefault: vi.fn(),
      onToggleChat: vi.fn(),
      onToggleWork: vi.fn(),
      projects: [],
      onCreateProject: vi.fn(),
      onStartThread: vi.fn(),
      profile: {
        displayName: "",
        version: 1,
        updatedAt: "2026-07-20T08:00:00.000Z",
      } as never,
      readiness: {
        providers: "ready",
        chatDefault: "ready",
        navigator: "ready",
      } as never,
      scanning: false,
      workspace: {
        colorScheme: "system",
        chatEnabled: true,
        workEnabled: true,
        modeSwitcher: "buttons",
      },
    } as never,
    hostId: "local",
    mode: "chat",
    onCloseCreate: vi.fn(),
    onCloseSearch: vi.fn(),
    onCreateProject: vi.fn(),
    onCreatedProject: vi.fn(),
    onOpenCodeSearchFile: vi.fn(),
    onOpenSearchHit: vi.fn(),
    onSearchQueryChange: vi.fn(),
    projectAnnouncement: "",
    projectAnnouncementSequence: 0,
    searchArchivedListing: "ready",
    searchListing: "ready",
    searchOpen: false,
    searchProjects: [],
    searchThreads: [],
    zenActive: false,
  } as ShellDialogHostProps;
}
