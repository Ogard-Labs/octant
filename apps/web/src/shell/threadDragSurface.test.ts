import { describe, expect, it } from "vitest";
import { threadDragSurface } from "./threadDragSurface";

const row = {
  rowId: "row-1",
  threadId: "00000000-0000-4000-8000-000000000001",
  title: "Thread title",
};

describe("threadDragSurface", () => {
  it("mints a chat thread surface with the row title", () => {
    expect(threadDragSurface("chat", row)).toMatchObject({
      kind: "chat-thread",
      mode: "chat",
      title: "Thread title",
    });
  });

  it("mints a code overview surface with the row title", () => {
    expect(threadDragSurface("code", row)).toMatchObject({
      kind: "code-overview",
      mode: "code",
      title: "Thread title",
    });
  });

  it("mints a work thread surface with the row title", () => {
    expect(threadDragSurface("work", row)).toMatchObject({
      kind: "work-thread",
      mode: "work",
      title: "Thread title",
    });
  });
});
