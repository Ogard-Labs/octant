import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SUPPORT_BUNDLE_SECTIONS } from "@octant/domain";
import { resolveDiagnosticsCliCommand, runDiagnosticsCliCommand } from "./diagnosticsCommand";
import type { LocalControlRequest, LocalControlResponse } from "./localControl";

const NOW = "2026-10-31T10:00:00.000Z";
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function workspace(): string {
  const folder = mkdtempSync(join(tmpdir(), "octant-diagnostics-cli-"));
  folders.push(folder);
  return folder;
}

const preview = {
  bundleVersion: 1,
  generatedAt: NOW,
  sections: SUPPORT_BUNDLE_SECTIONS.map((section) => ({
    id: section.id,
    title: section.title,
    includes: section.includes,
    entries: 2,
    available: true,
  })),
  neverIncluded: ["Messages, prompts, replies, or notes."],
};

const bundle = {
  kind: "exported",
  files: [
    { path: "readme.txt", contents: "Octant support bundle\n" },
    { path: "versions.json", contents: '{"available":true}\n' },
  ],
  receipt: {
    bundleId: "00000000-0000-4000-8000-000000000001",
    exportedAt: NOW,
    destinationCategory: "downloads",
    sections: ["versions"],
    fileCount: 2,
    byteCount: 40,
  },
};

function host(
  answer: (request: LocalControlRequest) => LocalControlResponse = () => ({
    status: 200,
    body: bundle,
  }),
) {
  const sent: LocalControlRequest[] = [];
  const out: string[] = [];
  const err: string[] = [];
  return {
    sent,
    out,
    err,
    session: {
      kind: "opened" as const,
      windowId: "11111111-1111-4111-8111-111111111111",
      send: async (request: LocalControlRequest) => {
        sent.push(request);
        return request.method === "GET" ? { status: 200, body: preview } : answer(request);
      },
      close: async () => undefined,
    },
  };
}

const run = (
  rig: ReturnType<typeof host>,
  command: NonNullable<ReturnType<typeof resolveDiagnosticsCliCommand>>,
  cwd: string,
) =>
  runDiagnosticsCliCommand({
    command,
    session: rig.session,
    cwd,
    home: "/Users/ada",
    now: () => new Date(NOW),
    stdout: { write: (chunk) => rig.out.push(chunk) },
    stderr: { write: (chunk) => rig.err.push(chunk) },
  });

describe("resolveDiagnosticsCliCommand", () => {
  it("needs a place to save unless it only lists", () => {
    expect(resolveDiagnosticsCliCommand(["export"], {})).toBeUndefined();
    expect(resolveDiagnosticsCliCommand(["export"], { out: "a.zip" })).toEqual({
      action: "export",
      out: "a.zip",
      listOnly: false,
    });
    expect(resolveDiagnosticsCliCommand(["export"], { list: true })).toEqual({
      action: "export",
      listOnly: true,
    });
    expect(resolveDiagnosticsCliCommand(["export"], { list: true, out: "a.zip" })).toBeUndefined();
    expect(resolveDiagnosticsCliCommand(["export"], { out: "a", upload: true })).toBeUndefined();
    expect(resolveDiagnosticsCliCommand(["send"], { out: "a" })).toBeUndefined();
  });
});

describe("runDiagnosticsCliCommand", () => {
  it("lists what a bundle holds and saves nothing with --list", async () => {
    const rig = host();
    const code = await run(rig, { action: "export", listOnly: true }, workspace());
    expect(code).toBe(0);
    expect(rig.sent.map((request) => request.method)).toEqual(["GET"]);
    const text = rig.out.join("");
    expect(text).toContain("Host log (2 entries)");
    expect(text).toContain("It never holds:");
  });

  it("shows the list, then saves a folder and names a category, not the path, to the host", async () => {
    const cwd = workspace();
    const rig = host();
    const code = await run(rig, { action: "export", out: "bundle", listOnly: false }, cwd);
    expect(code).toBe(0);
    expect(rig.out.join("")).toContain("A support bundle holds:");
    expect(readdirSync(join(cwd, "bundle")).sort()).toEqual(["readme.txt", "versions.json"]);
    expect(readFileSync(join(cwd, "bundle", "readme.txt"), "utf8")).toContain("support bundle");
    const post = rig.sent.find((request) => request.method === "POST");
    expect(post?.body).toEqual({ destinationCategory: "temporary-folder" });
    expect(JSON.stringify(post)).not.toContain(cwd);
  });

  it("saves a zip when the name ends in .zip and will not overwrite one", async () => {
    const cwd = workspace();
    const rig = host();
    expect(await run(rig, { action: "export", out: "octant.zip", listOnly: false }, cwd)).toBe(0);
    const bytes = readFileSync(join(cwd, "octant.zip"));
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
    const again = host();
    expect(await run(again, { action: "export", out: "octant.zip", listOnly: false }, cwd)).toBe(1);
    expect(again.sent.some((request) => request.method === "POST")).toBe(false);
    expect(again.err.join("")).toContain("already exists");
  });

  it("will not write into a folder that already holds files", async () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "keep.txt"), "mine");
    const rig = host();
    const code = await run(rig, { action: "export", out: ".", listOnly: false }, cwd);
    expect(code).toBe(1);
    expect(rig.err.join("")).toContain("already has files");
    expect(readdirSync(cwd)).toEqual(["keep.txt"]);
  });

  it("says why when the host refuses, and writes nothing", async () => {
    const cwd = workspace();
    const rig = host(() => ({ status: 403, body: { error: "Support bundle is unauthorized." } }));
    const code = await run(rig, { action: "export", out: "bundle", listOnly: false }, cwd);
    expect(code).toBe(1);
    expect(rig.err.join("")).toContain("unauthorized");
    expect(readdirSync(cwd)).toEqual([]);
  });
});
