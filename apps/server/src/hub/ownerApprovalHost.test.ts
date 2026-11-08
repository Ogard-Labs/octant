import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  OwnerApprovalId,
  decodeOwnerApprovalAnswer,
  decodeOwnerApprovalAuditRecord,
  type OwnerApprovalAuditRecord,
  type OwnerApprovalAction,
} from "@octant/contracts/owner-approvals";
import { HubMemberId, decodeCodeThreadId, decodeWorkThreadId } from "@octant/contracts";
import { Schema } from "effect";
import type { RuntimeApprovalRecovery } from "../providers/runtimeApprovalRecovery";
import { createOwnerApprovalHost } from "./ownerApprovalHost";

function fixture(mode: "code" | "work" = "code", shell = false) {
  const memberId = Schema.decodeUnknownSync(HubMemberId)(randomUUID());
  const threadId =
      mode === "code" ? decodeCodeThreadId(randomUUID()) : decodeWorkThreadId(randomUUID()),
    requestId = randomUUID(),
    projectId = randomUUID();
  let version = 1,
    live = true,
    permitted = true;
  let action: OwnerApprovalAction = shell
    ? {
        kind: "shell",
        tool: "Bash",
        input: JSON.stringify({ command: "printf private-body" }),
        workingDirectory: "/fixture",
      }
    : {
        kind: "file-write" as const,
        tool: "Write",
        input: JSON.stringify({ file_path: "/fixture/a.txt", content: "complete-private-body" }),
      };
  const answer = vi.fn(async (_approved: boolean, current: () => boolean) => {
    if (!current()) return false;
    live = false;
    return true;
  });
  const runtime: RuntimeApprovalRecovery = {
    mode,
    threadId,
    requestId: OwnerApprovalId.make(requestId),
    identity: "session-one/callback-one",
    get action() {
      return action;
    },
    current: () => live,
    answer,
  };
  const records: OwnerApprovalAuditRecord[] = [];
  const claimed = new Set<string>();
  const audit = (fact: OwnerApprovalAuditRecord) => {
    if (fact.phase === "admitted") {
      if (claimed.has(String(fact.requestId))) throw new Error("Claim already exists.");
      claimed.add(String(fact.requestId));
    }
    records.push(decodeOwnerApprovalAuditRecord(fact));
  };
  const host = createOwnerApprovalHost({
    hostMemberId: String(memberId),
    pending: () => (live ? [runtime] : []),
    binding: () => ({ title: "Fixture task", projectName: "Fixture Project", projectId, version }),
    audit,
  });
  const target = host.list(memberId).targets[0];
  if (target === undefined) throw new Error("Missing fixture target.");
  const request = decodeOwnerApprovalAnswer({
    ownerMemberId: memberId,
    hostMemberId: target.hostMemberId,
    mode,
    threadId,
    projectId,
    requestId,
    targetVersion: target.targetVersion,
    actionDigest: target.actionDigest,
    approved: true,
  });
  const authority = {
    principal: { kind: "owner-unlock" as const, memberId },
    current: () => permitted,
  };
  return {
    host,
    request,
    authority,
    answer,
    records,
    setVersion: () => {
      version += 1;
    },
    changeDirectory: () => {
      action = { ...action, workingDirectory: "/changed" };
    },
    changeAction: () => {
      action = {
        ...action,
        input: shell
          ? JSON.stringify({ command: "printf changed-private-body" })
          : JSON.stringify({ file_path: "/fixture/a.txt", content: "changed-private-body" }),
      };
    },
    revoke: () => {
      permitted = false;
    },
    settle: () => {
      live = false;
    },
    keepLive: () => {
      answer.mockImplementation(async () => false);
    },
  };
}

describe("owner runtime approval recovery", () => {
  it.each(["code", "work"] as const)(
    "binds the entire %s Shell command and directory and consumes uncertain answers",
    async (mode) => {
      for (const change of ["command", "directory", "proof", "uncertain"] as const) {
        const f = fixture(mode, true);
        if (change === "command") f.changeAction();
        if (change === "directory") f.changeDirectory();
        if (change === "proof") f.revoke();
        if (change === "uncertain") f.keepLive();
        expect(await f.host.answer(f.request, f.authority)).toEqual({
          status: change === "uncertain" ? "uncertain" : "refused",
        });
        if (change !== "uncertain") expect(f.answer).not.toHaveBeenCalled();
        else {
          expect(await f.host.answer(f.request, f.authority)).toEqual({ status: "refused" });
          expect(f.answer).toHaveBeenCalledOnce();
        }
        expect(JSON.stringify(f.records)).not.toContain("private-body");
      }
      const f = fixture(mode, true);
      expect(await f.host.answer(f.request, f.authority)).toEqual({ status: "delivered" });
      expect(await f.host.answer(f.request, f.authority)).toEqual({ status: "refused" });
      expect(f.answer).toHaveBeenCalledOnce();
    },
  );
  it.each(["code", "work"] as const)(
    "delivers one %s answer and records the owner and full action digest without private content",
    async (mode) => {
      const f = fixture(mode);
      expect(await f.host.answer(f.request, f.authority)).toEqual({ status: "delivered" });
      expect(await f.host.answer(f.request, f.authority)).toEqual({ status: "refused" });
      expect(f.answer).toHaveBeenCalledOnce();
      expect(f.records.map((record) => record.phase)).toEqual(["admitted", "delivered"]);
      expect(f.records[0]?.actingPrincipal).toEqual(f.authority.principal);
      expect(JSON.stringify(f.records)).not.toContain("private-body");
    },
  );
  it.each([
    "owner",
    "host",
    "thread",
    "project",
    "digest",
    "version",
    "settled",
    "revoked",
    "action",
  ])("refuses a changed %s before callback and journal admission", async (changed) => {
    const f = fixture();
    let request = f.request;
    if (changed === "owner")
      request = decodeOwnerApprovalAnswer({ ...request, ownerMemberId: randomUUID() });
    if (changed === "host")
      request = decodeOwnerApprovalAnswer({ ...request, hostMemberId: randomUUID() });
    if (changed === "thread")
      request = decodeOwnerApprovalAnswer({ ...request, threadId: randomUUID() });
    if (changed === "project")
      request = decodeOwnerApprovalAnswer({ ...request, projectId: randomUUID() });
    if (changed === "digest")
      request = decodeOwnerApprovalAnswer({ ...request, actionDigest: "f".repeat(64) });
    if (changed === "version") f.setVersion();
    if (changed === "settled") f.settle();
    if (changed === "revoked") f.revoke();
    if (changed === "action") f.changeAction();
    expect(await f.host.answer(request, f.authority)).toEqual({ status: "refused" });
    expect(f.answer).not.toHaveBeenCalled();
    expect(f.records).toHaveLength(0);
  });
  it("consumes uncertain delivery and refuses a fresh second proof for the same callback", async () => {
    const f = fixture();
    f.keepLive();
    expect(await f.host.answer(f.request, f.authority)).toEqual({ status: "uncertain" });
    expect(await f.host.answer(f.request, f.authority)).toEqual({ status: "refused" });
    expect(f.answer).toHaveBeenCalledOnce();
  });
});
