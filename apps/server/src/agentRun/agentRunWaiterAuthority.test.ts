import type { AgentRunAuthority } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  currentParentAuthorityForWaiter,
  parentThreadStillHostsRun,
} from "./agentRunWaiterAuthority";

const grant: AgentRunAuthority = {
  filesystem: false,
  shell: false,
  git: false,
  network: true,
  tools: true,
  subagents: true,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
};
const projectId = "88888888-8888-4888-8888-888888888888";
const run = { routingReceipt: { projectId } } as never;

function authorityFor(
  overrides: Partial<Parameters<typeof currentParentAuthorityForWaiter>[0]> = {},
) {
  return currentParentAuthorityForWaiter({
    run,
    startsHelpers: () => true,
    isTainted: () => false,
    parentThread: () => ({ lifecycle: "active", projectId }),
    parentLiveAuthority: () => grant,
    ...overrides,
  });
}

describe("the parent's authority for a child that waited", () => {
  it("is the parent's live grant while every fact still holds", () => {
    expect(authorityFor()).toEqual(grant);
  });

  it("is nothing once the parent was tainted", () => {
    expect(authorityFor({ isTainted: () => true })).toBeUndefined();
  });

  it("is nothing once helper agents were switched off", () => {
    expect(authorityFor({ startsHelpers: () => false })).toBeUndefined();
  });

  it("is nothing once the parent thread was archived or is gone", () => {
    expect(
      authorityFor({ parentThread: () => ({ lifecycle: "archived", projectId }) }),
    ).toBeUndefined();
    expect(authorityFor({ parentThread: () => undefined })).toBeUndefined();
  });

  it("is nothing once the parent thread moved to another Project or out of every Project", () => {
    expect(
      authorityFor({
        parentThread: () => ({
          lifecycle: "active",
          projectId: "99999999-9999-4999-8999-999999999999",
        }),
      }),
    ).toBeUndefined();
    expect(
      authorityFor({ parentThread: () => ({ lifecycle: "active", projectId: null }) }),
    ).toBeUndefined();
  });

  it("is nothing when the parent's grant no longer allows starting helpers or cannot be read", () => {
    expect(
      authorityFor({ parentLiveAuthority: () => ({ ...grant, subagents: false }) }),
    ).toBeUndefined();
    expect(authorityFor({ parentLiveAuthority: () => undefined })).toBeUndefined();
  });

  it("treats a Chat thread in no Project as the same place as a child routed under none", () => {
    const chatRun = { routingReceipt: {} } as never;
    expect(parentThreadStillHostsRun({ lifecycle: "active", projectId: null }, chatRun)).toBe(true);
    expect(parentThreadStillHostsRun({ lifecycle: "active" }, chatRun)).toBe(true);
    expect(parentThreadStillHostsRun({ lifecycle: "active", projectId }, chatRun)).toBe(false);
  });
});
