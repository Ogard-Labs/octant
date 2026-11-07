import { expect, it } from "vitest";
import { decodeBrowserUploadPermissionsCommand } from "./browserUploadPermissions";
const review = {
  kind: "review",
  routineId: "10000000-0000-4000-8000-000000000001",
  profile: { kind: "personal" },
  origin: "https://example.com",
  folderId: `folder_${"a".repeat(64)}`,
  files: ["report.csv"],
  maxFiles: 5,
  maxBytes: 1000,
  durationMinutes: 10080,
};
it("accepts an exact bounded manifest but no caller-provided authority, absolute path or unbounded quota", () => {
  expect(decodeBrowserUploadPermissionsCommand(review)).toMatchObject({
    files: ["report.csv"],
    maxFiles: 5,
  });
  for (const change of [
    { authority: { mode: "work" } },
    { root: "/private" },
    { files: ["../report.csv"] },
    { files: ["/private/report.csv"] },
    { maxFiles: 101 },
    { durationMinutes: 43201 },
  ])
    expect(() => decodeBrowserUploadPermissionsCommand({ ...review, ...change })).toThrow();
});
