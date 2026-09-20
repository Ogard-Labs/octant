import type { AndroidToolchainClient } from "@octant/client-runtime/android-toolchain-client";
import type {
  AndroidEmulatorId,
  AndroidEmulatorRecord,
  AndroidEmulatorRequest,
} from "@octant/contracts/android-toolchain";
import { LOCAL_TOOL_HOST_ID } from "@octant/contracts/tool-actions";
import {
  ANDROID_INPUT_GRANT_MS,
  androidInputGrantIsLive,
  decidesCodeEffectsByApproval,
  isAndroidEmulatorInputKind,
  isAndroidEmulatorOpenInputKind,
} from "@octant/domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { ShellState } from "../shell/ShellState";
import { gestureFrom, keyIntentFor, type PointerSample } from "../apple/simulatorGestures";
import type { OctantHostBridge } from "../shell/hostBridge";
import type { CodeController } from "../code/useCodeController";
import { useAndroidEmulator } from "./useAndroidEmulator";
import {
  useAndroidEmulatorLiveScreen,
  type AndroidEmulatorLiveScreen,
} from "./useAndroidEmulatorLiveScreen";

export type AndroidEmulatorIntent =
  | { readonly kind: "boot" | "shutdown" | "screenshot" | "open-input"; readonly emulatorId: AndroidEmulatorId }
  | {
      readonly kind: "tap";
      readonly emulatorId: AndroidEmulatorId;
      readonly point: { readonly x: number; readonly y: number };
    }
  | {
      readonly kind: "swipe";
      readonly emulatorId: AndroidEmulatorId;
      readonly point: { readonly x: number; readonly y: number };
      readonly toPoint: { readonly x: number; readonly y: number };
      readonly durationMs: number;
    }
  | { readonly kind: "type-text"; readonly emulatorId: AndroidEmulatorId; readonly text: string }
  | { readonly kind: "key-press"; readonly emulatorId: AndroidEmulatorId; readonly key: string };

