import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

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
  readonly dispose: () => void;
}

export const ProjectIconContext = createContext<ProjectIconSource | undefined>(undefined);

/**
 * The icon request carries the window credential in a header, which an image
 * element cannot send, so the bytes are fetched and drawn from an object URL,
 * the way the sidebar background is. The answer is kept for the session:
 * the navigation model is polled and rows re-render often, and neither may
 * turn into a request per Project. A Project that gains an icon during the
 * session shows it on the next launch. Replacing the window credential or
 * closing the provider releases its requests and object URLs.
 */
export function createProjectIconSource(input: {
  readonly serverUrl: string;
  readonly windowCapability: string | undefined;
  readonly fetcher?: typeof fetch;
}): ProjectIconSource {
  const answers = new Map<string, string | null>();
  const pending = new Map<string, Promise<string | null>>();
  const lifetime = new AbortController();
  const doFetch = input.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  return {
    peek: (projectId) => answers.get(projectId),
    load: (projectId) => {
      if (lifetime.signal.aborted) return Promise.resolve(null);
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
            { headers, redirect: "error", signal: lifetime.signal },
          );
          if (response.status === 404) return { url: null, definite: true };
          if (!response.ok) return { url: null, definite: false };
          const blob = await response.blob();
          if (lifetime.signal.aborted) return { url: null, definite: false };
          return { url: URL.createObjectURL(blob), definite: true };
        } catch {
          return { url: null, definite: false };
        }
      })().then(({ url, definite }) => {
        if (lifetime.signal.aborted) {
          if (url !== null) URL.revokeObjectURL(url);
          return null;
        }
        if (definite) answers.set(projectId, url);
        else pending.delete(projectId);
        return url;
      });
      pending.set(projectId, request);
      return request;
    },
    dispose: () => {
      lifetime.abort();
      for (const url of answers.values()) {
        if (url !== null) URL.revokeObjectURL(url);
      }
      answers.clear();
      pending.clear();
    },
  };
}

export function ProjectIconProvider(props: {
  readonly serverUrl: string;
  readonly windowCapability: string | undefined;
  readonly children: ReactNode;
}) {
  const [owned, setOwned] = useState<{
    readonly serverUrl: string;
    readonly windowCapability: string | undefined;
    readonly source: ProjectIconSource;
  }>();
  useEffect(() => {
    // Own the source in the effect so StrictMode's cleanup/setup cycle gets
    // a fresh live source, rather than reusing one whose requests were aborted.
    const source = createProjectIconSource({
      serverUrl: props.serverUrl,
      windowCapability: props.windowCapability,
    });
    setOwned({ serverUrl: props.serverUrl, windowCapability: props.windowCapability, source });
    return () => source.dispose();
  }, [props.serverUrl, props.windowCapability]);
  const source =
    owned?.serverUrl === props.serverUrl && owned.windowCapability === props.windowCapability
      ? owned.source
      : undefined;
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
    readonly source: ProjectIconSource;
    readonly projectId: string;
    readonly url: string | null;
  }>();
  useEffect(() => {
    if (source === undefined) return;
    let current = true;
    void source.load(props.projectId).then((url) => {
      if (current) setLoaded({ source, projectId: props.projectId, url });
    });
    return () => {
      current = false;
    };
  }, [source, props.projectId]);
  const [broken, setBroken] = useState<string>();
  const url =
    loaded?.source === source && loaded?.projectId === props.projectId
      ? loaded.url
      : (source?.peek(props.projectId) ?? null);
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
