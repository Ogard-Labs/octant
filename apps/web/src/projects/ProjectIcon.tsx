import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/** The sizes apps/web draws icons at; a Project's own icon follows the same scale. */
export type ProjectIconSize = 12 | 14 | 16 | 20 | 24;

/**
 * Where a Project's icon comes from. `peek` answers at once from what this
 * session already learned, so a row that remounts does not flash its glyph;
 * `load` asks the host at most once per Project and remembers the answer,
 * including "none".
 */
export interface ProjectIconSource {
  readonly peek: (projectId: string) => string | null | undefined;
  readonly load: (projectId: string) => Promise<string | null>;
}

export const ProjectIconContext = createContext<ProjectIconSource | undefined>(undefined);

/**
 * The icon request carries the window credential in a header, which an image
 * element cannot send, so the bytes are fetched and drawn from an object URL,
 * the way the sidebar background is. The answer is kept for the session:
 * the navigation model is polled and rows re-render often, and neither may
 * turn into a request per Project. A Project that gains an icon during the
 * session shows it on the next launch. The object URLs live as long as the
 * session; they are a few kilobytes each.
 */
export function createProjectIconSource(input: {
  readonly serverUrl: string;
  readonly windowCapability: string | undefined;
  readonly fetcher?: typeof fetch;
}): ProjectIconSource {
  const answers = new Map<string, string | null>();
  const pending = new Map<string, Promise<string | null>>();
  const doFetch = input.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return {
    peek: (projectId) => answers.get(projectId),
    load: (projectId) => {
      const known = pending.get(projectId);
      if (known !== undefined) return known;
      const headers: Record<string, string> = {};
      if (input.windowCapability !== undefined) {
        headers["x-octant-window-capability"] = input.windowCapability;
      }
      // Only a definite answer is kept: the icon (200) or none (404). A thrown
      // error, a 401 or a 5xx says nothing about the folder, so the entry is
      // dropped and the next mount asks once more. The effect runs per mount,
      // never per render or navigation refresh, so this cannot become a loop.
      const request = (async (): Promise<{ url: string | null; definite: boolean }> => {
        try {
          // A redirect from the judged URL could forward the credential to
          // another host in plaintext, so none is followed.
          const response = await doFetch(
            new URL(`/api/projects/${encodeURIComponent(projectId)}/icon`, input.serverUrl),
            { headers, redirect: "error" },
          );
          if (response.status === 404) return { url: null, definite: true };
          if (!response.ok) return { url: null, definite: false };
          return { url: URL.createObjectURL(await response.blob()), definite: true };
        } catch {
          return { url: null, definite: false };
        }
      })().then(({ url, definite }) => {
        if (definite) answers.set(projectId, url);
        else pending.delete(projectId);
        return url;
      });
      pending.set(projectId, request);
      return request;
    },
  };
}

export function ProjectIconProvider(props: {
  readonly serverUrl: string;
  readonly windowCapability: string | undefined;
  readonly children: ReactNode;
}) {
  const source = useMemo(
    () =>
      createProjectIconSource({
        serverUrl: props.serverUrl,
        windowCapability: props.windowCapability,
      }),
    [props.serverUrl, props.windowCapability],
  );
  return <ProjectIconContext.Provider value={source}>{props.children}</ProjectIconContext.Provider>;
}

/**
 * A Project's own icon, found by the host in the Project's folder, drawn as an
 * image. The caller's glyph shows while it loads, when the Project has none,
 * and when the image fails to decode.
 */
export function ProjectIcon(props: {
  readonly projectId: string;
  readonly size: ProjectIconSize;
  readonly fallback: ReactNode;
}) {
  const source = useContext(ProjectIconContext);
  const [loaded, setLoaded] = useState<{
    readonly projectId: string;
    readonly url: string | null;
  }>();
  useEffect(() => {
    if (source === undefined) return;
    let current = true;
    void source.load(props.projectId).then((url) => {
      if (current) setLoaded({ projectId: props.projectId, url });
    });
    return () => {
      current = false;
    };
  }, [source, props.projectId]);
  const [broken, setBroken] = useState<string>();
  const url =
    loaded?.projectId === props.projectId ? loaded.url : (source?.peek(props.projectId) ?? null);
  if (url === null || broken === url) return <>{props.fallback}</>;
  return (
    <img
      alt=""
      className="project-icon"
      draggable={false}
      height={props.size}
      onError={() => setBroken(url)}
      src={url}
      width={props.size}
    />
  );
}