export function AndroidEmulatorPane(props: {
  readonly client: AndroidToolchainClient;
  readonly createUuid: () => string;
  readonly hostBridge?: OctantHostBridge;
  readonly requestApproval?: (request: AndroidEmulatorRequest) => Promise<string | undefined>;
  readonly thread: NonNullable<CodeController["activeView"]>["thread"];
  readonly checkoutId: NonNullable<CodeController["activeView"]>["checkout"]["id"];
}) {
  const [identity] = useState(() => ({
    actionId: props.createUuid(),
    correlationId: props.createUuid(),
  }));
  const authority = useMemo(
    () => ({
      hostId: LOCAL_TOOL_HOST_ID,
      mode: "code" as const,
      projectId: props.thread.projectId,
      providerInstanceId: props.thread.providerInstanceId,
      extension: { kind: "core" as const },
    }),
    [props.thread.projectId, props.thread.providerInstanceId],
  );
  const discoveryRequest = useMemo(
    () => ({
      actionId: identity.actionId as never,
      correlationId: identity.correlationId as never,
      authority,
      threadId: props.thread.id,
      checkoutId: props.checkoutId,
    }),
    [authority, identity.actionId, identity.correlationId, props.checkoutId, props.thread.id],
  );
  const snapshotRequest = useMemo(
    () => ({
      kind: "android-snapshot-request" as const,
      authority,
      threadId: props.thread.id,
      checkoutId: props.checkoutId,
    }),
    [authority, props.checkoutId, props.thread.id],
  );
  const controller = useAndroidEmulator({
    client: props.client,
    discoveryRequest,
    snapshotRequest,
  });
  const [busy, setBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string>();
  const approvalGated = decidesCodeEffectsByApproval(props.thread.executionPolicy);
  const rememberedInputGrants = useRef(new Map<string, number>());
  const inputFlight = useRef(Promise.resolve());
  const [rememberedGrantEpoch, setRememberedGrantEpoch] = useState(0);
  const [frameAttach, setFrameAttach] = useState(false);
  useEffect(() => {
    let active = true;
    void Promise.resolve(props.hostBridge?.getHostCapabilities?.()).then((capabilities) => {
      if (!active) return;
      setFrameAttach(capabilities?.liveSimulatorFrameSupported === true);
    });
    return () => {
      active = false;
    };
  }, [props.hostBridge]);

  const emulators = controller.discovery?.emulators ?? controller.runtime?.emulators ?? [];
  const preferred = controller.runtime?.paneOpenRequest?.emulatorId;
  const liveEmulator =
    emulators.find((emulator) => preferred !== undefined && emulator.emulatorId === preferred) ??
    emulators.find((emulator) => emulator.state === "booting") ??
    emulators.find((emulator) => emulator.state === "booted");
  const liveEmulatorId = liveEmulator?.state === "booted" ? liveEmulator.emulatorId : undefined;
  const rememberedUntil =
    liveEmulatorId === undefined
      ? 0
      : (rememberedInputGrants.current.get(String(liveEmulatorId)) ?? 0);
  const inputAllowed =
    !approvalGated ||
    (liveEmulatorId !== undefined &&
      (androidInputGrantIsLive(controller.runtime, String(liveEmulatorId), Date.now()) ||
        rememberedUntil > Date.now() ||
        rememberedGrantEpoch > Date.now()));
  const needsAllowInput = approvalGated && !inputAllowed;
  const screenStreamRequest = useMemo(
    () =>
      liveEmulatorId === undefined
        ? undefined
        : {
            kind: "android-screen-stream-request" as const,
            authority,
            threadId: props.thread.id,
            checkoutId: props.checkoutId,
            emulatorId: liveEmulatorId,
          },
    [authority, liveEmulatorId, props.checkoutId, props.thread.id],
  );
  const liveScreen = useAndroidEmulatorLiveScreen({
    client: props.client,
    enabled: liveEmulatorId !== undefined,
    ...(screenStreamRequest === undefined ? {} : { request: screenStreamRequest }),
  });

  const run = useCallback(
    async (intent: AndroidEmulatorIntent) => {
      const previous = inputFlight.current;
      let release = () => {};
      inputFlight.current = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      setActionMessage(undefined);
      setBusy(true);
      try {
        const base = androidActionRequest({
          intent,
          actionId: props.createUuid(),
          correlationId: props.createUuid(),
          authority,
          threadId: props.thread.id,
          checkoutId: props.checkoutId,
        });
        let request = base;
        const emulatorId = String(intent.emulatorId);
        const now = Date.now();
        const remembered = rememberedInputGrants.current.get(emulatorId) ?? 0;
        const grantLive =
          androidInputGrantIsLive(controller.runtime, emulatorId, now) || remembered > now;
        if (approvalGated && isAndroidEmulatorInputKind(intent.kind) && !grantLive) {
          setActionMessage("Allow input to this emulator first.");
          return;
        }
        if (approvalGated && isAndroidEmulatorOpenInputKind(intent.kind) && grantLive) {
          return;
        }
        if (
          approvalGated &&
          intent.kind !== "screenshot" &&
          !(isAndroidEmulatorInputKind(intent.kind) && grantLive)
        ) {
          if (props.requestApproval === undefined) {
            setActionMessage(
              "This window cannot confirm Android actions. Approve from the desktop app.",
            );
            return;
          }
          const approvalId = await props.requestApproval(base);
          if (approvalId === undefined) {
            setActionMessage("The Android action was not approved, so nothing ran.");
            return;
          }
          request = { ...base, approval: { kind: "approved", approvalId: approvalId as never } };
          if (isAndroidEmulatorOpenInputKind(intent.kind)) {
            rememberedInputGrants.current.set(emulatorId, Date.now() + ANDROID_INPUT_GRANT_MS);
            setRememberedGrantEpoch(Date.now());
          }
        }
        const evidence = await controller.execute(request);
        if (evidence.outcome === "succeeded" && isAndroidEmulatorOpenInputKind(intent.kind)) {
          rememberedInputGrants.current.set(emulatorId, Date.now() + ANDROID_INPUT_GRANT_MS);
          setRememberedGrantEpoch(Date.now());
        }
        if (evidence.outcome === "succeeded" && intent.kind === "shutdown") {
          rememberedInputGrants.current.delete(emulatorId);
          setRememberedGrantEpoch(Date.now());
        }
        if (evidence.outcome !== "succeeded") {
          setActionMessage(`Android ${intent.kind} ${evidence.outcome.replace("-", " ")}.`);
        }
      } catch {
        setActionMessage("The Android toolchain service did not answer this action.");
      } finally {
        setBusy(false);
        release();
      }
    },
    [
      approvalGated,
      authority,
      controller,
      props.checkoutId,
      props.createUuid,
      props.requestApproval,
      props.thread.id,
    ],
  );

  if (controller.status !== "ready") {
    return (
      <ShellState
        eyebrow="Android emulator"
        message={
          controller.errorMessage ??
          (controller.status === "unavailable"
            ? "Install the Android SDK (platform-tools and an emulator) on this host, then retry."
            : "Discovering Android emulators for this Code thread.")
        }
        state={controller.status === "unavailable" ? "empty" : "loading"}
        title={
          controller.status === "unavailable" ? "Android emulator is unavailable" : "Android emulator"
        }
      />
    );
  }

  const offerInput = frameAttach && inputAllowed && liveEmulatorId !== undefined && props.requestApproval !== undefined
    ? true
    : frameAttach && inputAllowed && liveEmulatorId !== undefined && !approvalGated;

  return (
    <section aria-label="Android emulator" className="apple-workbench apple-workbench--device">
      <LiveDevice
        busy={busy}
        liveScreen={liveScreen}
        name={liveEmulator?.name ?? "Android emulator"}
        offerInput={offerInput === true}
        onInput={
          liveEmulatorId === undefined
            ? undefined
            : (intent) => {
                if (intent.kind === "tap") {
                  void run({ kind: "tap", emulatorId: liveEmulatorId, point: intent.point });
                  return;
                }
                if (intent.kind === "swipe") {
                  void run({
                    kind: "swipe",
                    emulatorId: liveEmulatorId,
                    point: intent.from,
                    toPoint: intent.to,
                    durationMs: intent.durationMs,
                  });
                  return;
                }
                if (intent.kind === "type-text") {
                  void run({ kind: "type-text", emulatorId: liveEmulatorId, text: intent.text });
                  return;
                }
                void run({ kind: "key-press", emulatorId: liveEmulatorId, key: intent.key });
              }
        }
        status={
          liveEmulator?.state === "booting"
            ? "booting"
            : liveEmulator?.state === "booted"
              ? "live"
              : "idle"
        }
      />
      {needsAllowInput && liveEmulator?.state === "booted" ? (
        <p className="apple-workbench__action-message" role="status">
          Allow input to drive this emulator. Clicks do not ask again after that.
        </p>
      ) : null}
      {actionMessage === undefined ? null : (
        <p className="apple-workbench__action-message" role="alert">
          {actionMessage}
        </p>
      )}
      <DeviceRail
        busy={busy}
        emulators={emulators}
        needsAllowInput={needsAllowInput}
        onRun={(intent) => void run(intent)}
      />
    </section>
  );
}

function LiveDevice(props: {
  readonly status: "idle" | "booting" | "live";
  readonly name: string;
  readonly liveScreen: AndroidEmulatorLiveScreen;
  readonly offerInput: boolean;
  readonly busy: boolean;
  readonly onInput?: (intent: AndroidFrameInputIntent) => void;
}) {
  const enqueue = useOrderedAndroidInput({
    owner: props.status === "live" ? props.name : "",
    busy: props.busy,
    ...(props.onInput === undefined ? {} : { onInput: props.onInput }),
  });
  const streamed = props.liveScreen.status === "live" ? props.liveScreen : undefined;
  return (
    <figure
      aria-label="Android emulator live frame"
      className={`apple-simulator-frame apple-simulator-frame--${props.status === "live" ? "live" : "unavailable"} apple-simulator-frame--device`}
      data-status={props.status === "live" ? "live" : props.status}
    >
      <figcaption>
        {props.status === "live"
          ? `Live · ${props.name}`
          : props.status === "booting"
            ? `Waiting for ${props.name} to become ready.`
            : "Boot an Android emulator to open a live frame."}
      </figcaption>
      {streamed === undefined ? (
        <p>
          {props.liveScreen.status === "connecting"
            ? "Connecting to the emulator screen."
            : props.liveScreen.status === "unavailable"
              ? props.liveScreen.message
              : props.status === "live"
                ? "The destination is live. Capture the screen if the live view is unavailable."
                : "Boot an emulator for this Code thread to open a live frame."}
        </p>
      ) : (
        <StreamedScreen
          active={props.offerInput}
          attach={streamed.attach}
          enqueue={enqueue}
          name={props.name}
          screen={streamed.screen}
        />
      )}
      <div className="apple-simulator-frame__keys" role="group" aria-label="Emulator input">
        <OctantButton
          disabled={!props.offerInput}
          onClick={() => enqueue({ kind: "key-press", key: "home" }, false)}
          type="button"
          variant="secondary"
        >
          Home
        </OctantButton>
        <OctantButton
          disabled={!props.offerInput}
          onClick={() => enqueue({ kind: "key-press", key: "back" }, false)}
          type="button"
          variant="secondary"
        >
          Back
        </OctantButton>
        <OctantButton
          disabled={!props.offerInput}
          onClick={() => enqueue({ kind: "key-press", key: "lock" }, false)}
          type="button"
          variant="secondary"
        >
          Lock
        </OctantButton>
      </div>
    </figure>
  );
}

function StreamedScreen(props: {
  readonly name: string;
  readonly screen: { readonly width: number; readonly height: number };
  readonly attach: (canvas: HTMLCanvasElement | null) => void;
  readonly active: boolean;
  readonly enqueue: (intent: AndroidFrameInputIntent, typing: boolean) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pressRef = useRef<(PointerSample & { readonly pointerId: number }) | undefined>(undefined);
  const { active, attach, enqueue } = props;
  return (
    /* ui-boundary-exception: specialized-editor-surface */
    <button
      aria-label={active ? `Tap on ${props.name} emulator screen` : `${props.name} emulator screen`}
      className="apple-simulator-frame__screen"
      disabled={!active}
      onKeyDown={(event) => {
        if (!active) return;
        const intent = keyIntentFor(event);
        if (intent === undefined) return;
        event.preventDefault();
        if (intent.kind === "text") enqueue({ kind: "type-text", text: intent.text }, true);
        else enqueue({ kind: "key-press", key: intent.key }, false);
      }}
      onPointerCancel={(event) => {
        if (pressRef.current?.pointerId === event.pointerId) pressRef.current = undefined;
      }}
      onPointerDown={(event) => {
        if (!active) return;
        if (event.button !== 0 || !event.isPrimary) return;
        pressRef.current = {
          x: event.clientX,
          y: event.clientY,
          atMs: event.timeStamp,
          pointerId: event.pointerId,
        };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerUp={(event) => {
        const down = pressRef.current;
        if (down === undefined || down.pointerId !== event.pointerId) return;
        pressRef.current = undefined;
        const canvas = canvasRef.current;
        if (!active || canvas === null) return;
        const gesture = gestureFrom(
          down,
          { x: event.clientX, y: event.clientY, atMs: event.timeStamp },
          canvas.getBoundingClientRect(),
          props.screen,
        );
        if (gesture !== undefined) enqueue(gesture, false);
      }}
      type="button"
    >
      <canvas
        aria-label={`${props.name} live screen`}
        ref={(canvas) => {
          canvasRef.current = canvas;
          attach(canvas);
        }}
        role="img"
      />
    </button>
  );
}

function DeviceRail(props: {
  readonly busy: boolean;
  readonly emulators: ReadonlyArray<AndroidEmulatorRecord>;
  readonly needsAllowInput: boolean;
  readonly onRun: (intent: AndroidEmulatorIntent) => void;
}) {
  if (props.emulators.length === 0) {
    return (
      <p className="apple-workbench__action-message" role="status">
        No Android Virtual Devices were found. Create an AVD in the Android SDK, then retry.
      </p>
    );
  }
  return (
    <ul className="apple-workbench__destinations">
      {props.emulators.map((emulator) => (
        <li key={String(emulator.emulatorId)}>
          <strong>{emulator.name}</strong>
          <span> · {emulator.state}</span>
          <span className="apple-workbench__actions">
            {emulator.state === "booted" ? (
              <>
                {props.needsAllowInput ? (
                  <OctantButton
                    aria-label={`Allow input to ${emulator.name}`}
                    disabled={props.busy}
                    onClick={() =>
                      props.onRun({ kind: "open-input", emulatorId: emulator.emulatorId })
                    }
                    type="button"
                  >
                    Allow input
                  </OctantButton>
                ) : null}
                <OctantButton
                  aria-label={`Capture the ${emulator.name} screen`}
                  disabled={props.busy}
                  onClick={() =>
                    props.onRun({ kind: "screenshot", emulatorId: emulator.emulatorId })
                  }
                  type="button"
                  variant="secondary"
                >
                  Capture screen
                </OctantButton>
                <OctantButton
                  aria-label={`Shut down ${emulator.name}`}
                  disabled={props.busy}
                  onClick={() =>
                    props.onRun({ kind: "shutdown", emulatorId: emulator.emulatorId })
                  }
                  type="button"
                  variant="destructive"
                >
                  Shut down
                </OctantButton>
              </>
            ) : (
              <OctantButton
                aria-label={`Boot ${emulator.name}`}
                disabled={props.busy || emulator.state !== "shutdown"}
                onClick={() => props.onRun({ kind: "boot", emulatorId: emulator.emulatorId })}
                type="button"
                variant="secondary"
              >
                Boot
              </OctantButton>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

type AndroidFrameInputIntent =
  | { readonly kind: "tap"; readonly point: { readonly x: number; readonly y: number } }
  | {
      readonly kind: "swipe";
      readonly from: { readonly x: number; readonly y: number };
      readonly to: { readonly x: number; readonly y: number };
      readonly durationMs: number;
    }
  | { readonly kind: "type-text"; readonly text: string }
  | { readonly kind: "key-press"; readonly key: string };

const TYPING_PAUSE_MS = 350;
const LONGEST_TYPED_TEXT = 4_096;
const UNANSWERED_INPUT_MS = 1_000;

function useOrderedAndroidInput(options: {
  readonly owner: string;
  readonly busy: boolean;
  readonly onInput?: (intent: AndroidFrameInputIntent) => void;
}) {
  const { busy, onInput, owner } = options;
  const waitingRef = useRef<AndroidFrameInputIntent[]>([]);
  const sentRef = useRef(false);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const unansweredRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const typingRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const sendNext = useCallback(() => {
    if (onInput === undefined || busy || sentRef.current) return;
    const next = waitingRef.current.shift();
    if (next === undefined) return;
    sentRef.current = true;
    if (unansweredRef.current !== undefined) clearTimeout(unansweredRef.current);
    unansweredRef.current = setTimeout(() => {
      unansweredRef.current = undefined;
      if (busyRef.current) return;
      sentRef.current = false;
      sendNextRef.current();
    }, UNANSWERED_INPUT_MS);
    onInput(next);
  }, [busy, onInput]);
  const sendNextRef = useRef(sendNext);
  sendNextRef.current = sendNext;

  useEffect(() => {
    if (busy) return;
    sentRef.current = false;
    if (typingRef.current === undefined) sendNext();
  }, [busy, sendNext]);

  useEffect(
    () => () => {
      if (typingRef.current !== undefined) clearTimeout(typingRef.current);
      if (unansweredRef.current !== undefined) clearTimeout(unansweredRef.current);
      typingRef.current = undefined;
      unansweredRef.current = undefined;
      waitingRef.current = [];
      sentRef.current = false;
    },
    [owner],
  );

  return (intent: AndroidFrameInputIntent, typing: boolean) => {
    const waiting = waitingRef.current;
    const last = waiting.at(-1);
    if (
      intent.kind === "type-text" &&
      last?.kind === "type-text" &&
      typingRef.current !== undefined &&
      last.text.length + intent.text.length <= LONGEST_TYPED_TEXT
    ) {
      waiting[waiting.length - 1] = { kind: "type-text", text: last.text + intent.text };
    } else {
      waiting.push(intent);
    }
    if (typingRef.current !== undefined) clearTimeout(typingRef.current);
    typingRef.current = undefined;
    if (typing) {
      typingRef.current = setTimeout(() => {
        typingRef.current = undefined;
        sendNextRef.current();
      }, TYPING_PAUSE_MS);
      return;
    }
    sendNext();
  };
}

function androidActionRequest(input: {
  readonly intent: AndroidEmulatorIntent;
  readonly actionId: string;
  readonly correlationId: string;
  readonly authority: AndroidEmulatorRequest["authority"];
  readonly threadId: AndroidEmulatorRequest["threadId"];
  readonly checkoutId: AndroidEmulatorRequest["checkoutId"];
}): AndroidEmulatorRequest {
  const intent = input.intent;
  const base = {
    actionId: input.actionId as never,
    correlationId: input.correlationId as never,
    authority: input.authority,
    threadId: input.threadId,
    checkoutId: input.checkoutId,
    emulatorId: intent.emulatorId,
    approval: { kind: "not-required" as const },
  };
  switch (intent.kind) {
    case "boot":
      return { ...base, kind: "boot", timeoutMs: 180_000 };
    case "shutdown":
      return { ...base, kind: "shutdown", timeoutMs: 30_000 };
    case "screenshot":
      return { ...base, kind: "screenshot", timeoutMs: 30_000 };
    case "open-input":
      return {
        ...base,
        kind: "open-input",
        requestedBy: localUserActor(),
        timeoutMs: 30_000,
      };
    case "tap":
      return {
        ...base,
        kind: "tap",
        requestedBy: localUserActor(),
        point: intent.point,
        timeoutMs: 30_000,
      };
    case "swipe":
      return {
        ...base,
        kind: "swipe",
        requestedBy: localUserActor(),
        point: intent.point,
        toPoint: intent.toPoint,
        durationMs: intent.durationMs,
        timeoutMs: 30_000,
      };
    case "type-text":
      return {
        ...base,
        kind: "type-text",
        requestedBy: localUserActor(),
        text: intent.text,
        timeoutMs: 30_000,
      };
    case "key-press":
      return {
        ...base,
        kind: "key-press",
        requestedBy: localUserActor(),
        key: intent.key,
        timeoutMs: 30_000,
      };
  }
}

function localUserActor(): { readonly kind: "local-user"; readonly actorId: never } {
  return {
    kind: "local-user",
    actorId: "00000000-0000-4000-8000-000000000002" as never,
  };
}
