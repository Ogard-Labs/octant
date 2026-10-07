import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeCanvasExportRenderedOutput,
  type CanvasExportRenderedOutput,
} from "@octant/contracts/canvas-export";
import { createCanvasExportFilePort } from "./canvasExportFilePort";
import { createFolderExportTarget, type FolderExportAvailability } from "./folderExportTarget";

const directories: string[] = [];
const canvasId = "11111111-1111-4111-8111-111111111111";
const versionId = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * A real folder on this machine, readable and writable by its owner alone.
 *
 * It is named by its real path, as the host's folder browser names every folder
 * it hands out: the system temporary folder on macOS sits behind a link.
 */
function privateFolder(): string {
  const directory = join(realpathSync(tmpdir()), `octant-export-${randomUUID()}`);
  mkdirSync(directory, { mode: 0o700 });
  directories.push(directory);
  return directory;
}

function document(input: {
  readonly title?: string;
  readonly body?: string;
  readonly format?: "markdown" | "html";
}): CanvasExportRenderedOutput {
  const body = input.body ?? "# Launch plan\n";
  return decodeCanvasExportRenderedOutput({
    schemaVersion: 1,
    kind: "canvas-export-output",
    format: input.format ?? "markdown",
    title: input.title ?? "Launch plan",
    body,
    metadata: {
      canvasId,
      versionId,
      sequence: 1,
      byteLength: new TextEncoder().encode(body).length,
      contentDigest: `sha256:${"a".repeat(64)}`,
    },
  });
}

function folderTarget(folder: () => FolderExportAvailability) {
  return createFolderExportTarget({
    availability: folder,
    files: createCanvasExportFilePort(),
    newTempId: randomUUID,
  });
}

