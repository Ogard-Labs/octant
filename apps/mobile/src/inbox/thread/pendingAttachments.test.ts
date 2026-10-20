import { describe, expect, it } from "vitest";
import type { MobileModelOption } from "@octant/client-runtime";
import { modelOptionForThread, pendingAttachmentsReducer } from "./pendingAttachments";

const photo = { id: "att-1", displayName: "photo.png" };

describe("pending attachments", () => {
  it("keeps a picked attachment until the send succeeds", () => {
    const picked = pendingAttachmentsReducer([], { type: "uploaded", attachment: photo });

    expect(picked).toEqual([photo]);
    expect(pendingAttachmentsReducer(picked, { type: "sent" })).toEqual([]);
  });

  it("drops attachments when another thread is opened", () => {
    expect(pendingAttachmentsReducer([photo], { type: "thread-changed" })).toEqual([]);
  });
});

describe("model option for a thread", () => {
  const options: ReadonlyArray<MobileModelOption> = [
    { id: "x", providerInstanceId: "p1", modelId: "m1", label: "One", detail: "" },
    { id: "y", providerInstanceId: "p1", modelId: "m2", label: "Two", detail: "" },
  ];

  it("selects the option matching the thread's provider and model once the list arrives", () => {
    const thread = { providerInstanceId: "p1", modelId: "m2" };

    expect(modelOptionForThread([], thread)).toBeUndefined();
    expect(modelOptionForThread(options, thread)?.id).toBe("y");
  });
});
