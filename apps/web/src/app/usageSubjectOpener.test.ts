import { describe, expect, it, vi } from "vitest";
import { openUsageSubject, type UsageSubjectOpeners } from "./usageSubjectOpener";

const THREAD = "77000000-0000-4000-8000-0000000000d1";
const PROJECT = "77000000-0000-4000-8000-0000000000f1";

function openers(overrides: Partial<UsageSubjectOpeners> = {}) {
  return {
    selectChatThread: vi.fn(),
    selectWorkThread: vi.fn(),
    selectCodeThread: vi.fn(),
    openChatThread: vi.fn(),
    listedChatThreadIds: new Set<string>(),
    chatThreadRow: () => undefined,
    ...overrides,
  } satisfies UsageSubjectOpeners;
}

describe("opening a thread from a Usage row", () => {
  it("opens an archived Chat thread the sidebar does not list, by id with its Project", () => {
    const deps = openers({ chatThreadRow: () => ({ title: "Cell answer", projectId: PROJECT }) });

    expect(openUsageSubject("chat-thread", THREAD, deps)).toBe(true);

    expect(deps.selectChatThread).not.toHaveBeenCalled();
    expect(deps.openChatThread).toHaveBeenCalledWith(THREAD, "Cell answer", PROJECT);
  });

  it("opens a thread with no known row under a plain title", () => {
    const deps = openers();
    openUsageSubject("chat-thread", THREAD, deps);
    expect(deps.openChatThread).toHaveBeenCalledWith(THREAD, "Benchmark thread", undefined);
  });

  it("selects a Chat thread the sidebar lists, so its snooze is acknowledged", () => {
    const deps = openers({ listedChatThreadIds: new Set([THREAD]) });
    openUsageSubject("chat-thread", THREAD, deps);
    expect(deps.selectChatThread).toHaveBeenCalledWith(THREAD);
    expect(deps.openChatThread).not.toHaveBeenCalled();
  });

  it("leaves a subject that is not a thread alone", () => {
    const deps = openers();
    expect(openUsageSubject("provider", THREAD, deps)).toBe(false);
    expect(deps.openChatThread).not.toHaveBeenCalled();
  });
});
