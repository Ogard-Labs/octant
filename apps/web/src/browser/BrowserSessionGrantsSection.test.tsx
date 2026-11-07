import { expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decodeBrowserSessionGrantsResult } from "@octant/contracts/browser-session-grants";
import { BrowserSessionGrantsSection } from "./BrowserSessionGrantsSection";

const grant = {
  grantId: "10000000-0000-4000-8000-000000000001",
  target: {
    grantee: { kind: "child", runId: "20000000-0000-4000-8000-000000000001" },
    label: "Read the daily report",
    modelId: "example-model",
    authority: {
      hostId: "30000000-0000-4000-8000-000000000001",
      mode: "work",
      projectId: "40000000-0000-4000-8000-000000000001",
      providerInstanceId: "50000000-0000-4000-8000-000000000001",
      extension: { kind: "core" },
    },
  },
  profile: { kind: "personal" },
  profileLabel: "Personal",
  origins: ["https://example.com"],
  grantedAt: "2026-11-07T10:00:00.000Z",
  expiresAt: "2026-11-07T10:15:00.000Z",
};

it("reviews the exact caller, account and site before granting and keeps revocation visible", async () => {
  const user = userEvent.setup();
  let active = false;
  const manageSessionGrants = vi.fn(async (command) =>
    decodeBrowserSessionGrantsResult(
      command.kind === "targets"
        ? { kind: "browser-session-targets", targets: [grant.target] }
        : command.kind === "list"
          ? { kind: "browser-session-grants", grants: active ? [grant] : [] }
          : command.kind === "review"
            ? {
                kind: "browser-session-review",
                reviewId: "60000000-0000-4000-8000-000000000001",
                grant,
              }
            : command.kind === "grant"
              ? ((active = true), { kind: "browser-session-granted", grant })
              : ((active = false), { kind: "browser-session-revoked", grantId: grant.grantId }),
    ),
  );
  render(
    <BrowserSessionGrantsSection
      client={{ manageSessionGrants }}
      profiles={[{ profile: { kind: "personal" }, label: "Personal", sizeBytes: 0 }]}
    />,
  );
  await user.click(await screen.findByRole("button", { name: "New session permission…" }));
  await user.click(screen.getByRole("combobox", { name: "Caller" }));
  await user.click(await screen.findByRole("option", { name: "Child · Read the daily report" }));
  await user.click(screen.getByRole("combobox", { name: "Profile" }));
  await user.click(await screen.findByRole("option", { name: "Personal" }));
  await user.type(screen.getByRole("textbox", { name: "HTTPS origins" }), "https://example.com");
  await user.click(screen.getByRole("button", { name: "Review permission" }));
  expect(await screen.findByText("example-model")).toBeVisible();
  expect(screen.getByText("https://example.com")).toBeVisible();
  expect(manageSessionGrants.mock.calls.some(([command]) => command.kind === "grant")).toBe(false);
  await user.click(screen.getByRole("button", { name: "Grant session permission" }));
  const revoke = await screen.findByRole("button", {
    name: "Revoke permission for Read the daily report",
  });
  await user.click(revoke);
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Revoke permission for Read the daily report" }),
    ).toBeNull(),
  );
});