describe("the folder export destination", () => {
  it("writes the rendered document and reports the file it wrote", async () => {
    const folder = privateFolder();
    const target = folderTarget(() => ({ kind: "ready", folder }));
    const output = document({});

    const delivery = await target.exportDocument(output);

    expect(delivery).toEqual({
      kind: "receipt",
      receipt: { kind: "path", path: join(folder, "Launch plan.md") },
    });
    expect(readFileSync(join(folder, "Launch plan.md"), "utf8")).toBe(output.body);
    // The write is temp-plus-rename, so the folder holds the export and nothing
    // else — no half-written document and no leftover temporary file.
    expect(readdirSync(folder)).toEqual(["Launch plan.md"]);
  });

  it("names the file it would write and whether one is already there", async () => {
    const folder = privateFolder();
    const target = folderTarget(() => ({ kind: "ready", folder }));

    expect(target.describeDestination?.(document({}))).toEqual({
      path: join(folder, "Launch plan.md"),
      replacesExisting: false,
    });

    writeFileSync(join(folder, "Launch plan.md"), "older", "utf8");
    expect(target.describeDestination?.(document({}))).toEqual({
      path: join(folder, "Launch plan.md"),
      replacesExisting: true,
    });
  });

  it("replaces an existing file when the approved destination named it", async () => {
    const folder = privateFolder();
    const target = folderTarget(() => ({ kind: "ready", folder }));
    writeFileSync(join(folder, "Launch plan.md"), "older", "utf8");
    const output = document({ body: "# Launch plan\n\nSecond cut\n" });

    const described = target.describeDestination?.(output);
    expect(described?.replacesExisting).toBe(true);
    const delivery = await target.exportDocument(output, described);

    expect(delivery).toEqual({
      kind: "receipt",
      receipt: { kind: "path", path: join(folder, "Launch plan.md") },
    });
    expect(readFileSync(join(folder, "Launch plan.md"), "utf8")).toBe(output.body);
    expect(readdirSync(folder)).toEqual(["Launch plan.md"]);
  });

  it("writes a numbered copy when an existing name was never confirmed", async () => {
    const folder = privateFolder();
    const target = folderTarget(() => ({ kind: "ready", folder }));
    writeFileSync(join(folder, "Launch plan.md"), "older", "utf8");
    const output = document({});

    await target.exportDocument(output);

    expect(readFileSync(join(folder, "Launch plan.md"), "utf8")).toBe("older");
    expect(readFileSync(join(folder, "Launch plan (2).md"), "utf8")).toBe(output.body);
  });

  it("writes nothing and refuses when no folder has been chosen", async () => {
    const folder = privateFolder();
    const target = folderTarget(() => ({ kind: "not-chosen" }));

    const delivery = await target.exportDocument(document({}));

    expect(delivery).toMatchObject({ kind: "refused", code: "not-connected" });
    expect(readdirSync(folder)).toEqual([]);
    expect(target.describeDestination?.(document({}))).toBeUndefined();
  });

  it("refuses and writes nothing when the folder has gone", async () => {
    const folder = privateFolder();
    const target = folderTarget(() => ({ kind: "refused", reason: "The folder is gone." }));

    const delivery = await target.exportDocument(document({}));

    expect(delivery).toEqual({
      kind: "refused",
      code: "refused",
      message: "The folder is gone.",
    });
    expect(readdirSync(folder)).toEqual([]);
  });

  it("keeps the export inside the chosen folder when the title looks like a path", async () => {
    const folder = privateFolder();
    const target = folderTarget(() => ({ kind: "ready", folder }));

    const delivery = await target.exportDocument(document({ title: "etc/passwd" }));

    expect(delivery).toMatchObject({ kind: "receipt" });
    expect(readdirSync(folder)).toEqual(["etc passwd.md"]);
    expect(statSync(join(folder, "etc passwd.md")).isFile()).toBe(true);
  });

  it("writes beside a file that appeared after the card said none was there", async () => {
    const folder = privateFolder();
    const target = folderTarget(() => ({ kind: "ready", folder }));
    const output = document({});

    // The card named this file and said it would be written new, so approving
    // it is not a confirmation to replace anything. A file that appears at the
    // name before the approval is answered was never named to the person.
    const described = target.describeDestination?.(output);
    expect(described).toEqual({ path: join(folder, "Launch plan.md"), replacesExisting: false });
    writeFileSync(join(folder, "Launch plan.md"), "what the person kept", "utf8");

    const delivery = await target.exportDocument(output, described);

    expect(delivery).toMatchObject({ kind: "receipt" });
    expect(readFileSync(join(folder, "Launch plan.md"), "utf8")).toBe("what the person kept");
    expect(readFileSync(join(folder, "Launch plan (2).md"), "utf8")).toBe(output.body);
  });

  it("refuses to write into a folder the approval card never named", async () => {
    const approved = privateFolder();
    const chosen = privateFolder();
    let availability: FolderExportAvailability = { kind: "ready", folder: approved };
    const target = folderTarget(() => availability);
    const output = document({});
    const described = target.describeDestination?.(output);
    expect(described?.path).toBe(join(approved, "Launch plan.md"));

    // The person picked a different folder while the card was open.
    availability = { kind: "ready", folder: chosen };

    const delivery = await target.exportDocument(output, described);

    expect(delivery).toEqual({
      kind: "refused",
      code: "refused",
      message: "The export folder changed after this export was approved.",
    });
    expect(readdirSync(approved)).toEqual([]);
    expect(readdirSync(chosen)).toEqual([]);
  });

  it("refuses to follow a link that replaced the chosen folder after it was chosen", async () => {
    const chosen = privateFolder();
    const elsewhere = privateFolder();
    const target = folderTarget(() => ({ kind: "ready", folder: chosen }));
    // The folder still has the name the person chose, but it now leads to a
    // folder they never approved.
    rmSync(chosen, { recursive: true });
    symlinkSync(elsewhere, chosen, "dir");

    const delivery = await target.exportDocument(document({}));

    expect(delivery).toEqual({
      kind: "refused",
      code: "refused",
      message: "The export could not be written to that folder.",
    });
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it("refuses to follow a link that replaced a folder above the chosen folder", async () => {
    const parent = privateFolder();
    const chosen = join(parent, "Exports");
    mkdirSync(chosen, { mode: 0o700 });
    const elsewhere = privateFolder();
    mkdirSync(join(elsewhere, "Exports"), { mode: 0o700 });
    const target = folderTarget(() => ({ kind: "ready", folder: chosen }));
    // The chosen folder itself is no link, but the path to it now runs through
    // one: a folder of the same name somewhere the person never approved.
    rmSync(parent, { recursive: true });
    symlinkSync(elsewhere, parent, "dir");

    const delivery = await target.exportDocument(document({}));

    expect(delivery).toEqual({
      kind: "refused",
      code: "refused",
      message: "The export could not be written to that folder.",
    });
    expect(readdirSync(join(elsewhere, "Exports"))).toEqual([]);
  });
});
