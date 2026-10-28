import { OutsideDriverFailure } from "./outside-driver-serve.mjs";

/**
 * An example outside provider driver: it translates Octant's harness
 * requests into the OpenAI-compatible chat completions protocol that local
 * model servers speak (llama.cpp's `llama-server`, LM Studio, vLLM, or
 * Ollama's `/v1`), at the address the person entered when they added the
 * provider.
 *
 * It never touches the network itself. Every call goes through `host.http`,
 * which the host makes on the driver's behalf, only to that address. It asks
 * for no key, because a server on this computer takes none and the host
 * accepts a provider without a key only when its address is on loopback.
 */
export function createLoopbackChatDriver() {
  let baseUrl = "";
  let listed = new Set();
  let nextToolCall = 1;
  const endpoint = (path) => new URL(path, baseUrl).toString();

  return {
    initialize: (configuration) => {
      baseUrl = configuration.baseUrl.endsWith("/")
        ? configuration.baseUrl
        : `${configuration.baseUrl}/`;
      listed = new Set(configuration.modelIds);
    },

    probe: async (host) => {
      const response = await host.http({
        url: endpoint("models"),
        method: "GET",
        headers: [["accept", "application/json"]],
      });
      if (!response.ok) throw await failureFrom(response);
      const body = await response.json().catch(() => undefined);
      const served = Array.isArray(body?.data)
        ? body.data.map((model) => model?.id).filter((id) => typeof id === "string")
        : [];
      // The host offers only the models the person listed, so the driver
      // reports only those: a server with hundreds of models stays within the
      // probe's bounds.
      return {
        models: [...new Set(served)].filter((id) => listed.has(id)).map((id) => ({ id })),
      };
    },

    send: async ({ request }, turn) => {
      const response = await turn.host.http({
        url: endpoint("chat/completions"),
        method: "POST",
        headers: [
          ["content-type", "application/json"],
          ["accept", "text/event-stream"],
        ],
        body: JSON.stringify({
          model: request.modelId,
          messages: chatMessages(request),
          stream: true,
          stream_options: { include_usage: true },
          ...(request.tools.length === 0 ? {} : { tools: request.tools.map(chatTool) }),
        }),
      });
      if (!response.ok) throw await failureFrom(response);
      const answer = await readCompletionStream(response, turn);
      return {
        text: answer.text,
        // The host reads an id or name as trimmed text of at most 128
        // characters, and stops a driver whose answer it cannot read.
        toolCalls: answer.toolCalls.map((call) => ({
          toolCallId: isToolText(call.id) ? call.id.trim() : `call-${nextToolCall++}`,
          toolName: call.name.trim(),
          argumentsJson: call.arguments.trim().length > 0 ? call.arguments : "{}",
        })),
        ...(answer.usage === undefined ? {} : { usage: answer.usage }),
        ...(answer.stopReason === undefined ? {} : { outputStopReason: answer.stopReason }),
      };
    },
  };
}

/**
 * The conversation as chat completions messages. A tool's images are left
 * out: the host keeps image input unsupported for an outside driver, so only
 * the tool's JSON result goes to the model.
 */
function chatMessages(request) {
  const messages = [];
  if (request.system !== undefined && request.system.length > 0) {
    messages.push({ role: "system", content: request.system });
  }
  for (const message of request.history) {
    if (message.role === "assistant") {
      const calls = message.toolCalls ?? [];
      messages.push({
        role: "assistant",
        content: message.text.length > 0 ? message.text : null,
        ...(calls.length === 0
          ? {}
          : {
              tool_calls: calls.map((call) => ({
                id: call.toolCallId,
                type: "function",
                function: { name: call.toolName, arguments: call.argumentsJson },
              })),
            }),
      });
      continue;
    }
    const results = message.toolResults ?? [];
    for (const result of results) {
      messages.push({ role: "tool", tool_call_id: result.toolCallId, content: result.resultJson });
    }
    if (message.text.length > 0 || results.length === 0) {
      messages.push({ role: "user", content: message.text });
    }
  }
  return messages;
}

