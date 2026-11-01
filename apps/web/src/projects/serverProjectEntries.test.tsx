import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { serverProjectEntries, useServerCodeProjectsSource } from "./serverProjectEntries";

const serverId = "5e7e0000-0000-4000-8000-0000000000aa";
const projectId = "77777777-7777-4777-8777-777777777777";

function view() {
  return {
    projects: [
      {
        id: projectId,
        name: "Service",
        serverId,
        folder: "/home/build/service",
        boundAt: "2026-10-30T10:00:00.000Z",
      },
    ],
  } as never;
}

describe("useServerCodeProjectsSource", () => {
  it("names each server Project by its registered alias and folder", async () => {
    const { result } = renderHook(() =>
      useServerCodeProjectsSource(
        { read: vi.fn().mockResolvedValue(view()) },
        { read: vi.fn().mockResolvedValue({ servers: [{ serverId, alias: "devbox" }] }) },
      ),
    );
    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    expect(result.current.projects[0]).toMatchObject({
      name: "Service",
      location: "devbox:/home/build/service",
    });
    expect(serverProjectEntries(result.current.projects)).toMatchObject([
      { kind: "server-project", displayName: "Service", location: "devbox:/home/build/service" },
    ]);
  });

  it("falls back to the folder when the registry cannot be read", async () => {
    const { result } = renderHook(() =>
      useServerCodeProjectsSource(
        { read: vi.fn().mockResolvedValue(view()) },
        { read: vi.fn().mockRejectedValue(new Error("down")) },
      ),
    );
    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    expect(result.current.projects[0]?.location).toBe("/home/build/service");
  });

  it("lists nothing without a server Projects client", () => {
    const { result } = renderHook(() => useServerCodeProjectsSource(undefined, undefined));
    expect(result.current.projects).toEqual([]);
  });
});
