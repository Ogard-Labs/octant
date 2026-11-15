import {
  decodeProjectId,
  decodeProviderInstanceId,
  type KeyProviderDriverKinds,
  type ThreadProjectCode,
} from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerNoticeCard } from "../composer/ComposerNoticeCard";
import { useProjectTrustNotice } from "./ProjectTrustNotice";
import {
  ThreadNativeSetupProvider,
  type ThreadNativeSetupServices,
} from "./ThreadNativeSetupControl";

const claudeId = decodeProviderInstanceId("90000000-0000-4000-8000-000000000011");
const projectId = decodeProjectId("90000000-0000-4000-8000-000000000012");
const threadId = "90000000-0000-4000-8000-000000000013";

const untrusted: ThreadProjectCode = {
  status: "untrusted",
  provider: "claude",
  found: ["settings", "mcp-servers"],
};

afterEach(() => {
  globalThis.localStorage.clear();
});

function services(input: {
  readonly projectCode?: ThreadProjectCode;
  readonly nativeProviders?: KeyProviderDriverKinds;
  readonly canTrust?: boolean;
}) {
  const setProjectNativeProviders = vi.fn(
    async (_project: unknown, _providers: KeyProviderDriverKinds) => true,
  );
  const host: ThreadNativeSetupServices = {
    instances: [{ id: claudeId, driverKind: "claude" }],
    read: vi.fn(async () => "inherit" as const),
    change: vi.fn(async () => "inherit" as const),
    readProjectCode: vi.fn(async () => input.projectCode ?? untrusted),
    projects: [
      {
        id: projectId,
        type: "code",
        ...(input.nativeProviders === undefined ? {} : { nativeProviders: input.nativeProviders }),
      } as never,
    ],
    ...(input.canTrust === false ? {} : { setProjectNativeProviders }),
  };
  return { host, setProjectNativeProviders };
}

function Thread() {
  const notice = useProjectTrustNotice({
    mode: "code",
    threadId,
    projectId,
    providerInstanceId: claudeId,
  });
  return <ComposerNoticeCard idPrefix="composer" notices={notice === undefined ? [] : [notice]} />;
}

describe("the Project trust prompt in a thread", () => {
  it("names the provider and what would load, and Trust sends the Project's trust command", async () => {
    const { host, setProjectNativeProviders } = services({ nativeProviders: ["codex"] });
    render(
      <ThreadNativeSetupProvider services={host}>
        <Thread />
      </ThreadNativeSetupProvider>,
    );
    expect(
      await screen.findByText(
        "This Project has its own Claude Code settings and MCP servers. They load once you trust this Project for Claude Code.",
      ),
    ).toBeTruthy();
    expect(host.readProjectCode).toHaveBeenCalledWith(threadId, "code");
    await userEvent.click(screen.getByRole("button", { name: "Trust for Claude Code" }));
    await waitFor(() =>
      expect(setProjectNativeProviders).toHaveBeenCalledWith(projectId, ["claude", "codex"]),
    );
  });

  it("hides after Not now and stays hidden for this Project and provider when the thread opens again", async () => {
    const { host } = services({});
    const first = render(
      <ThreadNativeSetupProvider services={host}>
        <Thread />
      </ThreadNativeSetupProvider>,
    );
    await userEvent.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("button", { name: "Not now" })).toBeNull();
    first.unmount();

    render(
      <ThreadNativeSetupProvider services={host}>
        <Thread />
      </ThreadNativeSetupProvider>,
    );
    await waitFor(() => expect(host.readProjectCode).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/This Project has its own/)).toBeNull();
  });

  it("does not show once the Project trusts the provider, or when the Project holds none of its code", async () => {
    const trusted = services({ nativeProviders: ["claude"] });
    const { unmount } = render(
      <ThreadNativeSetupProvider services={trusted.host}>
        <Thread />
      </ThreadNativeSetupProvider>,
    );
    await waitFor(() => expect(trusted.host.readProjectCode).toHaveBeenCalled());
    expect(screen.queryByText(/This Project has its own/)).toBeNull();
    unmount();

    const none = services({ projectCode: { status: "none" } });
    render(
      <ThreadNativeSetupProvider services={none.host}>
        <Thread />
      </ThreadNativeSetupProvider>,
    );
    await waitFor(() => expect(none.host.readProjectCode).toHaveBeenCalled());
    expect(screen.queryByText(/This Project has its own/)).toBeNull();
  });

  it("offers to trust the Project for OpenCode when it holds its own OpenCode configuration", async () => {
    const { host, setProjectNativeProviders } = services({
      projectCode: { status: "untrusted", provider: "opencode", found: ["settings"] },
    });
    render(
      <ThreadNativeSetupProvider services={host}>
        <Thread />
      </ThreadNativeSetupProvider>,
    );
    expect(
      await screen.findByText(
        "This Project has its own OpenCode settings. They load once you trust this Project for OpenCode.",
      ),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Trust for OpenCode" }));
    await waitFor(() =>
      expect(setProjectNativeProviders).toHaveBeenCalledWith(projectId, ["opencode"]),
    );
  });

  it("shows the words without Trust in a window that cannot change the Project's trust", async () => {
    const { host } = services({ canTrust: false });
    render(
      <ThreadNativeSetupProvider services={host}>
        <Thread />
      </ThreadNativeSetupProvider>,
    );
    expect(await screen.findByText(/This Project has its own Claude Code/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Trust for Claude Code" })).toBeNull();
    expect(screen.getByRole("button", { name: "Not now" })).toBeTruthy();
  });
});
