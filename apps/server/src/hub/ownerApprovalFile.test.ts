import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeOwnerApprovalAction } from "@octant/contracts/owner-approvals";
import { ownerApprovalFileContext, ownerApprovalContext } from "./ownerApprovalFile";

describe("owner file approval scope", () => {
  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "binds Shell to the exact live root and refuses changed directories and excluded aliases",
    () => {
      const base = mkdtempSync(join(tmpdir(), "octant-owner-shell-scope-"));
      const root = join(base, "project");
      mkdirSync(root);
      const action = (cwd: string) =>
        decodeOwnerApprovalAction({
          kind: "shell",
          tool: "Bash",
          input: JSON.stringify({ command: "pwd" }),
          workingDirectory: cwd,
        });
      try {
        const original = ownerApprovalContext(action(root), root);
        expect(original?.physicalRoot).toBeDefined();
        mkdirSync(join(root, "nested"));
        expect(ownerApprovalContext(action(join(root, "nested")), root)).toBeUndefined();
        expect(ownerApprovalContext(action(base), root)).toBeUndefined();
        expect(ownerApprovalContext(action(root), undefined)).toBeUndefined();
        mkdirSync(join(base, ".git"));
        symlinkSync(join(base, ".git"), join(base, "git-alias"));
        expect(
          ownerApprovalContext(action(join(base, "git-alias")), join(base, "git-alias")),
        ).toBeUndefined();
        renameSync(root, join(base, "previous"));
        mkdirSync(root);
        expect(ownerApprovalContext(action(root), root)?.inode).not.toBe(original?.inode);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );
  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "refuses unresolved existing entries while admitting ordinary new files and resolved inside links",
    () => {
      const base = mkdtempSync(join(tmpdir(), "octant-owner-file-resolution-"));
      const root = join(base, "project");
      const outside = join(base, "outside");
      mkdirSync(root);
      mkdirSync(outside);
      const context = (name: string) =>
        ownerApprovalFileContext(
          decodeOwnerApprovalAction({
            kind: "file-write",
            tool: "Write",
            input: JSON.stringify({ file_path: join(root, name), content: "fixture" }),
          }),
          root,
        );
      try {
        expect(context("ordinary-new.txt")).toBeDefined();
        writeFileSync(join(root, "existing.txt"), "fixture");
        symlinkSync(join(root, "existing.txt"), join(root, "inside-link.txt"));
        const insideLink = context("inside-link.txt");
        expect(insideLink).toBeDefined();
        expect(insideLink?.physicalPath).toBe(context("existing.txt")?.physicalPath);
        symlinkSync(join(outside, "not-created.txt"), join(root, "dangling-outside.txt"));
        expect(context("dangling-outside.txt")).toBeUndefined();
        symlinkSync(join(root, "not-created.txt"), join(root, "dangling-inside.txt"));
        expect(context("dangling-inside.txt")).toBeUndefined();
        symlinkSync("loop.txt", join(root, "loop.txt"));
        expect(context("loop.txt")).toBeUndefined();
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );
  it.skipIf(process.platform !== "darwin" && process.platform !== "linux")(
    "keeps the live bound root identity and refuses outside, credential and Git paths including aliases",
    () => {
      const base = mkdtempSync(join(tmpdir(), "octant-owner-file-scope-"));
      const root = join(base, "project");
      mkdirSync(root);
      const action = (path: string) =>
        decodeOwnerApprovalAction({
          kind: "file-write",
          tool: "Write",
          input: JSON.stringify({ file_path: path, content: "fixture" }),
        });
      try {
        const original = ownerApprovalFileContext(action(join(root, "new.txt")), root);
        expect(original?.physicalRoot).toBeDefined();
        writeFileSync(join(base, "outside.txt"), "fixture");
        symlinkSync(join(base, "outside.txt"), join(root, "alias.txt"));
        mkdirSync(join(root, ".git"));
        writeFileSync(join(root, ".git", "config"), "fixture");
        symlinkSync(join(root, ".git", "config"), join(root, "git-alias"));
        for (const path of [
          join(base, "outside.txt"),
          join(root, "alias.txt"),
          join(root, ".env"),
          join(root, ".git", "config"),
          join(root, "git-alias"),
        ])
          expect(ownerApprovalFileContext(action(path), root)).toBeUndefined();
        renameSync(root, join(base, "previous"));
        mkdirSync(root);
        expect(ownerApprovalFileContext(action(join(root, "new.txt")), root)?.inode).not.toBe(
          original?.inode,
        );
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    },
  );
});
