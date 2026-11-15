import { decodeHostAnswer } from "@octant/contracts";
import { TodoListView, TodoResult, type TodoCommand } from "@octant/contracts/todos";
import { bindFetchPort } from "./bindFetchPort";

export interface TodoClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export class TodoClientFailure extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "TodoClientFailure";
    this.status = status;
  }
}

/** The person's to-do list on this host (docs/design/todos.md). */
export interface TodoClient {
  read(signal?: AbortSignal): Promise<TodoListView>;
  change(command: TodoCommand, signal?: AbortSignal): Promise<TodoResult>;
}

export function createTodoClient(options: TodoClientOptions): TodoClient {
  const fetch = bindFetchPort(options.fetch);
  return {
    async read(signal) {
      const body = await send(
        fetch,
        new URL("/api/todos", options.baseUrl).toString(),
        {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
          ...(signal === undefined ? {} : { signal }),
        },
        "The to-do list could not be read from this host.",
      );
      return decodeHostAnswer(TodoListView)(body);
    },
    async change(command, signal) {
      const body = await send(
        fetch,
        new URL("/api/todos/commands", options.baseUrl).toString(),
        {
          method: "POST",
          headers: {
            "x-octant-window-capability": options.windowCapability,
            "content-type": "application/json",
          },
          body: JSON.stringify(command),
          ...(signal === undefined ? {} : { signal }),
        },
        "The to-do could not be saved.",
      );
      return decodeHostAnswer(TodoResult)(body);
    },
  };
}

/** A refusal is an answer, whatever the status: it says why the change was not made. */
function isRefusal(body: unknown): boolean {
  return (
    typeof body === "object" && body !== null && "kind" in body && body.kind === "todo-refused"
  );
}

async function send(
  fetch: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  fallback: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new TodoClientFailure(fallback, 0);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new TodoClientFailure(fallback, response.status);
  }
  if (!response.ok && !isRefusal(body)) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : fallback;
    throw new TodoClientFailure(message, response.status);
  }
  return body;
}
