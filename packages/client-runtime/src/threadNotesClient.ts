import { ThreadNotesResult, decodeHostAnswer } from "@octant/contracts";
import { bindFetchPort } from "./bindFetchPort";

export interface ThreadNotesClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

/** A thread's notes and its recap. A refusal is a value; only transport and authorization throw. */
export interface ThreadNotesClient {
  notes(threadId: string, signal?: AbortSignal): Promise<ThreadNotesResult>;
  add(threadId: string, text: string): Promise<ThreadNotesResult>;
  edit(threadId: string, noteId: string, text: string): Promise<ThreadNotesResult>;
  remove(threadId: string, noteId: string): Promise<ThreadNotesResult>;
  recap(threadId: string, signal?: AbortSignal): Promise<ThreadNotesResult>;
}

export class ThreadNotesClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ThreadNotesClientFailure";
    this.status = status;
  }
}

const PATH = "/api/thread-notes/commands";
const decodeResult = decodeHostAnswer(ThreadNotesResult);

export function createThreadNotesClient(options: ThreadNotesClientOptions): ThreadNotesClient {
  const fetch = bindFetchPort(options.fetch);
  const url = new URL(PATH, options.baseUrl).toString();
  const send = async (command: unknown, signal?: AbortSignal): Promise<ThreadNotesResult> => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "x-octant-window-capability": options.windowCapability,
          "content-type": "application/json",
        },
        body: JSON.stringify(command),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throw new ThreadNotesClientFailure("Thread notes are unavailable.", 0);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ThreadNotesClientFailure(
        "The thread notes response is malformed.",
        response.status,
      );
    }
    const refused =
      typeof body === "object" &&
      body !== null &&
      (body as { readonly kind?: unknown }).kind === "thread-notes-refused";
    if (!response.ok && !refused) {
      throw new ThreadNotesClientFailure("The thread notes request failed.", response.status);
    }
    return decodeResult(body);
  };
  return {
    notes: (threadId, signal) => send({ kind: "read-thread-notes", threadId }, signal),
    add: (threadId, text) => send({ kind: "add-thread-note", threadId, text }),
    edit: (threadId, noteId, text) => send({ kind: "edit-thread-note", threadId, noteId, text }),
    remove: (threadId, noteId) => send({ kind: "delete-thread-note", threadId, noteId }),
    recap: (threadId, signal) => send({ kind: "read-thread-recap", threadId }, signal),
  };
}
