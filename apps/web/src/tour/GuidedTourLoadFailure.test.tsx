import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GuidedTour } from "./GuidedTour";
import { GUIDED_TOUR_STORAGE_KEY, isGuidedTourOpen, readGuidedTourRecord } from "./guidedTourState";

const loadCard = vi.hoisted(() => vi.fn());

// Its own file: the mock stands for a chunk the host no longer has, for every
// test that shares this module graph.
vi.mock("./GuidedTourSurface", () => {
  loadCard();
  throw new Error("The tour's chunk could not be fetched.");
});

describe("GuidedTour when its card cannot load", () => {
  it("keeps the tour owed, so a later start offers it again", async () => {
    globalThis.localStorage.setItem(GUIDED_TOUR_STORAGE_KEY, "due");
    render(
      <>
        <button
          aria-label="New chat"
          ref={(element) => {
            if (element !== null) {
              element.getBoundingClientRect = () => new DOMRect(240, 8, 28, 28);
            }
          }}
          type="button"
        />
        <GuidedTour blocked={false} firstRunStatus="completed" />
      </>,
    );
    expect(isGuidedTourOpen()).toBe(true);

    await act(async () => {
      await vi.dynamicImportSettled();
    });

    expect(loadCard).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(readGuidedTourRecord()).toBe("due");
  });
});
