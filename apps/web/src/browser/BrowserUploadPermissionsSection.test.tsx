import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { decodeBrowserUploadPermissionsResult } from "@octant/contracts/browser-upload-permissions";
import { BrowserUploadPermissionsSection } from "./BrowserUploadPermissionsSection";
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
  files: [{ path: "daily.csv", sizeBytes: 100, sha256: "c".repeat(64), fileType: ".csv" }],
  maxFiles: 5,
  maxBytes: 125 * 1_048_576,
  grantedAt: "2026-11-07T10:00:00.000Z",
  expiresAt: "2026-11-14T10:00:00.000Z",
};
it("reviews the exact routine, folder, file contents, site and quotas before granting or revoking", async () => {
  let granted = false;
  const manageUploadPermissions = vi.fn(async (command) =>
    decodeBrowserUploadPermissionsResult(
      command.kind === "targets"
        ? {
            kind: "upload-permission-targets",
            targets: [{ target: permission.target, folders: [permission.folder] }],
          }
        : command.kind === "list"
          ? {
              kind: "upload-permissions",
              permissions: granted
                ? [{ permission, remainingFiles: 5, remainingBytes: permission.maxBytes }]
                : [],
            }
          : command.kind === "review"
            ? {
                kind: "upload-permission-review",
                reviewId: "60000000-0000-4000-8000-000000000001",
                permission,
              }
            : command.kind === "grant"
              ? ((granted = true), { kind: "upload-permission-granted", permission })
              : ((granted = false),
                { kind: "upload-permission-revoked", permissionId: permission.permissionId }),
    ),
  );
  render(
    <BrowserUploadPermissionsSection
      client={{ manageUploadPermissions }}
      profiles={[{ profile: { kind: "personal" }, label: "Personal", sizeBytes: 0 }]}
    />,
  );
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "New upload manifest…" }));
  await user.click(screen.getByRole("combobox", { name: "Upload routine" }));
  await user.click(await screen.findByRole("option", { name: "Send report" }));
  await user.click(screen.getByRole("combobox", { name: "Upload account profile" }));
  await user.click(await screen.findByRole("option", { name: "Personal" }));
  await user.click(screen.getByRole("combobox", { name: "Upload source folder" }));
  await user.click(await screen.findByRole("option", { name: "Reports" }));
  await user.type(
    screen.getByRole("textbox", { name: "Upload HTTPS site" }),
    "https://example.com",
  );
  await user.type(screen.getByRole("textbox", { name: "Upload file paths" }), "daily.csv");
  await user.click(screen.getByRole("button", { name: "Review files" }));
  expect(await screen.findByText("example-model")).toBeVisible();
  expect(screen.getByText(/daily.csv/)).toBeVisible();
  expect(manageUploadPermissions.mock.calls.some(([command]) => command.kind === "grant")).toBe(
    false,
  );
  expect(
    manageUploadPermissions.mock.calls.find(([command]) => command.kind === "review")?.[0],
  ).toMatchObject({
    folderId: permission.folder.id,
    files: ["daily.csv"],
    maxFiles: 5,
    maxBytes: permission.maxBytes,
    durationMinutes: 10080,
  });
  await user.click(screen.getByRole("button", { name: "Grant upload manifest" }));
  await user.click(
    await screen.findByRole("button", { name: "Revoke upload permission for Send report" }),
  );
  expect(await screen.findByText(/Upload permission revoked/)).toBeVisible();
  expect(await screen.findByText("No recurring upload permissions.")).toBeVisible();
});
