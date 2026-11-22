import type { ProviderDriver } from "@octant/provider-sdk/driver";
import { Effect } from "effect";
import type { ToolEffectLedger } from "./toolEffectLedger";

/**
 * Puts a runtime tool call's intent back on its turn's record before the
 * runtime hears the answer to the approval request that gated it. The answer
 * is sent from every mode's own approval path, a reviewer's included, and all
 * of them reach the runtime through the connection, so the record is kept
 * here once rather than at each of them. When the journal refuses the frame
 * the call is refused instead: allowed, it would run under a record that says
 * it was still waiting, and a restart would continue past it. A request the
 * ledger never journaled a wait for passes through: its call's record already
 * says it may take effect.
 */
export function withRecordedApprovalAnswers(
  driver: ProviderDriver,
  ledger: Pick<ToolEffectLedger, "approvalAnswered">,
): ProviderDriver {
  return {
    ...driver,
    acquire: (input) =>
      driver.acquire(input).pipe(
        Effect.map((connection) => ({
          ...connection,
          answerApproval: (answer) =>
            Effect.suspend(() =>
              connection.answerApproval(
                ledger.approvalAnswered({
                  sessionId: String(answer.sessionId),
                  requestId: answer.requestId,
                }).status !== "refused" || !answer.approved
                  ? answer
                  : { ...answer, approved: false },
              ),
            ),
        })),
      ),
  };
}
