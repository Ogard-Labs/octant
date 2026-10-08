/**
 * The platform-neutral picture of one device pane. The iOS Simulator and the
 * Android emulator panes translate what their hosts report into this, and
 * `DevicePane` draws it. Nothing here grants, approves, or runs anything: the
 * pane hands every request back through `onAction` or `onInput`, and the
 * surface that owns the device decides.
 */

export type DevicePlatform = "ios" | "android";

export type DeviceRunState = "shutdown" | "booting" | "booted" | "shutting-down" | "unavailable";

export interface DeviceChoice {
  readonly id: string;
  readonly name: string;
  /** "iOS 27.0", "Android 16". Absent when the host does not report one. */
  readonly os?: string;
  readonly state: DeviceRunState;
}

export interface DeviceSetupCheck {
  readonly id: string;
  readonly label: string;
  readonly state: "ok" | "missing" | "waiting";
  readonly detail?: string;
  /** The one thing to do about a missing row. */
  readonly fix?: string;
}

/** What the screen shows while a device is running. */
export type DeviceScreenSource =
  | {
      readonly kind: "stream";
      readonly size: { readonly width: number; readonly height: number };
      readonly attach: (canvas: HTMLCanvasElement | null) => void;
    }
  | { readonly kind: "still"; readonly url: string }
  | { readonly kind: "connecting" }
  | { readonly kind: "none" };

export type DeviceView =
  | { readonly kind: "checking" }
  | {
      readonly kind: "setup";
      readonly title: string;
      readonly checks: ReadonlyArray<DeviceSetupCheck>;
      /** One sentence when discovery stopped for a reason the rows cannot show. */
      readonly note?: string;
    }
  | { readonly kind: "pick" }
  | { readonly kind: "booting"; readonly device: DeviceChoice }
  | { readonly kind: "shutting-down"; readonly device: DeviceChoice }
  | {
      readonly kind: "live";
      readonly device: DeviceChoice;
      readonly screen: DeviceScreenSource;
      /** Why there is no streamed picture, when there is not. */
      readonly liveView: "streaming" | "connecting" | "lost" | "stopped" | "not-offered";
    }
  | {
      readonly kind: "last-screen";
      readonly device?: DeviceChoice;
      readonly still?: string;
      readonly reason: "restart" | "interrupted";
    }
  | { readonly kind: "unavailable"; readonly device?: DeviceChoice; readonly message: string };

/** A request the pane hands back. Home, Lock, Back, taps, and typing go through `onInput`. */
export type DeviceAction =
  | { readonly kind: "allow-input" }
  | { readonly kind: "screenshot" }
  | { readonly kind: "shutdown" }
  | { readonly kind: "boot"; readonly deviceId: string }
  | { readonly kind: "select"; readonly deviceId: string }
  | { readonly kind: "check-again" }
  | { readonly kind: "reconnect" }
  | { readonly kind: "stop-live-view" };

/** One sentence and at most one way to fix it. */
export interface DeviceProblem {
  readonly message: string;
  readonly fix?: { readonly label: string; readonly run: () => void };
}

export interface DeviceDiagnostics {
  readonly facts: ReadonlyArray<{ readonly label: string; readonly value: string }>;
  readonly running: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly step: string;
    readonly onCancel?: () => void;
  }>;
  readonly recent: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly outcome: string;
    readonly detail?: string;
  }>;
}

/**
 * Why the last request a device pane made did not do what was asked. The
 * surface that runs requests records this instead of a sentence, so the full
 * workbench and the device pane can each say it their own way.
 */
export type DeviceActionFailure<Intent extends { readonly kind: string }> =
  | { readonly kind: "outcome"; readonly intent: Intent; readonly outcome: string }
  /**
   * The host refused with a reason it names. A reason with its own sentence
   * and fix (a disconnected input that can be repaired, say) is added to
   * `REFUSALS`; any other reason reads as a plain refusal.
   */
  | { readonly kind: "refused"; readonly intent: Intent; readonly reason: string }
  | { readonly kind: "input-not-allowed" }
  | { readonly kind: "cannot-confirm" }
  | { readonly kind: "not-approved"; readonly intent: Intent }
  | { readonly kind: "no-answer"; readonly intent: Intent }
  | { readonly kind: "cancel-finished" }
  | { readonly kind: "cancel-no-answer" };

const INPUT_KINDS = new Set(["tap", "swipe", "type-text", "key-press"]);

/**
 * Refusal reasons the device pane can say more about. Each is one sentence
 * and names the one fix the pane offers for it; the host still decides
 * whether that fix is allowed.
 */
const REFUSALS: Readonly<
  Record<
    string,
    { readonly sentence: (name: string) => string; readonly fix: "try-again" | "allow-input" }
  >
