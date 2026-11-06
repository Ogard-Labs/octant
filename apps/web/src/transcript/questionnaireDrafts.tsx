import type { Questionnaire, QuestionnaireResponse } from "@octant/contracts";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export interface QuestionnaireDraftIdentity {
  readonly scope: string;
  readonly requestId: string;
}

interface QuestionnaireDraft {
  readonly answers: QuestionnaireResponse["answers"];
  readonly customIds: ReadonlyArray<string>;
  readonly comment: string;
}

interface StoredDraft {
  readonly definition: string;
  readonly draft: QuestionnaireDraft;
}

function createQuestionnaireDrafts() {
  const scopes = new Map<string, Map<string, StoredDraft>>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    read: (identity: QuestionnaireDraftIdentity) =>
      scopes.get(identity.scope)?.get(identity.requestId),
    write: (identity: QuestionnaireDraftIdentity, value: StoredDraft | undefined) => {
      const requests = scopes.get(identity.scope) ?? new Map<string, StoredDraft>();
      if (value === undefined) {
        if (!requests.delete(identity.requestId)) return;
        if (requests.size === 0) scopes.delete(identity.scope);
      } else {
        requests.set(identity.requestId, value);
        scopes.set(identity.scope, requests);
      }
      notify();
    },
    retain: (scope: string, requestIds: ReadonlyArray<string>) => {
      const requests = scopes.get(scope);
      if (requests === undefined) return;
      let changed = false;
      for (const requestId of requests.keys()) {
        if (!requestIds.includes(requestId)) changed = requests.delete(requestId) || changed;
      }
      if (requests.size === 0) scopes.delete(scope);
      if (changed) notify();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const QuestionnaireDraftsContext = createContext<
  ReturnType<typeof createQuestionnaireDrafts> | undefined
>(undefined);

/** Navigation may unmount a question; its unsent answers belong to this window, not shared storage. */
export function QuestionnaireDraftsProvider(props: {
  readonly serverUrl: string;
  readonly windowId: string;
  readonly children: ReactNode;
}) {
  const drafts = useMemo(createQuestionnaireDrafts, [props.serverUrl, props.windowId]);
  return (
    <QuestionnaireDraftsContext.Provider value={drafts}>
      {props.children}
    </QuestionnaireDraftsContext.Provider>
  );
}

/** Only an authoritative loaded view may discard requests; a failed read supplies no new view. */
export function useRetainQuestionnaireDrafts(
  scope: string,
  requestIds: ReadonlyArray<string> | undefined,
) {
  const drafts = useContext(QuestionnaireDraftsContext);
  useEffect(() => {
    if (requestIds !== undefined) drafts?.retain(scope, requestIds);
  }, [drafts, scope, requestIds]);
}

const noSubscribe = () => () => {};

export function useQuestionnaireDraft(
  identity: QuestionnaireDraftIdentity | undefined,
  prompt: string,
  questionnaire: Questionnaire,
) {
  const drafts = useContext(QuestionnaireDraftsContext);
  const definition = JSON.stringify([prompt, questionnaire]);
  const [local, setLocal] = useState<QuestionnaireDraft>(() => ({
    answers: questionnaire.questions.map((question) => ({
      questionId: question.id,
      selectedOptionIds: [],
    })),
    customIds: [],
    comment: "",
  }));
  const stored = useSyncExternalStore(
    drafts?.subscribe ?? noSubscribe,
    () => (identity === undefined ? undefined : drafts?.read(identity)),
    () => undefined,
  );
  useEffect(() => {
    if (
      identity !== undefined &&
      stored !== undefined &&
      stored.definition !== definition &&
      drafts?.read(identity) === stored
    )
      drafts?.write(identity, undefined);
  }, [drafts, identity, stored, definition]);
  const current = stored?.definition === definition ? stored.draft : local;
  const setDraft = (update: (draft: QuestionnaireDraft) => QuestionnaireDraft) => {
    if (identity !== undefined && drafts !== undefined) {
      const latest = drafts.read(identity);
      drafts.write(identity, {
        definition,
        draft: update(latest?.definition === definition ? latest.draft : local),
      });
    } else setLocal(update);
  };
  const clear = () => {
    if (identity !== undefined && drafts?.read(identity)?.definition === definition)
      drafts.write(identity, undefined);
  };
  return { ...current, setDraft, clear };
}
