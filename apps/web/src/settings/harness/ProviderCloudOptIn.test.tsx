import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { decodeProviderInstanceId } from "@octant/contracts";
import {
  decodeProviderCloudResponse,
  type ProviderCloudResponse,
} from "@octant/contracts/provider-cloud-sessions";
import type { ProviderCloudSessionClient } from "@octant/client-runtime/provider-cloud-session-client";
import { ProviderCloudOptIn } from "./ProviderCloudOptIn";

const first = decodeProviderInstanceId("a7550000-0000-4000-8000-000000000001");
const second = decodeProviderInstanceId("a7550000-0000-4000-8000-000000000002");
const response = (enabled: boolean) =>
  decodeProviderCloudResponse({
    status: "ready",
    jobs: [],
    profiles: [
      { instanceId: first, label: "First API", supported: true, enabled, models: [] },
      { instanceId: second, label: "Second API", supported: true, enabled: false, models: [] },
    ],
  });

describe("provider cloud opt-in", () => {
  it("saves only the selected endpoint and ignores its delayed answer after changing endpoints", async () => {
    const pending = Promise.withResolvers<ProviderCloudResponse>();
    const execute = vi
      .fn<ProviderCloudSessionClient["execute"]>()
      .mockImplementation(async (command) =>
        command.kind === "opt-in" ? pending.promise : response(false),
      );
    const client = { execute };
    const rendered = render(<ProviderCloudOptIn client={client} instanceId={first} />);
    const toggle = screen.getByRole("switch", { name: "Allow cloud sessions for this endpoint" });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    expect(execute.mock.calls.find(([command]) => command.kind === "opt-in")?.[0]).toEqual({
      kind: "opt-in",
      instanceId: first,
      enabled: true,
    });
    rendered.rerender(<ProviderCloudOptIn client={client} instanceId={second} />);
    await waitFor(() => expect(toggle).toBeEnabled());
    await act(async () => pending.resolve(response(true)));
    expect(toggle).not.toBeChecked();
    expect(execute.mock.calls.filter(([command]) => command.kind === "start")).toHaveLength(0);
  });
});
