// Asks the user before an agent uses a persistent browser profile, which carries their sign-ins.
// The card is shown from /mcp and answered over WebSocket; one instance serializes both.
import {
  type AgentBrowserProfileGrant,
  agentBrowserProfileGrantKey,
  BrowserProfileRequestError,
  type BrowserProfileRequestAnswerInput,
  CommandId,
  isAgentBrowserProfileGranted,
  type OrchestrationV2BrowserProfileRequestStatus,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";

const CARD_PREFIX = "turn-item:browser-profile-request:";
const REQUEST_TIMEOUT = Duration.minutes(10);
const POLL_INTERVAL = Duration.millis(500);

type RequestItem = Extract<OrchestrationV2TurnItem, { readonly type: "browser_profile_request" }>;
export type BrowserProfileRequestOutcome = "approved" | "declined" | "cancelled" | "timed_out";

export class BrowserProfileRequests extends Context.Service<
  BrowserProfileRequests,
  {
    /**
     * Shows a card in the thread's active run and waits for the user, the run's end or the
     * timeout. Each attempt gets its own card per profile; a decline holds for the whole run.
     */
    readonly request: (input: {
      readonly threadId: ThreadId;
      /** The asking session's provider; it must own the active run. */
      readonly providerInstanceId: ProviderInstanceId;
      readonly profileId: string;
      readonly profileName: string;
      readonly url?: string | undefined;
    }) => Effect.Effect<BrowserProfileRequestOutcome, BrowserProfileRequestError>;
    /** Approving records the card, then saves its grant; a failed save reopens the card. */
    readonly answer: (
      input: BrowserProfileRequestAnswerInput,
    ) => Effect.Effect<void, BrowserProfileRequestError>;
  }
>()("t3/preview/BrowserProfileRequests") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const random = yield* SecureRandom.SecureRandom;
  // Answers settle one at a time, so two racing answers cannot both save a grant.
  const answering = yield* Semaphore.make(1);
  // Concurrent opens of one profile share its card; only the last to leave may close it.
  const waiters = new Map<string, number>();

  const loadCards = (threadId: ThreadId) =>
    threads
      .getThreadRecords(threadId, ["runs", "turnItems"], {
        turnItemTypes: ["browser_profile_request"],
        messageRoles: [],
      })
      .pipe(
        Effect.mapError(
          (cause) => new BrowserProfileRequestError({ reason: "load_failed", cause }),
        ),
      );

  const record = (
    card: Pick<RequestItem, "threadId" | "id" | "profileId" | "profileName" | "url"> & {
      readonly runId: NonNullable<RequestItem["runId"]>;
      readonly nodeId: NonNullable<RequestItem["nodeId"]>;
    },
    accessStatus: OrchestrationV2BrowserProfileRequestStatus,
    grantScope?: AgentBrowserProfileGrant["scope"],
  ) =>
    random.uuidV4().pipe(
      Effect.flatMap((uuid) =>
        threads.dispatch({
          type: "browser_profile_request.record",
          // A reopened card is answered again, so no two records may share an id.
          commandId: CommandId.make(`browser-profile-request:${card.id}:${accessStatus}:${uuid}`),
          threadId: card.threadId,
          runId: card.runId,
          nodeId: card.nodeId,
          turnItemId: card.id,
          profileId: card.profileId,
          profileName: card.profileName,
          ...(card.url === undefined ? {} : { url: card.url }),
          accessStatus,
          ...(grantScope === undefined ? {} : { grantScope }),
        }),
      ),
      Effect.mapError(
        (cause) => new BrowserProfileRequestError({ reason: "record_failed", cause }),
      ),
    );

  const granted = (
    input: Parameters<BrowserProfileRequests["Service"]["request"]>[0],
    projectId: string,
  ) =>
    settings.getSettings.pipe(
      Effect.map((current) =>
        isAgentBrowserProfileGranted(current.agentBrowserProfileGrants, {
          profileId: input.profileId,
          threadId: input.threadId,
          projectId,
          providerInstanceId: input.providerInstanceId,
        }),
      ),
      Effect.orElseSucceed(() => false),
    );

  const request: BrowserProfileRequests["Service"]["request"] = Effect.fn(
    "BrowserProfileRequests.request",
  )(function* (input) {
    const records = yield* loadCards(input.threadId);
    const run = ThreadManagementService.latestActiveRun(records);
    if (
      run === undefined ||
      run.rootNodeId === null ||
      run.providerInstanceId !== input.providerInstanceId
    ) {
      return yield* new BrowserProfileRequestError({ reason: "agent_stopped" });
    }
    // Each attempt gets its own card: a steer replaces the attempt, and its card with it.
    const card = {
      threadId: input.threadId,
      runId: run.id,
      nodeId: run.rootNodeId,
      id: TurnItemId.make(
        CARD_PREFIX + [run.id, run.rootNodeId, input.profileId].map(encodeURIComponent).join(":"),
      ),
      profileId: input.profileId,
      profileName: input.profileName,
      url: input.url,
    };
    const answered = yield* Effect.acquireUseRelease(
      // Asking again reopens a card no one declined; not while an answer saves its grant, nor
      // after it saved one for an open that was refused just before.
      Effect.gen(function* () {
        const current = yield* loadCards(input.threadId);
        if (yield* granted(input, current.thread.projectId)) return "approved" as const;
        // A decline holds for the rest of the run, whichever attempt asked.
        const declined = current.turnItems.some(
          (item) =>
            item.type === "browser_profile_request" &&
            item.runId === run.id &&
            item.profileId === input.profileId &&
            item.accessStatus === "declined",
        );
        if (declined) return "declined" as const;
        const shown = current.turnItems.find((item) => item.id === card.id);
        // Opens waiting on one card may go to different pages; then it names none of them.
        const url =
          shown?.type === "browser_profile_request" &&
          shown.accessStatus === "pending" &&
          shown.url !== input.url
            ? undefined
            : input.url;
        yield* record({ ...card, url }, "pending");
        waiters.set(card.id, (waiters.get(card.id) ?? 0) + 1);
        return "waiting" as const;
      }).pipe(answering.withPermits(1)),
      (joined) =>
        Effect.gen(function* () {
          if (joined !== "waiting") return joined;
          while (true) {
            const records = yield* loadCards(input.threadId);
            const item = records.turnItems.find((candidate) => candidate.id === card.id);
            if (item?.type === "browser_profile_request") {
              if (item.accessStatus === "declined" || item.accessStatus === "cancelled") {
                return item.accessStatus;
              }
              // The card says approved just before its grant is saved, and reopens if that fails.
              // Approved with no grant once no answer is saving one means it was removed since.
              if (item.accessStatus === "approved") {
                if (yield* granted(input, records.thread.projectId)) return item.accessStatus;
                const settled = yield* Effect.gen(function* () {
                  const now = yield* loadCards(input.threadId);
                  const still = now.turnItems.find((candidate) => candidate.id === card.id);
                  if (
                    still?.type !== "browser_profile_request" ||
                    still.accessStatus !== "approved"
                  )
                    return undefined;
                  return (yield* granted(input, now.thread.projectId))
                    ? ("approved" as const)
                    : ("cancelled" as const);
                }).pipe(answering.withPermits(1));
                if (settled !== undefined) return settled;
              }
            }
            const current = records.runs.find((candidate) => candidate.id === run.id);
            // A steer restarts the run under a new root, which this card can never answer into.
            if (
              current === undefined ||
              ThreadManagementService.isTerminalRunStatus(current.status) ||
              current.rootNodeId !== card.nodeId
            ) {
              return "cancelled" as const;
            }
            yield* Effect.sleep(POLL_INTERVAL);
          }
        }).pipe(Effect.timeoutOption(REQUEST_TIMEOUT)),
      // Only these calls can open the tab, so the card must not outlive the last of them.
      (joined, exit) =>
        Effect.gen(function* () {
          if (joined !== "waiting") return;
          const left = (waiters.get(card.id) ?? 1) - 1;
          if (left > 0) waiters.set(card.id, left);
          else waiters.delete(card.id);
          if (left > 0) return;
          if (Exit.isSuccess(exit) && Option.isSome(exit.value) && exit.value.value !== "cancelled")
            return;
          yield* record(card, "cancelled").pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not close a browser profile request card", {
                error: error.message,
              }),
            ),
          );
        }).pipe(answering.withPermits(1)),
    );
    if (Option.isSome(answered)) return answered.value;
    // The user may have answered as the wait ran out; an approval counts once its grant is saved.
    return yield* Effect.gen(function* () {
      const { thread, turnItems } = yield* loadCards(input.threadId);
      const item = turnItems.find((candidate) => candidate.id === card.id);
      if (item?.type !== "browser_profile_request") return "timed_out" as const;
      if (item.accessStatus === "declined") return item.accessStatus;
      return item.accessStatus === "approved" && (yield* granted(input, thread.projectId))
        ? item.accessStatus
        : ("timed_out" as const);
    }).pipe(answering.withPermits(1));
  });

  const approveThenSave = Effect.fn("BrowserProfileRequests.approveThenSave")(function* (
    card: Parameters<typeof record>[0],
    grant: AgentBrowserProfileGrant,
    threadId: ThreadId,
  ) {
    yield* record(card, "approved", grant.scope);
    const settled = (yield* loadCards(threadId)).turnItems.find(
      (candidate) => candidate.id === card.id,
    );
    if (settled?.type !== "browser_profile_request" || settled.accessStatus !== "approved") {
      return yield* new BrowserProfileRequestError({ reason: "agent_stopped" });
    }
    yield* settings
      .updateSettings({
        agentBrowserProfileGrants: { [agentBrowserProfileGrantKey(grant)]: grant },
      })
      .pipe(
        Effect.catch((cause) =>
          // Reopened, the card can be answered again; until then the agent has no access.
          record(card, "pending").pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not reopen a browser profile request card", {
                error: error.message,
              }),
            ),
            Effect.andThen(
              Effect.fail(new BrowserProfileRequestError({ reason: "save_failed", cause })),
            ),
          ),
        ),
      );
  });

  const answer: BrowserProfileRequests["Service"]["answer"] = Effect.fn(
    "BrowserProfileRequests.answer",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.thread_id": input.threadId,
      "browser_profile_request.answer": input.answer.type,
    });
    const records = yield* loadCards(input.threadId);
    const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
    // A fork lists the cards it inherited; only the thread that asked answers one.
    if (
      item?.type !== "browser_profile_request" ||
      item.threadId !== input.threadId ||
      item.runId === null ||
      item.nodeId === null ||
      !item.id.startsWith(CARD_PREFIX)
    ) {
      return yield* new BrowserProfileRequestError({ reason: "not_found" });
    }
    if (item.accessStatus !== "pending") {
      return yield* new BrowserProfileRequestError({ reason: "already_answered" });
    }
    const run = records.runs.find((candidate) => candidate.id === item.runId);
    const card = { ...item, runId: item.runId, nodeId: item.nodeId };
    if (input.answer.type === "decline") return yield* record(card, "declined");
    // A steer can keep the run but replace its root, and its provider with it. The attempt that
    // asked is gone then, so nothing may be granted to whatever runs now.
    if (
      run === undefined ||
      ThreadManagementService.isTerminalRunStatus(run.status) ||
      run.rootNodeId !== item.nodeId
    ) {
      return yield* new BrowserProfileRequestError({ reason: "agent_stopped" });
    }
    const { scope } = input.answer;
    const grant: AgentBrowserProfileGrant = {
      profileId: item.profileId,
      profileName: item.profileName,
      scope,
      scopeId:
        scope === "thread"
          ? input.threadId
          : scope === "project"
            ? records.thread.projectId
            : run.providerInstanceId,
    };
    // The card decides first, in the orchestrator, which refuses an approval once a steer has
    // replaced the attempt that asked. Only an approved card's grant is saved, so a closed or
    // superseded card never leaves one. A client that disconnects cannot stop it halfway.
    yield* Effect.uninterruptible(approveThenSave(card, grant, input.threadId));
  }, answering.withPermits(1));

  return BrowserProfileRequests.of({ request, answer });
});

export const layer = Layer.effect(BrowserProfileRequests, make);
