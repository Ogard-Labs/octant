import {
  decodeSandboxPolicy,
  decodeSandboxRestrictionsSnapshot,
  type SandboxRestrictionsScope,
} from "@octant/contracts/sandbox-policy";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SandboxRestrictionsSettings } from "./SandboxRestrictionsSettings";
const threadId = "74000000-0000-4000-8000-000000000001";
const projectId = "74000000-0000-4000-8000-000000000002";
const policy = decodeSandboxPolicy({
  schemaVersion: 1,
  revision: 2,
  filesystem: { readOnlyRoots: [], readWriteRoots: [], protectedPaths: [] },
  network: "existing-policy",
  hostServices: "blocked",
  credentials: "existing-policy",
});
function snapshot(scope: SandboxRestrictionsScope) {
  return decodeSandboxRestrictionsSnapshot({
    kind: "sandbox-restrictions",
    scope,
    version: 2,
    source: "project",
    policy,
    inherited: true,
    running: true,
    summary: "Writes: Project. Network: Safe networks.",
    limitations: ["Protected project paths are unsupported on this host."],
    capabilities: {
      folders: true,
      protectedPaths: false,
      isolatedCredentials: false,
      blockedHostServices: true,
    },
    denials: [
      {
        id: "74000000-0000-4000-8000-000000000003",
        threadId,
        projectId,
        code: "sandbox-write-denied",
        ruleId: "filesystem.allowedFolders",
        operation: "write",
        resource: "/shared/library",
        message: "Write access is blocked.",
        remedy: "Review the exact folder.",
        count: 3,
        grantable: true,
        dismissed: false,
      },
    ],
  });
}
function fixture() {
  const settings = vi.fn(async (scope: SandboxRestrictionsScope) => snapshot(scope));
  const change = vi.fn(async () => ({
    kind: "sandbox-restrictions-refused" as const,
    reason: "stale-version" as const,
    message: "Settings changed. Reload before saving.",
  }));
  return { settings, change };
}
describe("sandbox restrictions settings", () => {
  it("opens the requested session, explains immutable turns and shows an exact exception before granting", async () => {
    const client = fixture();
    const user = userEvent.setup();
    render(
      <SandboxRestrictionsSettings
        client={client}
        scopes={[
          { id: threadId, label: "Session · Current task", scope: { kind: "session", threadId } },
        ]}
        initialScope={{ kind: "session", threadId }}
      />,
    );
    expect(await screen.findByText(/A turn is running/)).toBeVisible();
    expect(client.settings).toHaveBeenCalledWith(
      { kind: "session", threadId },
      expect.any(AbortSignal),
    );
    expect(
      screen.getByText(
        "Grant write access to /shared/library. Saved for future runs; this does not enable Strict.",
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Allow for this session" }));
    expect(client.change).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "grant-denial", duration: "session", expectedVersion: 2 }),
    );
    expect(await screen.findByText("Settings changed. Reload before saving.")).toBeVisible();
  });
  it("refreshes active and pending Strict without replacing a local draft or its optimistic version", async () => {
    const client = fixture();
    const user = userEvent.setup();
    render(<SandboxRestrictionsSettings client={client} />);
    await user.type(
      await screen.findByRole("textbox", { name: "Allowed folder path" }),
      "/shared/unsaved",
    );
    await user.click(screen.getByRole("button", { name: /^Add$/ }));
    client.settings.mockImplementation(async (scope) => ({
      ...snapshot(scope),
      version: 3,
      strict: false,
      activeStrict: true,
      pending: true,
      summary: "The admitted Strict policy remains active.",
    }));
    expect(
      await screen.findByText(/Strict active.*changes pending/, {}, { timeout: 5000 }),
    ).toBeVisible();
    expect(screen.getByText("/shared/unsaved")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Save sandbox restrictions" }));
    expect(client.change).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 2 }));
  });

  it("retains the folder draft when a stale save is refused", async () => {
    const client = fixture();
    const user = userEvent.setup();
    render(<SandboxRestrictionsSettings client={client} />);
    const input = await screen.findByRole("textbox", { name: "Allowed folder path" });
    await user.type(input, "/shared/new-folder");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Save sandbox restrictions" }));
    expect(await screen.findByText("Settings changed. Reload before saving.")).toBeVisible();
    expect(screen.getByText("/shared/new-folder")).toBeVisible();
    expect(client.change).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "set-policy",
        policy: expect.objectContaining({
          filesystem: expect.objectContaining({ readOnlyRoots: ["/shared/new-folder"] }),
        }),
      }),
    );
  });
});
