import { expect, it } from "vitest";
import { decodeBrowserDownloadPermissionsCommand } from "./browserDownloadPermissions";
const review = {
  kind: "review",
  routineId: "10000000-0000-4000-8000-000000000001",
  profile: { kind: "personal" },
  origin: "https://reports.example",
  sourceOrigins: ["https://reports.example", "https://files.example"],
  folderId: `folder_${"a".repeat(64)}`,
  directory: "reports",
  mediaTypes: ["text/plain"],
  maxFiles: 5,
  maxBytes: 125 * 1_048_576,
  durationMinutes: 10080,
};
it("reviews explicit source, relative destination, types and bounded limits without accepting a caller-supplied root", () => {
  expect(decodeBrowserDownloadPermissionsCommand(review)).toMatchObject(review);
  for (const extra of [
    { canonicalRoot: "/private" },
    { target: { modelId: "other" } },
    { directory: "../other" },
    { sourceOrigins: ["https://files.example/private?token=x"] },
    { sourceOrigins: ["https://user:password@files.example"] },
    { origin: "http://reports.example" },
    { mediaTypes: ["application/x-elf"] },
    { maxFiles: 101 },
    { maxBytes: 251 * 1_048_576 },
    { durationMinutes: 43201 },
  ])
    expect(() => decodeBrowserDownloadPermissionsCommand({ ...review, ...extra })).toThrow();
});
