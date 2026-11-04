import { randomUUID } from "node:crypto";
import type {
  CredentialRequestAnswer,
  CredentialRequestCard,
  CredentialRequestView,
} from "@octant/contracts/credential-request";
import type { CredentialOperation } from "@octant/plugin-api/credential-request";

type State = CredentialRequestCard["state"];
type Result = { readonly status: Exclude<State, "pending" | "using"> };
interface Pending {
  readonly windowId: string;
  readonly card: CredentialRequestCard;
  readonly operation: CredentialOperation;
  readonly current: () => boolean;
  readonly expires: number;
  readonly controller: AbortController;
  readonly finish: (result: Result) => void;
  state: State;
}

/**
 * Transient host-owned consent. No submitted value is placed in a record,
 * file, tool result or event. Approval immediately consumes the request; the
 * value lives only in the bounded HTTPS call, never in a reusable session.
 */
export class CredentialRequests {
  readonly #requests = new Map<string, Pending>();
  readonly #fetch: (request: Request) => Promise<Response>;
  readonly #now: () => number;
  readonly #timer: ReturnType<typeof setInterval>;

  constructor(
    options: {
      readonly fetch?: (request: Request) => Promise<Response>;
      readonly now?: () => number;
    } = {},
  ) {
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => performance.now());
    this.#timer = setInterval(() => this.#sweep(), 1000);
    this.#timer.unref();
  }

  request(input: {
    readonly windowId: string;
    readonly threadId: string;
    readonly operation: CredentialOperation;
    readonly current: () => boolean;
    readonly signal: AbortSignal;
  }): Promise<Result> {
    this.#sweep();
    if (input.signal.aborted || !input.current()) return Promise.resolve({ status: "cancelled" });
    const url = new URL(input.operation.request.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      return Promise.resolve({ status: "failed" });
    const existing = [...this.#requests.values()].filter(
      (entry) => entry.windowId === input.windowId && entry.card.threadId === input.threadId,
    );
    if (
      existing.some((entry) => entry.state === "pending" || entry.state === "using") ||
      this.#requests.size >= 128
    )
      return Promise.resolve({ status: "failed" });
    for (const entry of existing) this.#requests.delete(entry.card.id);
    return new Promise((resolve) => {
      const id = randomUUID();
      const controller = new AbortController();
      const cancelled = () => this.#settle(entry, "cancelled");
      const entry: Pending = {
        windowId: input.windowId,
        operation: input.operation,
        current: input.current,
        expires: this.#now() + 10 * 60_000,
        controller,
        state: "pending",
        card: {
          id,
          threadId: input.threadId,
          label: input.operation.label,
          reason: input.operation.reason,
          consumer: input.operation.consumer,
          destination: url.origin,
          actionLabel: input.operation.actionLabel,
          state: "pending",
        },
        finish: (result) => {
          input.signal.removeEventListener("abort", cancelled);
          resolve(result);
        },
      };
      this.#requests.set(id, entry);
      input.signal.addEventListener("abort", cancelled, { once: true });
      if (input.signal.aborted) cancelled();
    });
  }

  view(windowId: string, threadId: string): CredentialRequestView {
    this.#sweep();
    return {
      requests: [...this.#requests.values()]
        .filter((entry) => entry.windowId === windowId && entry.card.threadId === threadId)
        .map((entry) => ({ ...entry.card, state: entry.state })),
    };
  }

  async answer(windowId: string, answer: CredentialRequestAnswer): Promise<boolean> {
    this.#sweep();
    const entry = this.#requests.get(answer.id);
    if (entry === undefined || entry.windowId !== windowId || entry.state !== "pending")
      return false;
    if (answer.action === "decline") {
      this.#settle(entry, "declined");
      return true;
    }
    // Header injection and whitespace-only values fail without consuming the card.
    if (
      !answer.secret.trim() ||
      ["\r", "\n", "\0"].some((character) => answer.secret.includes(character)) ||
      Buffer.byteLength(answer.secret) > 4096
    )
      return false;
    // Synchronous claim precedes every await, including the network launch.
    entry.state = "using";
    const timeout = setTimeout(() => this.#settle(entry, "failed"), 15_000);
    try {
      if (!entry.current()) {
        this.#settle(entry, "cancelled");
        return false;
      }
      const spec = entry.operation.request;
      const response = await this.#fetch(
        new Request(spec.url, {
          method: "POST",
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
          headers: {
            "content-type": "application/json",
            authorization:
              spec.authorization === "bearer" ? `Bearer ${answer.secret}` : answer.secret,
          },
          body: spec.body,
          signal: entry.controller.signal,
        }),
      );
      const body = await boundedJson(response);
      if (entry.state !== "using") return true;
      if (!entry.current()) this.#settle(entry, "cancelled");
      else this.#settle(entry, response.ok && entry.operation.accepted(body) ? "used" : "failed");
    } catch {
      // Network errors can contain request headers or response data. Never forward them.
      this.#settle(entry, "failed");
    } finally {
      clearTimeout(timeout);
    }
    return true;
  }

  close(): void {
    clearInterval(this.#timer);
    for (const entry of this.#requests.values()) this.#settle(entry, "cancelled");
    this.#requests.clear();
  }

  #settle(entry: Pending, state: Result["status"]): void {
    if (entry.state !== "pending" && entry.state !== "using") return;
    entry.state = state;
    entry.controller.abort();
    entry.finish({ status: state });
  }

  #sweep(): void {
    for (const entry of this.#requests.values()) {
      if (!entry.current()) this.#settle(entry, "cancelled");
      if (this.#now() >= entry.expires) {
        this.#settle(entry, "expired");
        // Keep a bounded status briefly so the card can explain expiry.
        if (this.#now() >= entry.expires + 60_000) this.#requests.delete(entry.card.id);
      }
    }
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16_384) return undefined;
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
