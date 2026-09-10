import type { ExtensionClient } from "@octant/client-runtime/extension-client";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { useExtensionDraftSelections } from "./useExtensionDraftSelections";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function Harness(props: { readonly projectId: string | null; readonly client: ExtensionClient }) {
  const [draft, setDraft] = useState("");
  const selections = useExtensionDraftSelections({
    client: props.client,
    mode: "code",
    projectId: props.projectId,
    providerFamily: "openai-compatible" as never,
  });
  return (
    <>
      <button onClick={() => void selections.resolveReference(draft)}>Resolve</button>
      <input aria-label="Draft" onChange={(event) => setDraft(event.target.value)} value={draft} />
      <output aria-label="Receipts">{selections.receipts.map((entry) => entry.reference).join(",")}</output>
      <button onClick={() => selections.clear()}>Clear</button>
    </>
  );
}

describe("useExtensionDraftSelections", () => {
  it("does not commit a resolver result after the scope is cleared", async () => {
    const snapshot = deferred<never>();
    const client = {
      snapshot: vi.fn(() => snapshot.promise),
      effectiveState: vi.fn(),
    } as unknown as ExtensionClient;
    const { rerender } = render(<Harness client={client} projectId={null} />);
    const input = screen.getByLabelText("Draft");
    const resolve = screen.getByRole("button", { name: "Resolve" });
    fireEvent.change(input, { target: { value: "$review" } });
    resolve.click();
    rerender(<Harness client={client} projectId={"70000000-0000-4000-8000-000000000001"} />);
    snapshot.resolve({ sequence: 1, skills: [] } as never);
    await Promise.resolve();
    expect(screen.getByLabelText("Receipts")).toHaveTextContent("");
  });

  it("does not resurrect a removed receipt when its lookup completes", async () => {
    const snapshot = deferred<never>();
    const client = {
      snapshot: vi.fn(() => snapshot.promise),
      effectiveState: vi.fn(),
    } as unknown as ExtensionClient;
    render(<Harness client={client} projectId={null} />);
    const input = screen.getByLabelText("Draft");
    fireEvent.change(input, { target: { value: "$review" } });
    screen.getByRole("button", { name: "Resolve" }).click();
    screen.getByRole("button", { name: "Clear" }).click();
    snapshot.resolve({ sequence: 1, skills: [] } as never);
    await Promise.resolve();
    expect(screen.getByLabelText("Receipts")).toHaveTextContent("");
  });
});