> = {
  unauthorized: {
    sentence: (name) => `Input on ${name} isn't allowed right now.`,
    fix: "allow-input",
  },
};

/**
 * The workbench's sentence for a failure. These are the words the workbench
 * has always shown, kept so its readers and tests see no change.
 */
export function deviceFailureSentence(
  failure: DeviceActionFailure<{ readonly kind: string }>,
  platform: DevicePlatform,
): string {
  const word = platform === "ios" ? "Apple" : "Android";
  const noun = platform === "ios" ? "Simulator" : "emulator";
  switch (failure.kind) {
    case "outcome":
      return `${word} ${failure.intent.kind} ${failure.outcome.replaceAll("-", " ")}.`;
    case "refused":
      return `${word} ${failure.intent.kind} was refused: ${failure.reason}.`;
    case "input-not-allowed":
      return `Allow input to this ${noun} first.`;
    case "cannot-confirm":
      return `This window cannot confirm ${word} actions. Approve from the desktop app.`;
    case "not-approved":
      return `The ${word} action was not approved, so nothing ran.`;
    case "no-answer":
      return `The ${word} toolchain service did not answer this action.`;
    case "cancel-finished":
      return `That ${word} action was already finished.`;
    case "cancel-no-answer":
      return `The ${word} toolchain service did not answer the cancellation.`;
  }
}

/**
 * The device pane's line for a failure: one sentence a person can act on,
 * with the one fix that would help. The raw outcome goes to Diagnostics.
 */
export function deviceProblemFor<Intent extends { readonly kind: string }>(
  failure: DeviceActionFailure<Intent>,
  context: {
    readonly platform: DevicePlatform;
    readonly deviceName: string;
    readonly retry?: (intent: Intent) => void;
    readonly allowInput?: () => void;
  },
): DeviceProblem {
  const name = context.deviceName;
  const service = context.platform === "ios" ? "Apple" : "Android";
  const tryAgain = (intent: Intent) =>
    context.retry === undefined
      ? {}
      : { fix: { label: "Try again", run: () => context.retry?.(intent) } };
  const allow =
    context.allowInput === undefined
      ? {}
      : { fix: { label: "Allow input", run: context.allowInput } };
  switch (failure.kind) {
    case "outcome": {
      const { intent, outcome } = failure;
      if (outcome === "cancelled") return { message: "That action was cancelled." };
      if (INPUT_KINDS.has(intent.kind)) {
        return outcome === "unauthorized"
          ? { message: `Input on ${name} isn't allowed right now.`, ...allow }
          : { message: `Input didn't reach ${name}.`, ...tryAgain(intent) };
      }
      const late = outcome === "timed-out" ? " in time" : "";
      const sentences: Record<string, string> = {
        boot: `${name} didn't finish booting${late}.`,
        shutdown: `${name} didn't shut down${late}.`,
        screenshot: `The screenshot of ${name} wasn't saved.`,
        "open-input": `Input on ${name} couldn't be turned on.`,
        run: `The app didn't launch on ${name}.`,
      };
      return {
        message: sentences[intent.kind] ?? `That action on ${name} didn't finish.`,
        ...tryAgain(intent),
      };
    }
    case "refused": {
      const known = REFUSALS[failure.reason];
      if (known === undefined) {
        return { message: `${name} refused that action.`, ...tryAgain(failure.intent) };
      }
      return {
        message: known.sentence(name),
        ...(known.fix === "allow-input" ? allow : tryAgain(failure.intent)),
      };
    }
    case "input-not-allowed":
      return { message: `Allow input on ${name} first.`, ...allow };
    case "cannot-confirm":
      return { message: "This window can't approve device actions; use the desktop app." };
    case "not-approved":
      return { message: "Nothing ran, because it wasn't approved.", ...tryAgain(failure.intent) };
    case "no-answer":
      return {
        message: `Octant's ${service} toolchain service didn't answer.`,
        ...tryAgain(failure.intent),
      };
    case "cancel-finished":
      return { message: "That action had already finished." };
    case "cancel-no-answer":
      return { message: `Octant's ${service} toolchain service didn't answer the cancel.` };
  }
}

/** The raw words for Diagnostics, where the reason behind a line is kept. */
export function deviceFailureDetail(
  failure: DeviceActionFailure<{ readonly kind: string }>,
): string {
  switch (failure.kind) {
    case "outcome":
      return `${failure.intent.kind}: ${failure.outcome}`;
    case "not-approved":
      return `${failure.intent.kind}: not approved`;
    case "refused":
      return `${failure.intent.kind}: refused (${failure.reason})`;
    case "no-answer":
      return `${failure.intent.kind}: no answer from the service`;
    default:
      return failure.kind;
  }
}

/** "preparing-destination" → "Preparing destination", for Diagnostics rows. */
export function deviceWord(value: string): string {
  const words = value.split("-").join(" ");
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}
