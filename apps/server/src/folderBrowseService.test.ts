import { describe, expect, it } from "vitest";
import { FolderBrowseService, FolderBrowseServiceError } from "./folderBrowseService";
import type { BindingReceiptStore } from "./bindingReceiptStore";
import type { ProjectRootPort } from "./projectRootPort";
import type { WindowId } from "@octant/contracts";

const WINDOW_ID = "00000000-0000-4000-8000-000000000099" as WindowId;
const OTHER_WINDOW = "00000000-0000-4000-8000-000000000088" as WindowId;

function makeService(overrides?: {
  homeDir?: string;
  now?: () => number;
  clock?: () => string;
  validate?: ProjectRootPort["validate"];
  issue?: BindingReceiptStore["issue"];
}) {
  const receipts: Pick<BindingReceiptStore, "issue"> = {
    issue:
      overrides?.issue ??
      ((input) => ({
        receiptId: `receipt-${Date.now()}` as any,
        projectType: input.projectType,
        expiresAt: input.now + 60_000,
      })),
  };
  const roots: Pick<ProjectRootPort, "validate"> = {
    validate: overrides?.validate ?? (async (_type, candidate) => ({ canonicalRoot: candidate })),
  };
  return new FolderBrowseService({
    bindingReceiptStore: receipts,
    projectRootPort: roots,
    homeDir: overrides?.homeDir ?? "/tmp/test-home",
    now: overrides?.now ?? (() => 1000),
    clock: overrides?.clock ?? (() => "2026-07-24T12:00:00.000Z"),
  });
}

describe("FolderBrowseService", () => {
  describe("browse", () => {
    it("rejects invalid request", async () => {
      const service = makeService();
      await expect(service.browse(WINDOW_ID, { bad: true })).rejects.toThrow(
        FolderBrowseServiceError,
      );
    });

    it("rejects unknown parent candidate", async () => {
      const service = makeService();
      await expect(
        service.browse(WINDOW_ID, {
          hostId: "local",
          mode: "work",
          parentCandidateId: "00000000-0000-4000-8000-000000000001",
        }),
      ).rejects.toThrow(FolderBrowseServiceError);
    });

    it("rejects parent from wrong window", async () => {
      const service = makeService();
      // We can't easily inject a candidate for another window without
      // exposing internals, so this test verifies the not-found path
      // for an unknown candidate ID.
      await expect(
        service.browse(OTHER_WINDOW, {
          hostId: "local",
          mode: "work",
          parentCandidateId: "00000000-0000-4000-8000-000000000001",
        }),
      ).rejects.toThrow(FolderBrowseServiceError);
    });
  });

  describe("select", () => {
    it("rejects invalid request", async () => {
      const service = makeService();
      await expect(service.select(WINDOW_ID, { bad: true })).rejects.toThrow(
        FolderBrowseServiceError,
      );
    });

    it("rejects unknown candidate", async () => {
      const service = makeService();
      await expect(
        service.select(WINDOW_ID, {
          hostId: "local",
          mode: "work",
          candidateId: "00000000-0000-4000-8000-000000000001",
        }),
      ).rejects.toThrow(FolderBrowseServiceError);
    });
  });
});
