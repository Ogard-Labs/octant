import { randomUUID } from "node:crypto";
import {
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeWorkThreadId,
  type OctantMode,
} from "@octant/contracts";
import { defaultShellSettings, enabledModes } from "@octant/domain";
import { Effect } from "effect";
import { ThreadNotificationDeliveryService } from "../remote/threadNotificationDeliveryService";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import type { ServerStart } from "./serverShape";
import type { AutomationWiring } from "./automation";
import type { ChatWiring } from "./chat";
import type { FoundationsWiring } from "./foundations";

export type ThreadNotificationDependencies = Pick<ServerStart, "persistence"> &
  Pick<
    AutomationWiring,
    "hasPushStanding" | "pushComputerLabel" | "pushDeliveryTransport" | "pushNotificationTokenStore"
  > &
  Pick<ChatWiring, "chatHiddenThreadIds"> &
  Pick<FoundationsWiring, "workThreadProjection">;

function decoded<A>(decode: (value: unknown) => A, value: string): A | undefined {
  try {
    return decode(value);
  } catch {
    return undefined;
  }
}

/**
 * Ordinary-thread notifications for paired phones. The service follows the
 * journal as it commits and shares the Automation path's registrations and
 * transport, so the Notifications setting and a device's standing govern both.
 */
export function wireThreadNotifications(deps: ThreadNotificationDependencies) {
  const {
    chatHiddenThreadIds,
    hasPushStanding,
    persistence,
    pushComputerLabel,
    pushDeliveryTransport,
    pushNotificationTokenStore,
    workThreadProjection,
  } = deps;
  return Effect.gen(function* () {
    // A thread a paired device could read: it still exists, is not being
    // deleted, is not a hidden lane, and its mode is on. Anything else names
    // nothing to the phone.
    const readThread = (
      threadId: string,
    ): { readonly mode: OctantMode; readonly title: string } | undefined => {
      const modes = enabledModes(
        persistence.readShellSettings()?.settings ?? defaultShellSettings(),
      );
      const chatId = decoded(decodeChatThreadId, threadId);
      const chat = chatId === undefined ? undefined : persistence.readChatThread(chatId);
      if (chat !== undefined) {
        if (!modes.includes("chat") || chatHiddenThreadIds().has(threadId)) return undefined;
        if (chat.lifecycle === "deleting" || chat.lifecycle === "deleted") return undefined;
        return { mode: "chat", title: chat.title };
      }
      const workId = decoded(decodeWorkThreadId, threadId);
      const work = workId === undefined ? undefined : workThreadProjection.read(workId);
      if (work !== undefined) {
        if (!modes.includes("work")) return undefined;
        if (work.lifecycle === "deleting" || work.lifecycle === "deleted") return undefined;
        return { mode: "work", title: work.title };
      }
      const codeId = decoded(decodeCodeThreadId, threadId);
      const code = codeId === undefined ? undefined : persistence.readCodeThread(codeId);
      if (code !== undefined && modes.includes("code")) return { mode: "code", title: code.title };
      return undefined;
    };
    const threadNotifications = new ThreadNotificationDeliveryService({
      journal: persistence.journal,
      registrations: pushNotificationTokenStore,
      transport: pushDeliveryTransport,
      hasStanding: hasPushStanding,
      readThread,
      computerLabel: pushComputerLabel,
      clock: () => new Date().toISOString(),
      uuid: randomUUID,
      hostActorId: OCTANT_LOCAL_ACTOR_ID,
      onError: (message) => console.error(`[thread-notifications] ${message}`),
    });
    const unsubscribe = persistence.journal.subscribeCommitted((append) =>
      threadNotifications.onCommittedAppend(append),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribe()));
  });
}