function chatTool(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: tool.inputSchema,
    },
  };
}

/**
 * Reads a streamed completion. The host relays the body in pieces wherever
 * its reads end, so a server-sent event can arrive split across pieces and
 * only whole lines are parsed.
 */
async function readCompletionStream(response, turn) {
  let text = "";
  let usage;
  let stopReason;
  let pending = "";
  const calls = new Map();

  const readEvent = (data) => {
    if (data === "[DONE]" || data.length === 0) return;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      throw new OutsideDriverFailure("protocol");
    }
    if (chunk?.error !== undefined) throw new OutsideDriverFailure("provider-failed");
    const reported = chunk?.usage;
    if (isTokenCount(reported?.prompt_tokens) && isTokenCount(reported?.completion_tokens)) {
      usage = { inputTokens: reported.prompt_tokens, outputTokens: reported.completion_tokens };
    }
    for (const choice of Array.isArray(chunk?.choices) ? chunk.choices : []) {
      const delta = choice?.delta ?? {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        text += delta.content;
        turn.emit({ kind: "text-delta", text: delta.content });
      }
      // Servers name a reasoning model's thinking differently.
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        turn.emit({ kind: "reasoning-delta", text: reasoning });
      }
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const index = Number.isInteger(call?.index) ? call.index : calls.size;
        const entry = calls.get(index) ?? { id: "", name: "", arguments: "" };
        if (typeof call?.id === "string") entry.id = call.id;
        if (typeof call?.function?.name === "string") entry.name += call.function.name;
        if (typeof call?.function?.arguments === "string") {
          entry.arguments += call.function.arguments;
        }
        calls.set(index, entry);
      }
      if (choice?.finish_reason === "length") stopReason = "max-tokens";
      if (choice?.finish_reason === "content_filter") stopReason = "content-filter";
    }
  };
  const readLine = (line) => {
    if (line.startsWith("data:")) readEvent(line.slice("data:".length).trim());
  };

  for await (const piece of response.chunks()) {
    if (turn.signal.aborted) throw new OutsideDriverFailure("interrupted");
    pending += piece;
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      readLine(pending.slice(0, newline).replace(/\r$/, ""));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  }
  readLine(pending.trim());

  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  // A call with no name or one too long to read, or more calls than the host
  // takes in one answer, is not an answer the host could read.
  if (toolCalls.some((call) => !isToolText(call.name)) || toolCalls.length > 64) {
    throw new OutsideDriverFailure("protocol");
  }
  return { text, toolCalls, usage, stopReason: toolCalls.length > 0 ? undefined : stopReason };
}

function isToolText(value) {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128;
}

/** A count the host reads; a server's negative or runaway count is left out. */
function isTokenCount(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1_000_000_000;
}

/** The failure a refused request becomes; the host writes the words for it. */
async function failureFrom(response) {
  const body = await response.text().catch(() => "");
  if (response.status === 401) return new OutsideDriverFailure("unauthenticated");
  if (response.status === 403) return new OutsideDriverFailure("unauthorized");
  if (response.status === 429) {
    const seconds = Number(response.header("retry-after"));
    return new OutsideDriverFailure("rate-limited", {
      retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined,
    });
  }
  if ((response.status === 400 || response.status === 413) && /context/i.test(body)) {
    const window = /(?:context length (?:is|of)|context size|n_ctx)\D{0,16}(\d+)/i.exec(body);
    return new OutsideDriverFailure("provider-failed", {
      contextOverflow: { contextWindowTokens: window === null ? undefined : Number(window[1]) },
    });
  }
  if (response.status === 404 || response.status >= 500) {
    return new OutsideDriverFailure("unavailable");
  }
  return new OutsideDriverFailure("provider-failed");
}
