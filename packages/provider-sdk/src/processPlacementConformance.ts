import { ProviderFailure, type ProviderRuntimeEvent } from "@octant/contracts";
import { Cause, Effect, Exit, Fiber, Option, Schema, Stream } from "effect";
import type {
  ProviderAcquireInput,
  ProviderDriver,
  ProviderRemoteProcessPlacement,
  ProviderSessionStart,
  ProviderTurnInput,
} from "./driver";
import { acquireProviderConnection } from "./processPlacement";

export interface ProviderRemotePlacementConformanceFixture {
  readonly driver: ProviderDriver;
  /**
   * A Code acquisition at the bound root as the target names it. The harness
   * supplies the placement.
   */
  readonly acquireInput: Omit<ProviderAcquireInput, "placement"> & { readonly mode: "code" };
  /**
   * The session to start; the harness starts it once in each posture the
   * driver declares. Unused for a driver that declares none.
   */
  readonly sessionStart: ProviderSessionStart;
  readonly turn: ProviderTurnInput;
  /** The stand-in target, which runs what the driver places on it. */
  readonly target: ProviderRemoteProcessPlacement;
  /** How many runtime processes the driver has started on this host so far. */
  readonly localLaunches: () => number;
  readonly isReleased: () => boolean;
}

export interface ProviderRemotePlacementConformanceEvidence {
  readonly claim: "supported" | "unsupported";
  /** A driver that declares none was refused before anything launched, here or there. */
  readonly refusedBeforeAnyLaunch: boolean;
  /** The turn completed with every runtime process started on the target. */
  readonly ranOnTarget: boolean;
  /** A target that refused the launch failed the turn, and nothing ran on this host instead. */
  readonly refusedWithoutLocalFallback: boolean;
  /** Every process the driver placed was stopped with the scope it was started in. */
  readonly placedProcessesStopped: boolean;
}

/** How long a turn on a refusing target may take to fail before the harness calls it stuck. */
const REFUSED_TURN_DEADLINE = "5 seconds";

const isProviderFailure = Schema.is(ProviderFailure);

/**
 * Holds a driver to its remote placement claim. A driver that declares none
 * must be refused `unsupported` before it, the target, or this host launches
 * anything. A driver that declares it must, in every posture it declares, run
 * a turn whose runtime starts only through the placement, at an absolute
 * path; must fail, not fall back to this host, when the target refuses the
 * launch; and must stop every process it placed when its scope closes.
 */
export async function runRemotePlacementConformance(
  fixture: ProviderRemotePlacementConformanceFixture,
): Promise<ProviderRemotePlacementConformanceEvidence> {
  const support = fixture.driver.remotePlacement;
  if (support === undefined) {
    const placed = countingPlacement(fixture.target);
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        acquireProviderConnection(fixture.driver, {
          ...fixture.acquireInput,
          placement: placed.placement,
        }),
      ),
    );
    assert(
      failureOf(exit)?.category === "unsupported",
      "a driver that declares no remote placement was not refused as unsupported",
    );
    assertNothingLaunched(fixture, placed.launches());
    return {
      claim: "unsupported",
      refusedBeforeAnyLaunch: true,
      ranOnTarget: false,
      refusedWithoutLocalFallback: false,
      placedProcessesStopped: true,
    };
  }

  assert(support.postures.length > 0, "remote placement is declared in no posture");
  assert(
    new Set(support.postures).size === support.postures.length,
    "remote placement names a posture twice",
  );
  // Admission places the runtime in every posture the driver declares, so the
  // claim is held in each one: a driver could place in one and run here in another.
  for (const posture of support.postures) {
    await holdsPlacementInPosture(fixture, { ...fixture.sessionStart, executionPolicy: posture });
  }

  return {
    claim: "supported",
    refusedBeforeAnyLaunch: false,
    ranOnTarget: true,
    refusedWithoutLocalFallback: true,
    placedProcessesStopped: true,
  };
}

/**
 * Runs a turn on the stand-in target and one on a target that refuses the
 * launch, in one declared posture.
 */
