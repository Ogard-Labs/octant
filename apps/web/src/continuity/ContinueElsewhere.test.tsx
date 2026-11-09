import { useState } from "react";
import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeProviderInstance,
  decodeProviderModel,
  decodeProviderModelId,
} from "@octant/contracts";
import { memberThreadPage, type PickerGroup } from "@octant/domain";
import { ContinueElsewhere, ContinuityScreenContext } from "./ContinueElsewhere";
import { continuationLink, readContinuationLink } from "./continuationLink";
import { useContinuationInputPolicy } from "./useContinuationInputPolicy";
const id = "11111111-1111-4111-8111-111111111111";
const instance = decodeProviderInstance({
  id,
  displayName: "Fixture endpoint",
  driverKind: "openai-compatible",
  configuration: {
    kind: "openai-compatible-http",
    baseUrl: "http://127.0.0.1:1234/v1",
    authentication: "none",
    protocol: "responses",
    manualModelIds: [],
  },
  enabled: true,
  environmentPolicy: "inherit-host",
  version: 1,
  createdAt: "2026-11-06T00:00:00.000Z",
  updatedAt: "2026-11-06T00:00:00.000Z",
});
const groups: ReadonlyArray<PickerGroup> = [
  {
    instance,
    runtime: "octant-harness",
    readiness: "ready",
    driverLabel: "Fixture",
    endpointHost: "127.0.0.1",
    executionHost: "Execution Mac",
    sections: [
      {
        id: "tool-capable",
        label: "Available",
        models: ["first", "second"].map((name) => ({
          model: decodeProviderModel({
            id: name,
            displayName: `${name} model`,
            inputModalities: ["text"],
            options: [],
            reasoning: "unavailable",
            source: "discovered",
            verification: "verified",
          }),
          badges: [],
          toolCapable: true,
        })),
      },
    ],
  },
];
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});
describe("continuing the same task elsewhere", () => {
  it("reuses provider selection while leaving the draft unsent and discloses screen and host separately", async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    function Example() {
      const [selected, setSelected] = useState({
        providerInstanceId: instance.id,
        modelId: decodeProviderModelId("first"),
      });
      const choice = useContinuationInputPolicy("work", id);
      return (
        <ContinuityScreenContext.Provider
          value={{
            hostLabel: "Execution Mac",
            screenLabel: "Current browser",
            origin: "https://host.example",
          }}
        >
          <textarea aria-label="Unsent draft" defaultValue="Keep this draft" />
          <ContinueElsewhere
            mode="work"
            threadId={id}
            groups={groups}
            selected={selected}
            policy={choice.policy}
            onPolicyChange={choice.change}
            onProviderChange={(selection) => {
              change(selection);
              setSelected(selection);
            }}
          />
        </ContinuityScreenContext.Provider>
      );
    }
    render(<Example />);
    await user.click(screen.getByRole("button", { name: "Continue elsewhere" }));
    expect(screen.getAllByText("Execution Mac", { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getByText("Current browser")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Text only: omit files and images" }));
    await user.click(screen.getByRole("option", { name: /second model/ }));
    expect(change).toHaveBeenCalledWith({ providerInstanceId: instance.id, modelId: "second" });
    expect(screen.getByRole("link", { name: "Open task link" }).getAttribute("href")).toBe(
      `https://host.example/?continueMode=work&continueThread=${id}`,
    );
    expect(screen.getByText(/Unsent drafts and local view state stay on this screen/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /^Close$/ }));
    expect(screen.getByRole("textbox", { name: "Unsent draft" })).toHaveValue("Keep this draft");
  });
  it("retains an explicit next-turn choice through reload and isolates another task, then clears it after admission", () => {
    const first = renderHook(() => useContinuationInputPolicy("code", id, "http://127.0.0.1:3100"));
    act(() => first.result.current.change("text-only"));
    first.unmount();
    const restored = renderHook(
      ({ threadId }) => useContinuationInputPolicy("code", threadId, "http://127.0.0.1:3100"),
      { initialProps: { threadId: id } },
    );
    expect(restored.result.current.policy).toBe("text-only");
    restored.rerender({ threadId: "22222222-2222-4222-8222-222222222222" });
    expect(restored.result.current.policy).toBe("preserve");
    restored.rerender({ threadId: id });
    act(() => restored.result.current.reset());
    expect(restored.result.current.policy).toBe("preserve");
  });
  it("carries only a task identity into an existing authenticated screen and refuses credential-bearing links", () => {
    const link = continuationLink("https://host.example", "code", id);
    expect(readContinuationLink(String(link))).toEqual({ mode: "code", threadId: id });
    expect(continuationLink("https://user:secret@host.example", "code", id)).toBeUndefined();
    expect(
      readContinuationLink("https://host.example/?continueMode=code&continueThread=/private/file"),
    ).toBeUndefined();
  });
  it("opens a moved thread's page on the member it moved to as that member's screen reads a continue link", () => {
    for (const mode of ["chat", "work", "code"] as const) {
      const page = memberThreadPage("https://studio.tail1234.ts.net:8443", { mode, threadId: id });
      expect(page).toBe(continuationLink("https://studio.tail1234.ts.net:8443", mode, id));
      expect(readContinuationLink(String(page))).toEqual({ mode, threadId: id });
    }
  });
});
