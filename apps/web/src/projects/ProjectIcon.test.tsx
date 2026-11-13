import { render, waitFor } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import {
  ProjectIcon,
  ProjectIconContext,
  ProjectIconProvider,
  createProjectIconSource,
} from "./ProjectIcon";

function answer(status: number) {
  return { ok: status >= 200 && status < 300, status, blob: async () => new Blob(["x"]) };
}

function sourceFor(...statuses: ReadonlyArray<number | "throw">) {
  let call = 0;
  const fetcher = vi.fn(async () => {
    const next = statuses[Math.min(call, statuses.length - 1)];
    call += 1;
    if (next === "throw" || next === undefined) throw new Error("offline");
    return answer(next);
  }) as unknown as typeof fetch;
  return {
    fetcher,
    source: createProjectIconSource({
      serverUrl: "http://127.0.0.1:1/",
      windowCapability: "c",
      fetcher,
    }),
  };
}

function mount(source: ReturnType<typeof createProjectIconSource>) {
  return render(
    <ProjectIconContext.Provider value={source}>
      <ProjectIcon fallback={<span data-testid="glyph" />} projectId="p1" size={16} />
    </ProjectIconContext.Provider>,
  );
}

describe("Project icon", () => {
  it("releases cached blobs when its window source closes", async () => {
    URL.createObjectURL = vi.fn(() => "blob:owned");
    URL.revokeObjectURL = vi.fn();
    const { source, fetcher } = sourceFor(200);
    expect(await source.load("p1")).toBe("blob:owned");
    source.dispose();
    source.dispose();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:owned");
    expect(source.peek("p1")).toBeUndefined();
    expect(await source.load("p2")).toBeNull();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("cancels pending requests and does not retain an icon that arrives after disposal", async () => {
    const body = Promise.withResolvers<Blob>();
    const fetcher = vi.fn<typeof fetch>();
    const response = new Response();
    vi.spyOn(response, "blob").mockReturnValue(body.promise);
    fetcher.mockResolvedValue(response);
    URL.createObjectURL = vi.fn(() => "blob:late");
    URL.revokeObjectURL = vi.fn();
    const source = createProjectIconSource({
      serverUrl: "http://127.0.0.1:1",
      windowCapability: "c",
      fetcher,
    });
    const loading = source.load("p1");
    await waitFor(() => expect(response.blob).toHaveBeenCalled());
    source.dispose();
    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.signal?.aborted).toBe(true);
    body.resolve(new Blob(["late"]));
    expect(await loading).toBeNull();
    expect(source.peek("p1")).toBeUndefined();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("replaces and releases icons with the window credential, including StrictMode remounts", async () => {
    let created = 0;
    URL.createObjectURL = vi.fn(() => `blob:icon-${++created}`);
    URL.revokeObjectURL = vi.fn();
    // Node 22's Response expects a Blob with stream(), which jsdom does not
    // provide. Let the native Response produce its own blob from wire bytes.
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("icon"));
    const tree = (capability: string) => (
      <StrictMode>
        <ProjectIconProvider serverUrl="http://127.0.0.1:1" windowCapability={capability}>
          <ProjectIcon fallback={<span>fallback</span>} projectId="p1" size={16} />
        </ProjectIconProvider>
      </StrictMode>
    );
    const view = render(tree("first"));
    try {
      await waitFor(() =>
        expect(view.container.querySelector("img")?.getAttribute("src")).toBe("blob:icon-1"),
      );
      view.rerender(tree("second"));
      await waitFor(() =>
        expect(view.container.querySelector("img")?.getAttribute("src")).toBe("blob:icon-2"),
      );
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:icon-1");
      view.unmount();
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:icon-2");
    } finally {
      view.unmount();
      fetcher.mockRestore();
    }
  });

  it("asks the host once for an icon however often the row is shown again", async () => {
    URL.createObjectURL = vi.fn(() => "blob:icon");
    const { fetcher, source } = sourceFor(200);
    const first = mount(source);
    await waitFor(() => expect(first.container.querySelector("img")).not.toBeNull());
    first.unmount();
    const second = mount(source);
    expect(second.container.querySelector("img")).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("remembers that a Project has no icon and does not ask again", async () => {
    const { fetcher, source } = sourceFor(404);
    const first = mount(source);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await first.findByTestId("glyph");
    first.unmount();
    const second = mount(source);
    await second.findByTestId("glyph");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([["throw" as const], [401], [503]])(
    "asks again on a later mount after a failed request (%s)",
    async (failure) => {
      URL.createObjectURL = vi.fn(() => "blob:icon");
      const { fetcher, source } = sourceFor(failure, 200);
      const first = mount(source);
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      await first.findByTestId("glyph");
      first.rerender(
        <ProjectIconContext.Provider value={source}>
          <ProjectIcon fallback={<span data-testid="glyph" />} projectId="p1" size={16} />
        </ProjectIconContext.Provider>,
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
      first.unmount();
      const second = mount(source);
      await waitFor(() => expect(second.container.querySelector("img")).not.toBeNull());
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it("shows the glyph when the image cannot be decoded", async () => {
    URL.createObjectURL = vi.fn(() => "blob:broken");
    const { source } = sourceFor(200);
    const view = mount(source);
    const image = await waitFor(() => {
      const found = view.container.querySelector("img");
      expect(found).not.toBeNull();
      return found as HTMLImageElement;
    });
    fireEvent.error(image);
    expect(await view.findByTestId("glyph")).toBeInTheDocument();
    expect(view.container.querySelector("img")).toBeNull();
  });
});
