import { resolveStrict } from "@octant/domain";

/**
 * What the host reads to decide Strict: each thread's own choice, its
 * Project's default, and the Settings defaults. Every read is the projection
 * as it is now, so a change to any of them applies at the next launch or call.
 */
export interface StrictReads {
  readonly codeThread: (
    threadId: string,
  ) => { readonly strict?: boolean | undefined; readonly projectId: string } | undefined;
  readonly workThread: (
    threadId: string,
  ) => { readonly strict?: boolean | undefined; readonly projectId: string } | undefined;
  readonly project: (
    projectId: string,
  ) => { readonly defaultStrict?: boolean | undefined } | undefined;
  readonly codeSettings: () => { readonly defaultStrict?: boolean | undefined } | undefined;
  readonly workSettings: () => { readonly defaultStrict?: boolean | undefined } | undefined;
}

/**
 * The effective Strict value for one thread's launch or call. Every gate that
 * moves behind Strict reads it here, at the moment it decides, never from an
 * earlier launch.
 */
export type StrictResolver = (threadId: string) => boolean;

/**
 * One resolver for every gate. A Code or Work thread takes its own choice,
 * else its Project's, else its mode's Settings default, else off. A Chat
 * thread has no Project or switch of its own, so it is Strict when Strict is
 * the default in Code or Work Settings: a person who asked for Strict anywhere
 * in Settings keeps it in Chat too.
 */
export function createStrictResolver(reads: StrictReads): StrictResolver {
  return (threadId) => {
    const code = reads.codeThread(threadId);
    if (code !== undefined) {
      return resolveStrict({
        thread: code,
        project: reads.project(code.projectId),
        settings: reads.codeSettings(),
      });
    }
    const work = reads.workThread(threadId);
    if (work !== undefined) {
      return resolveStrict({
        thread: work,
        project: reads.project(work.projectId),
        settings: reads.workSettings(),
      });
    }
    return (
      resolveStrict({ settings: reads.codeSettings() }) ||
      resolveStrict({ settings: reads.workSettings() })
    );
  };
}
