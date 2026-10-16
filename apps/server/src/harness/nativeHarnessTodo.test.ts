import { describe, expect, it } from "vitest";
import { createNativeHarnessTodoPort } from "./nativeHarnessTodo";

const threadId = "00000000-0000-4000-8000-000000000020";

describe("native harness todo-write", () => {
  it("records pending, in-progress and done items on the session", async () => {
    const written: unknown[] = [];
    const port = createNativeHarnessTodoPort({
      threadId,
      sessions: {
        replaceTasks: (_thread, items) => {
          written.push(items);
          return "recorded";
        },
      },
    });
    const items = [
      { title: "Read the spec", status: "done" },
      { title: "Write the fix", status: "in-progress" },
      { title: "Run the checks", status: "pending" },
    ] as const;
    await port.replace(items);
    expect(written).toEqual([items]);
  });

  it("fails the call when the thread has no session to keep the list on", async () => {
    const port = createNativeHarnessTodoPort({
      threadId,
      sessions: { replaceTasks: () => "no-session" },
    });
    await expect(port.replace([{ title: "Read", status: "pending" }])).rejects.toThrow(
      /no harness session/,
    );
  });
});
