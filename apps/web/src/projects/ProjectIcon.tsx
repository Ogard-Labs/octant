import { createContext, useContext, useEffect, useReducer, useState, type ReactNode } from "react";

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
  /** Which icon a Project shows, once known: the one a person chose, and whether its folder has one too. */
  readonly details?: (projectId: string) => ProjectIconDetails | undefined;
  /** Calls back when a Project's icon changed, so every mark of it asks again. */
  readonly subscribe?: (projectId: string, listener: () => void) => () => void;
  /** Sends the host a picture to keep as the Project's icon. */
  readonly choose?: (projectId: string, file: File) => Promise<ProjectIconChange>;
  /** Drops the chosen icon; the folder's own shows again, or the letter tile. */
  readonly reset?: (projectId: string) => Promise<ProjectIconChange>;
}

export interface ProjectIconDetails {
  readonly custom: boolean;
  readonly foundAvailable: boolean;
}

export type ProjectIconChange =
  | { readonly status: "changed" }
  | { readonly status: "refused"; readonly message: string };

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
  const details = new Map<string, ProjectIconDetails>();
  const pending = new Map<string, Promise<string | null>>();
  const listeners = new Map<string, Set<() => void>>();
  // A replaced icon's object URL stays until the source is disposed: a mark
  // that has not yet swapped to the new one must not show a broken image.
  const urls = new Set<string>();
  const lifetime = new AbortController();
  const doFetch = input.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const headers = (extra: Record<string, string> = {}): Record<string, string> =>
    input.windowCapability === undefined
      ? extra
      : { ...extra, "x-octant-window-capability": input.windowCapability };
  const iconUrl = (projectId: string) =>
    new URL(`/api/projects/${encodeURIComponent(projectId)}/icon`, input.serverUrl);
  /** Forget what was learned and tell every mark of this Project to ask again. */
  const changed = (projectId: string) => {
    pending.delete(projectId);
    for (const listener of listeners.get(projectId) ?? []) listener();
  };
  const settle = async (request: Promise<Response>): Promise<ProjectIconChange> => {
    try {
      const response = await request;
      if (response.ok) return { status: "changed" };
      const body: unknown = await response.json().catch(() => undefined);
      const message =
        typeof body === "object" && body !== null && "message" in body
          ? String((body as { message: unknown }).message)
          : `The icon could not be changed (${String(response.status)}).`;
      return { status: "refused", message };
    } catch {
      return { status: "refused", message: "The icon could not be sent to the host." };
    }
  };
  return {
    peek: (projectId) => answers.get(projectId),
    details: (projectId) => details.get(projectId),
    subscribe: (projectId, listener) => {
      const set = listeners.get(projectId) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(projectId, set);
      return () => set.delete(listener);
    },
    choose: async (projectId, file) => {
      // The host copies these bytes; it is never given the file's path.
      const outcome = await settle(
        doFetch(iconUrl(projectId), {
          method: "PUT",
          headers: headers({ "content-type": file.type }),
          body: file,
          redirect: "error",
          signal: lifetime.signal,
        }),
      );
      if (outcome.status === "changed") changed(projectId);
      return outcome;
    },
    reset: async (projectId) => {
      const outcome = await settle(
        doFetch(iconUrl(projectId), {
          method: "DELETE",
          headers: headers(),
          redirect: "error",
          signal: lifetime.signal,
        }),
      );
      if (outcome.status === "changed") changed(projectId);
      return outcome;
    },
    load: (projectId) => {
      if (lifetime.signal.aborted) return Promise.resolve(null);
      const known = pending.get(projectId);
      if (known !== undefined) return known;
      // Only a definite answer is kept: the icon (200) or none (404). A thrown
      // error, a 401 or a 5xx says nothing about the folder, so the entry is
      // dropped and the next mount asks once more. The effect runs per mount,
      // never per render or navigation refresh, so this cannot become a loop.
      const request = (async (): Promise<{ url: string | null; definite: boolean }> => {
        try {
          // A redirect from the judged URL could forward the credential to
          // another host in plaintext, so none is followed.
          const response = await doFetch(iconUrl(projectId), {
            headers: headers(),
            redirect: "error",
            signal: lifetime.signal,
          });
          if (response.status === 404) {
            details.delete(projectId);
            return { url: null, definite: true };
          }
          if (!response.ok) return { url: null, definite: false };
          const blob = await response.blob();
          if (lifetime.signal.aborted) return { url: null, definite: false };
          details.set(projectId, {
            custom: response.headers?.get("x-octant-project-icon-source") === "custom",
            foundAvailable: response.headers?.get("x-octant-project-icon-found") !== "0",
          });
          const created = URL.createObjectURL(blob);
          urls.add(created);
          return { url: created, definite: true };
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
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
      answers.clear();
      details.clear();
      pending.clear();
      listeners.clear();
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
 * Asks for every known Project's icon as soon as the Project is known, not when
 * a row that shows it first mounts. The sidebar lists one mode's threads at a
 * time, so a Project seen only in the other mode had no answer yet: switching
 * mode drew its letter tile and swapped to the picture about 200ms later.
 * `load` keeps each answer for the session, so this asks once per Project.
 */
export function ProjectIconPrefetch(props: { readonly projectIds: ReadonlyArray<string> }) {
  const source = useContext(ProjectIconContext);
  const ids = props.projectIds.join("\n");
  useEffect(() => {
    if (source === undefined || ids === "") return;
    for (const projectId of ids.split("\n")) void source.load(projectId);
  }, [source, ids]);
  return null;
}

/**
 * Which icon a Project shows, for a menu that offers to change it. It loads the
 * icon once, like a mark does, and asks again whenever the icon changes.
 */
export function useProjectIconDetails(projectId: string): ProjectIconDetails | undefined {
  const source = useContext(ProjectIconContext);
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (source === undefined) return;
    let current = true;
    const ask = () => {
      void source.load(projectId).then(() => {
        if (current) refresh();
      });
    };
    ask();
    const stop = source.subscribe?.(projectId, ask);
    return () => {
      current = false;
      stop?.();
    };
  }, [source, projectId]);
  return source?.details?.(projectId);
}

export function useProjectIconSource(): ProjectIconSource | undefined {
  return useContext(ProjectIconContext);
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
  // Bumped when the person changes this Project's icon: the mark asks again
  // and keeps the old picture on screen until the new answer arrives.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (source?.subscribe === undefined) return;
    return source.subscribe(props.projectId, () => setGeneration((current) => current + 1));
  }, [source, props.projectId]);
  useEffect(() => {
    if (source === undefined) return;
    let current = true;
    void source.load(props.projectId).then((url) => {
      if (current) setLoaded({ source, projectId: props.projectId, url });
    });
    return () => {
      current = false;
    };
  }, [source, props.projectId, generation]);
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
