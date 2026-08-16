import { describe, expect, it } from "vitest";
import {
  assertCursorAcpRuntimeStart,
  CursorAcpRuntimePolicyRejected,
  planCursorAcpShutdown,
} from "./cursorAcpRuntimePolicy";

describe("Cursor ACP runtime policy", () => {
  it("fail-closes production runtime start under the NO-GO residual", () => {
    try {
      assertCursorAcpRuntimeStart({
        mode: "code",
        executionPolicy: "approval-gated",
        rootPath: "/tmp/project",
        expectedRootPath: "/tmp/project",
        productionEnabled: false,
      });
      throw new Error("expected production-blocked");
    } catch (error) {
      expect(error).toBeInstanceOf(CursorAcpRuntimePolicyRejected);
      expect((error as CursorAcpRuntimePolicyRejected).denialCode).toBe("production-blocked");
    }
  });

  it("rejects resume and missing Chat scratch roots before any process launch", () => {
    try {
      assertCursorAcpRuntimeStart({
        mode: "code",
        executionPolicy: "plan",
        rootPath: "/tmp/project",
        expectedRootPath: "/tmp/project",
        productionEnabled: false,
        resumeSessionId: "session-1",
      });
      throw new Error("expected resume-unavailable");
    } catch (error) {
      expect(error).toBeInstanceOf(CursorAcpRuntimePolicyRejected);
      expect((error as CursorAcpRuntimePolicyRejected).denialCode).toBe("resume-unavailable");
    }

    try {
      assertCursorAcpRuntimeStart({
        mode: "chat",
        executionPolicy: "approval-gated",
        rootPath: null,
        expectedRootPath: "/tmp/octant-chat-scratch/abc",
        productionEnabled: false,
      });
      throw new Error("expected unsupported-root");
    } catch (error) {
      expect(error).toBeInstanceOf(CursorAcpRuntimePolicyRejected);
      expect((error as CursorAcpRuntimePolicyRejected).denialCode).toBe("unsupported-root");
    }
  });

  it("binds roots to server-owned expected identity and residual-denies matching Chat scratch", () => {
    try {
      assertCursorAcpRuntimeStart({
        mode: "chat",
        executionPolicy: "approval-gated",
        rootPath: "/Users/example/Documents",
        expectedRootPath: "/tmp/octant-chat-scratch/abc",
        productionEnabled: false,
      });
      throw new Error("expected authority-mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(CursorAcpRuntimePolicyRejected);
      expect((error as CursorAcpRuntimePolicyRejected).denialCode).toBe("authority-mismatch");
    }

    try {
      assertCursorAcpRuntimeStart({
        mode: "code",
        executionPolicy: "approval-gated",
        rootPath: "/tmp/project//",
        expectedRootPath: "/tmp/project",
        productionEnabled: false,
      });
      throw new Error("expected production-blocked");
    } catch (error) {
      expect(error).toBeInstanceOf(CursorAcpRuntimePolicyRejected);
      expect((error as CursorAcpRuntimePolicyRejected).denialCode).toBe("production-blocked");
    }

    // Matching generated Chat scratch roots pass authority binding, then still
    // fail closed on the NO-GO residual with production-blocked (not unsupported-root).
    try {
      assertCursorAcpRuntimeStart({
        mode: "chat",
        executionPolicy: "approval-gated",
        rootPath: "/tmp/octant-chat-scratch/abc",
        expectedRootPath: "/tmp/octant-chat-scratch/abc/",
        productionEnabled: false,
      });
      throw new Error("expected production-blocked");
    } catch (error) {
      expect(error).toBeInstanceOf(CursorAcpRuntimePolicyRejected);
      expect((error as CursorAcpRuntimePolicyRejected).denialCode).toBe("production-blocked");
    }
  });

  it("limits shutdown to the owned process group", () => {
    expect(planCursorAcpShutdown({ ownedProcessGroupId: 4242, force: true })).toEqual({
      terminateProcessGroupId: 4242,
      force: true,
    });
  });

  it("does not treat trailing whitespace as the same root identity", () => {
    try {
      assertCursorAcpRuntimeStart({
        mode: "code",
        executionPolicy: "approval-gated",
        rootPath: "/tmp/project ",
        expectedRootPath: "/tmp/project",
        productionEnabled: false,
      });
      throw new Error("expected authority-mismatch");
    } catch (error) {
      expect(error).toBeInstanceOf(CursorAcpRuntimePolicyRejected);
      expect((error as CursorAcpRuntimePolicyRejected).denialCode).toBe("authority-mismatch");
    }
  });

  it("rejects non-canonical traversal roots before residual denial", () => {
    try {
      assertCursorAcpRuntimeStart({
        mode: "code",
        executionPolicy: "approval-gated",
        rootPath: "/tmp/project/..",
        expectedRootPath: "/tmp/project/..",
        productionEnabled: false,
      });
      throw new Error("expected unsupported/authority denial");
    } catch (error) {
      expect(error).toBeInstanceOf(CursorAcpRuntimePolicyRejected);
      expect(["unsupported-root", "authority-mismatch"]).toContain(
        (error as CursorAcpRuntimePolicyRejected).denialCode,
      );
    }
  });

  it("rejects non-positive process group ids for shutdown planning", () => {
    for (const pid of [0, 1, -1, 1.5, Number.NaN]) {
      expect(() =>
        planCursorAcpShutdown({ ownedProcessGroupId: pid as number, force: false }),
      ).toThrow(CursorAcpRuntimePolicyRejected);
    }
    expect(planCursorAcpShutdown({ ownedProcessGroupId: 42, force: true })).toEqual({
      terminateProcessGroupId: 42,
      force: true,
    });
  });
});
