import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { decodeBrowserDownloadPermissionsResult } from "@octant/contracts/browser-download-permissions";
import { BrowserDownloadPermissionsSection } from "./BrowserDownloadPermissionsSection";
const permission = {
  permissionId: "10000000-0000-4000-8000-000000000001",
  target: {
    grantee: { kind: "routine", routineId: "20000000-0000-4000-8000-000000000001" },
    label: "Send report",
    modelId: "example-model",
    authority: {
      hostId: "30000000-0000-4000-8000-000000000001",
      mode: "work",
      projectId: "40000000-0000-4000-8000-000000000001",
      providerInstanceId: "50000000-0000-4000-8000-000000000001",
      extension: { kind: "core" },
    },
  },
  recipientRevisionDigest: `sha256:${"a".repeat(64)}`,
  profile: { kind: "personal" },
  origin: "https://example.com",
  folder: { id: `folder_${"b".repeat(64)}`, label: "Reports", kind: "extra" },
  sourceOrigins: ["https://example.com", "https://files.example.com"],
  directory: "reports",
  mediaTypes: ["text/plain", "image/png"],
  maxFiles: 5,
  maxBytes: 125 * 1_048_576,
  grantedAt: "2026-11-07T10:00:00.000Z",
  expiresAt: "2026-11-14T10:00:00.000Z",
};
it("reviews the exact routine, destination, complete source sites, file types and quotas before granting or revoking", async () => {
  let granted = false;
  const manageDownloadPermissions = vi.fn(async (command) =>
    decodeBrowserDownloadPermissionsResult(
      command.kind === "targets"
        ? {
            kind: "download-permission-targets",
            targets: [{ target: permission.target, folders: [permission.folder] }],
          }
        : command.kind === "list"
          ? {
              kind: "download-permissions",
              permissions: granted
                ? [{ permission, remainingFiles: 5, remainingBytes: permission.maxBytes }]
                : [],
            }
          : command.kind === "review"
            ? {
                kind: "download-permission-review",
                reviewId: "60000000-0000-4000-8000-000000000001",
                permission,
              }
            : command.kind === "grant"
              ? ((granted = true), { kind: "download-permission-granted", permission })
              : ((granted = false),
                { kind: "download-permission-revoked", permissionId: permission.permissionId }),
    ),
  );
  render(
    <BrowserDownloadPermissionsSection
      client={{ manageDownloadPermissions }}
      profiles={[{ profile: { kind: "personal" }, label: "Personal", sizeBytes: 0 }]}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "New download manifest…" }));
  await user.click(screen.getByRole("combobox", { name: "Download routine" }));
  await user.click(await screen.findByRole("option", { name: "Send report" }));
  await user.click(screen.getByRole("combobox", { name: "Download account profile" }));
  await user.click(await screen.findByRole("option", { name: "Personal" }));
  await user.click(screen.getByRole("combobox", { name: "Download destination folder" }));
  await user.click(await screen.findByRole("option", { name: "Reports" }));
  await user.type(
    screen.getByRole("textbox", { name: "Download HTTPS site" }),
    "https://example.com",
  );
  await user.type(
    screen.getByRole("textbox", { name: "Download source sites" }),
    "https://example.com\nhttps://files.example.com",
  );
  await user.clear(screen.getByRole("textbox", { name: "Download destination directory" }));
  await user.type(
    screen.getByRole("textbox", { name: "Download destination directory" }),
    "reports",
  );
  await user.click(screen.getByRole("checkbox", { name: "PDF" }));
  expect(screen.getByRole("checkbox", { name: "PDF" })).not.toBeChecked();
  await user.click(screen.getByRole("checkbox", { name: "PNG images" }));
  expect(screen.getByRole("checkbox", { name: "PNG images" })).toBeChecked();
  await user.click(screen.getByRole("button", { name: "Review sources and destination" }));
  expect(await screen.findByText("example-model")).toBeVisible();
  expect(screen.getByText("https://files.example.com")).toBeVisible();
  expect(screen.getByText("reports")).toBeVisible();
  expect(manageDownloadPermissions.mock.calls.some(([command]) => command.kind === "grant")).toBe(
    false,
  );
  expect(
    manageDownloadPermissions.mock.calls.find(([command]) => command.kind === "review")?.[0],
  ).toMatchObject({
    folderId: permission.folder.id,
    sourceOrigins: permission.sourceOrigins,
    directory: "reports",
    mediaTypes: ["text/plain", "image/png"],
    maxFiles: 5,
    maxBytes: permission.maxBytes,
    durationMinutes: 10080,
  });
  await user.click(screen.getByRole("button", { name: "Grant download manifest" }));
  await user.click(
    await screen.findByRole("button", { name: "Revoke download permission for Send report" }),
  );
  expect(await screen.findByText(/Download permission revoked/)).toBeVisible();
  expect(await screen.findByText("No recurring download permissions.")).toBeVisible();
});
