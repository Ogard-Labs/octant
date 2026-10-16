import { act, render, renderHook } from "@testing-library/react";
import { Suspense, startTransition, useState } from "react";
import { describe, expect, it } from "vitest";
import { useStableActions } from "./useStableActions";

describe("stable shell actions", () => {
  it("keeps one function identity across renders while calling the newest committed action", () => {
    const seen: string[] = [];
    const { result, rerender } = renderHook(
      ({ label }: { readonly label: string }) =>
        useStableActions(() => ({
          note: (suffix: string) => {
            seen.push(`${label}${suffix}`);
            return `${label}${suffix}`;
          },
        })),
      { initialProps: { label: "first" } },
    );
    const noteBefore = result.current.note;
    expect(noteBefore("!")).toBe("first!");

    rerender({ label: "second" });
    act(() => undefined);
    expect(result.current.note).toBe(noteBefore);
    expect(result.current.note("?")).toBe("second?");
    expect(seen).toEqual(["first!", "second?"]);
  });

  it("answers a name that is not an action the way a plain object would", () => {
    const { result } = renderHook(() => useStableActions(() => ({ open: () => "opened" })));
    expect("open" in result.current).toBe(true);
    expect(Object.keys(result.current)).toEqual(["open"]);
    expect(String(result.current)).toBe("[object Object]");
  });

  it("runs the committed action while a newer render is suspended, and the new one once it commits", async () => {
    let releaseGate: () => void = () => undefined;
    let gateOpen = false;
    const gate = new Promise<void>((resolve) => {
      releaseGate = () => {
        gateOpen = true;
        resolve();
      };
    });
    // Suspends only the render that carries the second label, so the first
    // UI stays committed and clickable while the second waits to commit.
    function Gate(props: { readonly label: string }) {
      if (props.label === "second" && !gateOpen) throw gate;
      return <output>{props.label}</output>;
    }
    let exposed: { readonly whichLabel: () => string } | undefined;
    let setLabel: (label: string) => void = () => undefined;
    function Shell() {
      const [label, set] = useState("first");
      setLabel = set;
      exposed = useStableActions(() => ({ whichLabel: () => label }));
      return (
        <Suspense fallback={<output>loading</output>}>
          <Gate label={label} />
        </Suspense>
      );
    }
    const view = render(<Shell />);
    expect(view.getByText("first")).toBeInTheDocument();
    if (exposed === undefined) throw new Error("The shell exposed no actions.");
    const actions = exposed;

    act(() => startTransition(() => setLabel("second")));
    // The second render is held back by the gate; the first UI is still what
    // the person sees, so its action set is the one a click must reach.
    expect(view.getByText("first")).toBeInTheDocument();
    expect(actions.whichLabel()).toBe("first");

    await act(async () => {
      releaseGate();
      await gate;
    });
    expect(view.getByText("second")).toBeInTheDocument();
    expect(actions.whichLabel()).toBe("second");
  });
});
