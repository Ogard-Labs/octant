import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeCodeThreadId, decodeCodeCheckoutId } from "@octant/contracts";
import { languageEditPreview } from "./languageEditPreview";
import { liveCodeTestSourcePort } from "./codeDirectoryPort";

describe("reviewed language edits", () => {
  it("previews multiple files without writing and refuses unsaved, overlapping and escaping edits", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "octant-reviewed-edits-")));
    try {
      await writeFile(join(root, "a.ts"), "const old = 1;\n");
      await writeFile(join(root, "b.ts"), "old();\n");
      await symlink("/etc/hosts", join(root, "escape.ts"));
      const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } };
      const edit = { range, newText: "new" };
      const changes = { [pathToFileURL(join(root, "b.ts")).href]: [edit] };
      const input = {
        root,
        port: liveCodeTestSourcePort,
        threadId: decodeCodeThreadId("20000000-0000-4000-8000-000000000001"),
        checkoutId: decodeCodeCheckoutId("30000000-0000-4000-8000-000000000001"),
        current: () => true,
        openText: (_uri: string) => undefined as string | undefined,
      };
      const result = await languageEditPreview({ ...input, result: { changes } });
      expect(result).toMatchObject({
        status: "preview",
        files: [{ path: "b.ts", before: "old();\n", after: "new();\n" }],
      });
      expect(
        await languageEditPreview({ ...input, result: { changes }, openText: () => "unsaved" }),
      ).toEqual({ status: "refused", reason: "unsaved-edits" });
      expect(
        await languageEditPreview({
          ...input,
          result: { changes: { [pathToFileURL(join(root, "escape.ts")).href]: [edit] } },
        }),
      ).toMatchObject({ status: "refused" });
      expect(
        await languageEditPreview({
          ...input,
          result: { changes: { [pathToFileURL(join(root, "b.ts")).href]: [edit, edit] } },
        }),
      ).toMatchObject({ status: "refused", reason: "invalid-edit" });
      expect(
        await languageEditPreview({
          ...input,
          result: {
            documentChanges: [{ kind: "delete", uri: pathToFileURL(join(root, "b.ts")).href }],
          },
        }),
      ).toMatchObject({ status: "refused" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
