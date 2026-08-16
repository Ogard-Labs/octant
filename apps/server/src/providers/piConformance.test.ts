import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  type ProviderModelId,
} from "@octant/contracts";
import { runProviderConformance } from "@octant/provider-sdk/conformance";
import { runProviderChatConformance } from "@octant/provider-sdk/chat-conformance";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makePiDriver, type PiClientPort } from "./piDriver";
import {
  recordProviderChatConformanceEvidence,
  recordProviderConformanceEvidence,
} from "./chatProviderMatrixEvidence.test-support";
import type { PiProcessPort, PiRpcConnection } from "./piProcess";
import type { PiRpcEvent } from "./piRpcClient";
import { ProviderRuntimeRegistry } from "./providerRuntimeRegistry";

const instanceId = decodeProviderInstanceId("80000000-0000-4000-8000-000000000711");
const sessionId = decodeProviderSessionId("80000000-0000-4000-8000-000000000712");
const modelId = "anthropic/claude-sonnet" as ProviderModelId;

describe("Pi provider conformance", () => {
  it("passes lifecycle, capability, resume, approval, interruption, and cleanup conformance", async () => {
    const clients: ConformanceClient[] = [];
    let active = 0;
    let released = 0;
    const processPort: PiProcessPort = {
      start: (input) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            active += 1;
            const client = new ConformanceClient(String(input.sessionId));
            clients.push(client);
            return {
              version: "0.80.10",
              pid: 711,
              root: input.root,
              rpc: {} as PiRpcConnection["rpc"],
              exited: new Promise<void>(() => undefined),
            };
          }),
          () =>
            Effect.sync(() => {
              active -= 1;
              released += 1;
            }),
        ),
    };
    const registry = new ProviderRuntimeRegistry();
    let approval = 0;
    const driver = makePiDriver({
      instanceId,
      binaryPath: "/opt/homebrew/bin/pi",
      piHome: "/managed/pi",
      process: processPort,
      runtimeRegistry: registry,
      clientFactory: () => clients.at(-1)!,
      clock: () => "2026-07-18T06:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000713",
      requestId: () => `approval-${++approval}`,
    });

    const evidence = await runProviderConformance({
      driver,
      probeInput: { instanceId },
      acquireInput: { instanceId, projectRoot: "/tmp/octant-pi-conformance", mode: "code" },
      sessionStart: { sessionId, modelId, executionPolicy: "approval-gated" },
      turn: { sessionId, prompt: "hello", attachments: [], tools: [] },
      resume: {
        sessionId,
        resumeCursor: { driverKind: "pi", value: sessionId },
        executionPolicy: "approval-gated",
      },
      staleResume: {
        sessionId,
        resumeCursor: { driverKind: "pi", value: "stale" },
        executionPolicy: "approval-gated",
      },
      unknownApproval: { sessionId, requestId: "unknown", approved: false },
      unknownUserInput: { sessionId, requestId: "unknown", answer: "none" },
      expectedEventKinds: [
        "text-delta",
        "reasoning-delta",
        "tool-start",
        "approval-request",
        "interrupted",
      ],
      expectedFailureCategories: {
        staleResume: "stale-resume",
        unknownApproval: "protocol",
        unknownUserInput: "unsupported",
      },
      isReleased: () => active === 0 && released >= 3,
    });
    recordProviderConformanceEvidence("pi", evidence);

    expect(evidence).toEqual({
      probed: true,
      capabilityHonest: true,
      usageCapabilityHonest: true,
      researchCapabilityHonest: true,
      citationsCapabilityHonest: true,
      streamedInOrder: true,
      interrupted: true,
      resumed: true,
      staleResumeRejected: true,
      unknownApprovalRejected: true,
      unknownUserInputRejected: true,
      failureClassified: true,
      released: true,
    });
  });

  it("passes chat conformance with explicit unsupported native attachments", async () => {
    const fixture = createPiConformanceFixture();
    const evidence = await runProviderChatConformance({
      driver: fixture.driver,
      probeInput: { instanceId },
      acquireInput: { instanceId, projectRoot: "/tmp/octant-pi-conformance", mode: "code" },
      sessionStart: { sessionId, modelId, executionPolicy: "approval-gated" },
      turn: {
        sessionId,
        prompt: "hello",
        attachments: [
          {
            attachmentId: "attachment-1",
            displayName: "diagram.png",
            mediaType: "image/png",
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
        tools: [],
      },
      isReleased: fixture.isReleased,
    });
    recordProviderChatConformanceEvidence("pi", evidence);
    expect(evidence).toMatchObject({ nativeAttachmentHonest: true, released: true });
  });
});

function createPiConformanceFixture() {
  const clients: ConformanceClient[] = [];
  let active = 0;
  let released = 0;
  const processPort: PiProcessPort = {
    start: (input) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          active += 1;
          const client = new ConformanceClient(String(input.sessionId));
          clients.push(client);
          return {
            version: "0.80.10",
            pid: 711,
            root: input.root,
            rpc: {} as PiRpcConnection["rpc"],
            exited: new Promise<void>(() => undefined),
          };
        }),
        () =>
          Effect.sync(() => {
            active -= 1;
            released += 1;
          }),
      ),
  };
  let approval = 0;
  return {
    driver: makePiDriver({
      instanceId,
      binaryPath: "/opt/homebrew/bin/pi",
      piHome: "/managed/pi",
      process: processPort,
      runtimeRegistry: new ProviderRuntimeRegistry(),
      clientFactory: () => clients.at(-1)!,
      clock: () => "2026-07-18T06:00:00.000Z",
      correlationId: () => "80000000-0000-4000-8000-000000000713",
      requestId: () => `approval-${++approval}`,
    }),
    isReleased: () => active === 0 && released >= 1,
  };
}

class ConformanceClient implements PiClientPort {
  readonly #events = new Set<(event: PiRpcEvent) => void>();

  constructor(private readonly sessionId: string) {}

  onEvent(listener: (event: PiRpcEvent) => void) {
    this.#events.add(listener);
    return () => {
      this.#events.delete(listener);
    };
  }

  respondToUi = async () => undefined;

  request = async (type: string) => {
    if (type === "get_available_models") {
      return {
        type: "response" as const,
        command: type,
        success: true,
        data: {
          models: [
            {
              provider: "anthropic",
              id: "claude-sonnet",
              name: "Claude Sonnet",
              reasoning: true,
            },
          ],
        },
      };
    }
    if (type === "get_state") {
      return {
        type: "response" as const,
        command: type,
        success: true,
        data: { sessionId: this.sessionId },
      };
    }
    if (type === "prompt") {
      const emit = (event: PiRpcEvent) => this.#events.forEach((listener) => listener(event));
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hello" },
      });
      emit({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "think" },
      });
      emit({ type: "tool_execution_start", toolCallId: "tool-1", toolName: "write" });
      emit({
        type: "extension_ui_request",
        id: "pi-ui-1",
        method: "confirm",
        title: "Octant approval:tool-1:write",
      });
    }
    return { type: "response" as const, command: type, success: true };
  };
}
