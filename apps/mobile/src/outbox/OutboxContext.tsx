import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState } from "react-native";
import { queueMobileMessage } from "@octant/client-runtime";
import { MOBILE_COPY } from "../copy";
import { createExpoSecureStringStorage } from "../hosts/expoSecureStorage";
import { useMobileThreads } from "../inbox/MobileThreadsContext";
import { useMobileSession } from "../session/MobileSessionContext";
import {
  addWaiting,
  dropHostsNotIn,
  dueMessages,
  EMPTY_OUTBOX,
  markAttempted,
  markRefused,
  parseOutbox,
  removeWaiting,
  tryAgain,
  waitingFor,
  type Outbox,
  type WaitingMessage,
} from "./outbox";
import { outboxFile } from "./outboxFile";
import { createSealedText } from "./sealedText";

// A computer that is there but does not answer is asked again after this.
const ASK_AGAIN_MS = 15_000;

export interface OutboxApi {
  readonly waitingFor: (
    thread: Pick<WaitingMessage, "hostId" | "mode" | "threadId">,
  ) => ReadonlyArray<WaitingMessage>;
  /** Keeps a message for its computer; the reason where it cannot. */
  readonly keep: (message: WaitingMessage) => string | undefined;
  readonly remove: (id: string) => void;
  readonly tryAgain: (id: string) => void;
}

const Context = createContext<OutboxApi | undefined>(undefined);

export function useOutbox(): OutboxApi {
  const value = useContext(Context);
  if (value === undefined) throw new Error("Messages wait inside OutboxProvider.");
  return value;
}

/**
 * Messages that wait for their computer, sent when its session is ready and the
 * app is in front. This provider lives behind the app's lock, so a locked phone
 * sends nothing. The computer decides on each one when it arrives.
 */
export function OutboxProvider(props: { readonly children: ReactNode }) {
  const { environment, hosts, hostsLoaded, hostsError, health, transports } = useMobileSession();
  const { refresh } = useMobileThreads();
  const live = environment.kind === "live";
  const [outbox, setOutbox] = useState<Outbox>(EMPTY_OUTBOX);
  // Nothing is sent or written before what was kept is read.
  const [loaded, setLoaded] = useState(false);
  const sealed = useMemo(
    () =>
      createSealedText({
        crypto: globalThis.crypto,
        file: outboxFile(),
        storage: createExpoSecureStringStorage(),
      }),
    [],
  );
  useEffect(() => {
    if (!live) return;
    let gone = false;
    void sealed
      .load()
      .catch(() => null)
      .then((kept) => {
        if (gone) return;
        setOutbox((current) => ({
          messages: [...parseOutbox(kept).messages, ...current.messages],
        }));
        setLoaded(true);
      });
    return () => {
      gone = true;
    };
  }, [live, sealed]);
  useEffect(() => {
    if (!live || !loaded) return;
    void sealed
      .keep(outbox.messages.length === 0 ? undefined : JSON.stringify(outbox))
      .catch(() => undefined);
  }, [live, loaded, outbox, sealed]);
  useEffect(() => {
    // A list that could not be read is not a list without computers.
    if (!loaded || !hostsLoaded || hostsError !== undefined) return;
    setOutbox((current) => dropHostsNotIn(current, new Set(hosts.map((host) => host.hostId))));
  }, [hosts, hostsError, hostsLoaded, loaded]);

  const [turn, setTurn] = useState(0);
  const sending = useRef(false);
  useEffect(() => {
    if (!live || !loaded || sending.current || AppState.currentState !== "active") return;
    const ready = transports.filter(
      (transport) =>
        health.find((entry) => entry.hostId === transport.hostId)?.kind === "ready" &&
        hosts.some((host) => host.hostId === transport.hostId),
    );
    const now = new Date();
    const due = ready.flatMap((transport) => {
      const { send, tooOld } = dueMessages(outbox, transport.hostId, now);
      for (const message of tooOld)
        setOutbox((current) => markRefused(current, message.id, MOBILE_COPY.outboxTooOld));
      return send.map((message) => ({ transport, message }));
    });
    if (due.length === 0) return;
    sending.current = true;
    let again: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      let unreached = false;
      let sent = false;
      for (const { transport, message } of due) {
        const result = await queueMobileMessage({
          transport,
          scope: { mode: message.mode, threadId: message.threadId },
          messageId: message.id,
          prompt: message.text,
        }).catch(() => ({ status: "unreachable" }) as const);
        if (result.status === "queued") {
          sent = true;
          setOutbox((current) => removeWaiting(current, message.id));
        } else if (result.status === "refused") {
          setOutbox((current) => markRefused(current, message.id, result.message));
        } else {
          unreached = true;
          setOutbox((current) => markAttempted(current, message.id));
        }
      }
      sending.current = false;
      if (sent) void refresh();
      // What was sent may have had another behind it.
      if (unreached) again = setTimeout(() => setTurn((count) => count + 1), ASK_AGAIN_MS);
      else setTurn((count) => count + 1);
    })();
    return () => clearTimeout(again);
  }, [health, hosts, live, loaded, outbox, refresh, transports, turn]);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") setTurn((count) => count + 1);
    });
    return () => subscription.remove();
  }, []);

  const keep = useCallback(
    (message: WaitingMessage): string | undefined => {
      const result = addWaiting(outbox, message);
      if (result.status !== "added") return MOBILE_COPY.outboxRefusal[result.status];
      setOutbox((current) => addWaiting(current, message).outbox);
      return undefined;
    },
    [outbox],
  );
  const value = useMemo<OutboxApi>(
    () => ({
      waitingFor: (thread) => waitingFor(outbox, thread),
      keep,
      remove: (id) => setOutbox((current) => removeWaiting(current, id)),
      tryAgain: (id) => setOutbox((current) => tryAgain(current, id, new Date())),
    }),
    [keep, outbox],
  );
  return <Context.Provider value={value}>{props.children}</Context.Provider>;
}
