import { decodeWindowId } from "@octant/contracts";
import { expect, it } from "vitest";
import { notifyWindowRevocations } from "./windowRevocations";

it("notifies sibling owners even when earlier cleanup throws", () => {
  const windowId = decodeWindowId("00000000-0000-4000-8000-000000000595");
  const seen: string[] = [];
  expect(
    notifyWindowRevocations(windowId, [
      () => {
        seen.push("first");
        throw new Error("private cleanup failure");
      },
      (id) => {
        expect(id).toBe(windowId);
        seen.push("second");
      },
      () => {
        seen.push("third");
        throw new Error("another failure");
      },
    ]),
  ).toEqual({ kind: "failed", count: 2 });
  expect(seen).toEqual(["first", "second", "third"]);
});
