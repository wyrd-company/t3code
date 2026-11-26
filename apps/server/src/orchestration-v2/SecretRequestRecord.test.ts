import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for record controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "secret-request-record" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const projectId = ProjectId.make("project:secret-request-record");
const threadId = ThreadId.make("thread:secret-request-record");
const sessionId = ProviderSessionId.make("session:secret-request-record");
const providerThreadId = ProviderThreadId.make("provider-thread:secret-request-record");
const runId = RunId.make("run:secret-request-record");
const firstAttemptId = RunAttemptId.make("attempt:secret-request-record:1");
const steeredAttemptId = RunAttemptId.make("attempt:secret-request-record:2");
const originalRoot = NodeId.make("node:secret-request-record:original");
const steeredRoot = NodeId.make("node:secret-request-record:steered");
const originalTurnId = ProviderTurnId.make("provider-turn:secret-request-record:original");
const messageId = MessageId.make("message:secret-request-record");
const cardId = TurnItemId.make("turn-item:secret-request:secret-request-record");
const staleCardId = TurnItemId.make("turn-item:secret-request:secret-request-record:stale");
const now = DateTime.makeUnsafe("2026-11-11T20:00:00.000Z");

/** A running run whose first attempt reached the provider, where cards are asked. */
const startRun = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-secret-request-record"),
    threadId,
    projectId,
    title: "Secret request record",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* projections.apply({
    id: EventId.make("secret-request-record:session"),
    type: "provider-session.attached",
    threadId,
    occurredAt: now,
    payload: {
      id: sessionId,
      driver: adapter.driver,
      providerInstanceId: instanceId,
      status: "ready",
      cwd: "/repo",
      model: modelSelection.model,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
  });
  yield* projections.apply({
    id: EventId.make("secret-request-record:provider-thread"),
    type: "provider-thread.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: providerThreadId,
      driver: adapter.driver,
      providerInstanceId: instanceId,
      providerSessionId: sessionId,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver: adapter.driver, nativeId: "native-thread", strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  yield* projections.apply({
    id: EventId.make("secret-request-record:run"),
    type: "run.created",
    threadId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId: instanceId,
      modelSelection,
      providerThreadId,
      userMessageId: messageId,
      rootNodeId: originalRoot,
      activeAttemptId: firstAttemptId,
      status: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  yield* projections.apply({
    id: EventId.make("secret-request-record:attempt-1"),
    type: "run-attempt.created",
    threadId,
    occurredAt: now,
    payload: {
      id: firstAttemptId,
      runId,
      attemptOrdinal: 1,
      rootNodeId: originalRoot,
      providerInstanceId: instanceId,
      providerThreadId,
      providerTurnId: null,
      reason: "initial",
      status: "running",
      startedAt: now,
      completedAt: null,
    },
  });

  // The first attempt reached the provider; the card is asked on that turn.
  yield* projections.apply({
    id: EventId.make("secret-request-record:turn"),
    type: "provider-turn.updated",
    threadId,
    occurredAt: now,
    payload: {
      id: originalTurnId,
      providerThreadId,
      nodeId: originalRoot,
      runAttemptId: firstAttemptId,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running",
      startedAt: now,
      completedAt: null,
    },
  });
  return { orchestrator, projections };
});

/**
 * A pending secret card must stay closable after a steering restart replaces the
 * run's root node: the call that opened it only ever carries the card's own node,
 * so rejecting that node wedges the card open forever.
 */
it.effect("closes a secret card recorded under an earlier root after a steering restart", () =>
  Effect.gen(function* () {
    const { orchestrator, projections } = yield* startRun;
    const record = (commandId: string, nodeId: NodeId, turnItemId: TurnItemId) =>
      orchestrator.dispatch({
        type: "secret_request.record",
        commandId: CommandId.make(commandId),
        threadId,
        runId,
        nodeId,
        turnItemId,
        label: "Booking details",
        reason: "To check the passenger in.",
        secretStatus: "pending" as const,
      });
    const readCard = (id: TurnItemId) =>
      projections
        .getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["secret_request"],
          messageRoles: [],
        })
        .pipe(
          Effect.map((records) => {
            const item = records.turnItems.find((candidate) => candidate.id === id);
            return item?.type === "secret_request" ? item : undefined;
          }),
        );

    yield* record("secret-request-record:open", originalRoot, cardId);
    const opened = yield* readCard(cardId);
    assert.equal(opened?.secretStatus, "pending");
    assert.equal(opened?.providerTurnId, originalTurnId);

    // The user steers while the card waits: the run's root moves to a new attempt.
    yield* projections.apply({
      id: EventId.make("secret-request-record:run-steered"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: steeredRoot,
        activeAttemptId: steeredAttemptId,
        status: "starting",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    yield* projections.apply({
      id: EventId.make("secret-request-record:attempt-2"),
      type: "run-attempt.created",
      threadId,
      occurredAt: now,
      payload: {
        id: steeredAttemptId,
        runId,
        attemptOrdinal: 2,
        rootNodeId: steeredRoot,
        providerInstanceId: instanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "steering_restart",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    });

    // The waiting call only carries the card's own node; closing must still work.
    yield* orchestrator.dispatch({
      type: "secret_request.record",
      commandId: CommandId.make("secret-request-record:close"),
      threadId,
      runId,
      nodeId: originalRoot,
      turnItemId: cardId,
      label: "Booking details",
      reason: "To check the passenger in.",
      secretStatus: "cancelled" as const,
    });
    const cancelled = yield* readCard(cardId);
    assert.equal(cancelled?.secretStatus, "cancelled");
    assert.equal(cancelled?.status, "cancelled");
    // Closing through the card's own node keeps the identity it was asked with,
    // even though the run's active attempt has no provider turn of its own.
    assert.equal(cancelled?.nodeId, originalRoot);
    assert.equal(cancelled?.providerTurnId, originalTurnId);

    // A new card may not be opened under the stale root.
    const stale = yield* Effect.flip(
      record("secret-request-record:stale-open", originalRoot, staleCardId),
    );
    assert.match(String((stale as { cause?: unknown }).cause ?? ""), /is not the root of run/);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a browser profile card holds the thread for the user until it is decided", () =>
  Effect.gen(function* () {
    const { orchestrator, projections } = yield* startRun;
    const profileCardId = TurnItemId.make("turn-item:browser-profile-request:record");
    const record = (accessStatus: "pending" | "approved" | "cancelled", attempt = "") =>
      orchestrator.dispatch({
        type: "browser_profile_request.record",
        commandId: CommandId.make(`browser-profile-request-record:${accessStatus}${attempt}`),
        threadId,
        runId,
        nodeId: originalRoot,
        turnItemId: profileCardId,
        profileId: "profile-work",
        profileName: "Work",
        url: "https://mail.example",
        accessStatus,
        ...(accessStatus === "approved" ? { grantScope: "thread" as const } : {}),
      });
    const readCard = projections
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["browser_profile_request"],
        messageRoles: [],
      })
      .pipe(Effect.map((records) => records.turnItems.find((item) => item.id === profileCardId)));
    const waitingOnUser = projections
      .getThreadShell(threadId)
      .pipe(Effect.map((shell) => shell?.pendingRuntimeRequest?.userOnly === true));

    yield* record("pending");
    assert.deepInclude(yield* readCard, { status: "waiting", accessStatus: "pending" });
    assert.isTrue(yield* waitingOnUser);

    yield* record("approved");
    // A late close leaves an approval as it is.
    yield* record("cancelled");
    assert.deepInclude(yield* readCard, {
      status: "completed",
      accessStatus: "approved",
      grantScope: "thread",
    });
    assert.isFalse(yield* waitingOnUser);
    // Asking again reopens it, for an agent whose grant failed to save or was removed.
    yield* record("pending", ":again");
    assert.deepInclude(yield* readCard, { status: "waiting", accessStatus: "pending" });
    assert.isTrue(yield* waitingOnUser);
    yield* record("approved", ":again");
    assert.deepInclude(yield* readCard, { status: "completed", accessStatus: "approved" });

    // A card that closed unanswered reopens too; only a decline holds for the run.
    const closedCardId = TurnItemId.make("turn-item:browser-profile-request:closed");
    const recordClosed = (accessStatus: "pending" | "cancelled" | "declined", attempt = "") =>
      orchestrator.dispatch({
        type: "browser_profile_request.record",
        commandId: CommandId.make(`browser-profile-request-closed:${accessStatus}${attempt}`),
        threadId,
        runId,
        nodeId: originalRoot,
        turnItemId: closedCardId,
        profileId: "profile-client",
        profileName: "Client",
        accessStatus,
      });
    const readClosed = projections
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["browser_profile_request"],
        messageRoles: [],
      })
      .pipe(Effect.map((records) => records.turnItems.find((item) => item.id === closedCardId)));
    yield* recordClosed("pending");
    yield* recordClosed("cancelled");
    yield* recordClosed("pending", ":again");
    assert.deepInclude(yield* readClosed, { status: "waiting", accessStatus: "pending" });
    yield* recordClosed("declined");
    yield* recordClosed("pending", ":after-decline");
    assert.deepInclude(yield* readClosed, { accessStatus: "declined" });

    // Opens that join a waiting card can only take its address away; answers keep what was shown.
    const addressCardId = TurnItemId.make("turn-item:browser-profile-request:address");
    const recordAddress = (
      accessStatus: "pending" | "cancelled",
      attempt: string,
      url: string | undefined,
    ) =>
      orchestrator.dispatch({
        type: "browser_profile_request.record",
        commandId: CommandId.make(`browser-profile-request-address:${attempt}`),
        threadId,
        runId,
        nodeId: originalRoot,
        turnItemId: addressCardId,
        profileId: "profile-bank",
        profileName: "Bank",
        ...(url === undefined ? {} : { url }),
        accessStatus,
      });
    const readAddress = projections
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["browser_profile_request"],
        messageRoles: [],
      })
      .pipe(Effect.map((records) => records.turnItems.find((item) => item.id === addressCardId)));
    yield* recordAddress("pending", "first", "https://mail.example");
    yield* recordAddress("pending", "other", "https://bank.example");
    assert.deepInclude(yield* readAddress, { url: "https://mail.example" });
    yield* recordAddress("pending", "unnamed", undefined);
    assert.notProperty(yield* readAddress, "url");
    yield* recordAddress("cancelled", "close", "https://bank.example");
    assert.notProperty(yield* readAddress, "url");

    // After a steer replaces the attempt that asked, its card can be closed but not approved.
    const staleCardId = TurnItemId.make("turn-item:browser-profile-request:steered");
    const recordStale = (accessStatus: "pending" | "approved" | "cancelled") =>
      orchestrator.dispatch({
        type: "browser_profile_request.record",
        commandId: CommandId.make(`browser-profile-request-steered:${accessStatus}`),
        threadId,
        runId,
        nodeId: originalRoot,
        turnItemId: staleCardId,
        profileId: "profile-client",
        profileName: "Client",
        accessStatus,
        ...(accessStatus === "approved" ? { grantScope: "providerInstance" as const } : {}),
      });
    yield* recordStale("pending");
    yield* projections.apply({
      id: EventId.make("browser-profile-request-record:run-steered"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: steeredRoot,
        activeAttemptId: steeredAttemptId,
        status: "starting",
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    const refused = yield* Effect.flip(recordStale("approved"));
    assert.match(String((refused as { cause?: unknown }).cause ?? ""), /is not the root of run/);
    yield* recordStale("cancelled");
    // Only the attempt that asked may reopen its approval.
    yield* record("pending", ":after-steer");
    assert.deepInclude(yield* readCard, { status: "completed", accessStatus: "approved" });

    // A run that stopped keeps its root, but a card it asked can no longer be approved.
    const stoppedCardId = TurnItemId.make("turn-item:browser-profile-request:stopped");
    const recordStopped = (accessStatus: "pending" | "approved") =>
      orchestrator.dispatch({
        type: "browser_profile_request.record",
        commandId: CommandId.make(`browser-profile-request-stopped:${accessStatus}`),
        threadId,
        runId,
        nodeId: steeredRoot,
        turnItemId: stoppedCardId,
        profileId: "profile-client",
        profileName: "Client",
        accessStatus,
        ...(accessStatus === "approved" ? { grantScope: "project" as const } : {}),
      });
    yield* recordStopped("pending");
    yield* projections.apply({
      id: EventId.make("browser-profile-request-record:run-stopped"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: steeredRoot,
        activeAttemptId: steeredAttemptId,
        status: "interrupted",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    const ended = yield* Effect.flip(recordStopped("approved"));
    assert.match(String((ended as { cause?: unknown }).cause ?? ""), /has ended/);

    const stale = (yield* projections.getThreadRecords(threadId, ["turnItems"], {
      turnItemTypes: ["browser_profile_request"],
      messageRoles: [],
    })).turnItems.find((item) => item.id === staleCardId);
    assert.deepInclude(stale, { status: "cancelled", accessStatus: "cancelled" });
  }).pipe(Effect.provide(layerTest)),
);
