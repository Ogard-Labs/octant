import { vi } from "vitest";
import { createProjectIconSource } from "./ProjectIcon";

/**
 * A session icon source whose host has an icon for exactly the named Projects
 * and answers 404 for every other, with the fetch spy to count requests.
 */
export function iconSourceFor(projectIdsWithIcon: ReadonlyArray<string>) {
  URL.createObjectURL = vi.fn(() => "blob:project-icon");
  const fetcher = vi.fn(async (input: URL | RequestInfo) => {
    const hasIcon = projectIdsWithIcon.some((id) => String(input).includes(id));
    return {
      ok: hasIcon,
      status: hasIcon ? 200 : 404,
      blob: async () => new Blob(["<svg/>"], { type: "image/svg+xml" }),
    };
  }) as unknown as typeof fetch;
  return {
    fetcher,
    source: createProjectIconSource({
      serverUrl: "http://127.0.0.1:1/",
      windowCapability: "capability",
      fetcher,
    }),
  };
}
