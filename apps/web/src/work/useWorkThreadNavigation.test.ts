import { decodeWorkThread, decodeWorkThreadId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { buildWorkThreadNavigation } from "./useWorkThreadNavigation";

const threadId = decodeWorkThreadId("10000000-0000-4000-8000-000000000101");

describe("buildWorkThreadNavigation", () => {
  it("projects active bound threads for the Project sidebar and omits deleted history", () => {
    const active = decodeWorkThread({
      id: threadId,
      projectId: "20000000-0000-4000-8000-000000000101",
      title: "Research brief",
      lifecycle: "active",
      providerInstanceId: "80000000-0000-4000-8000-0000000000b1",
      modelId: "model-one",
      version: 2,
      createdAt: "2026-08-01T20:00:00.000Z",
      updatedAt: "2026-08-01T20:00:00.000Z",
    });
    const archived = {
      ...active,
      id: decodeWorkThreadId("10000000-0000-4000-8000-000000000102"),
      lifecycle: "archived" as const,
    };

    expect(buildWorkThreadNavigation([active, archived])).toEqual([
      {
        threadId: String(threadId),
        title: "Research brief",
        projectId: "20000000-0000-4000-8000-000000000101",
        providerInstanceId: "80000000-0000-4000-8000-0000000000b1",
        updatedAt: "2026-08-01T20:00:00.000Z",
      },
    ]);
  });
});