async function holdsPlacementInPosture(
  fixture: ProviderRemotePlacementConformanceFixture,
  sessionStart: ProviderSessionStart,
): Promise<void> {
  const placed = countingPlacement(fixture.target);
  const events = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* acquireProviderConnection(fixture.driver, {
          ...fixture.acquireInput,
          placement: placed.placement,
        });
        yield* connection.start(sessionStart);
        const subscription = yield* connection.subscribe;
        const collected = yield* Effect.fork(throughTerminal(subscription, sessionStart.sessionId));
        yield* connection.send(fixture.turn);
        const turnEvents = Array.from(yield* Fiber.join(collected));
        yield* connection.stop(sessionStart.sessionId);
        return turnEvents;
      }),
    ),
  );
  assert(fixture.isReleased(), "connection scope was not finalized");
  assert(events.at(-1)?.kind === "completed", "a turn on the target did not complete");
  assert(fixture.localLaunches() === 0, "the driver started its runtime on this host");
  assert(placed.launches() > 0, "the turn completed without starting anything on the target");
  assert(
    placed.executables().every((executable) => executable.startsWith("/")),
    "a placed launch named its runtime by a relative path",
  );
  assert(placed.open() === 0, "a process placed on the target outlived its scope");

  const refusing: ProviderRemoteProcessPlacement = {
    kind: "remote",
    launch: () =>
      Effect.fail({ category: "unavailable", message: "The target refused the launch." }),
  };
  const refusedExit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* acquireProviderConnection(fixture.driver, {
          ...fixture.acquireInput,
          placement: refusing,
        });
        yield* connection.start(sessionStart);
        const subscription = yield* connection.subscribe;
        const collected = yield* Effect.fork(throughTerminal(subscription, sessionStart.sessionId));
        yield* connection.send(fixture.turn);
        return Array.from(yield* Fiber.join(collected));
      }).pipe(Effect.timeout(REFUSED_TURN_DEADLINE)),
    ),
  );
  assert(
    fixture.localLaunches() === 0,
    "the driver ran its runtime on this host when the target refused",
  );
  if (Exit.isSuccess(refusedExit)) {
    assert(
      refusedExit.value.at(-1)?.kind === "failed",
      "a turn on a target that refused the launch did not fail",
    );
  } else {
    assert(
      failureOf(refusedExit) !== undefined,
      "a target that refused the launch left the turn waiting, or failed it untyped",
    );
  }
}

/** The placement the driver sees, counting launches and the ones still open. */
function countingPlacement(target: ProviderRemoteProcessPlacement) {
  let launches = 0;
  let open = 0;
  const executables: string[] = [];
  const placement: ProviderRemoteProcessPlacement = {
    kind: "remote",
    launch: (launch) =>
      Effect.acquireRelease(
        target.launch(launch).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              launches += 1;
              open += 1;
              executables.push(launch.executable);
            }),
          ),
        ),
        () =>
          Effect.sync(() => {
            open -= 1;
          }),
      ),
  };
  return {
    placement,
    launches: () => launches,
    open: () => open,
    executables: (): ReadonlyArray<string> => executables,
  };
}

function assertNothingLaunched(
  fixture: ProviderRemotePlacementConformanceFixture,
  placedLaunches: number,
): void {
  assert(placedLaunches === 0, "a refused driver placed a process on the target");
  assert(fixture.localLaunches() === 0, "a refused driver started its runtime on this host");
}

function throughTerminal(
  events: Stream.Stream<ProviderRuntimeEvent, ProviderFailure>,
  sessionId: ProviderRuntimeEvent["sessionId"],
) {
  return Stream.runCollect(
    events.pipe(
      Stream.filter((event) => event.sessionId === sessionId),
      Stream.takeUntil(
        (event) =>
          event.kind === "completed" || event.kind === "interrupted" || event.kind === "failed",
      ),
    ),
  );
}

/** The typed provider failure an exit carries, if it carries one. */
function failureOf<A, E>(exit: Exit.Exit<A, E>): ProviderFailure | undefined {
  if (Exit.isSuccess(exit)) return undefined;
  const failure = Option.getOrUndefined(Cause.failureOption(exit.cause));
  return isProviderFailure(failure) ? failure : undefined;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Remote placement conformance failed: ${message}`);
}
