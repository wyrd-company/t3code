import { assert, expect, it } from "@effect/vitest";
import {
  type AgentBrowserProfileGrantScope,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderInstanceId,
  ServerSettingsError,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BrowserProfileRequests from "./BrowserProfileRequests.ts";

const threadId = ThreadId.make("thread-browser");
const projectId = ProjectId.make("project-browser");
const providerInstanceId = ProviderInstanceId.make("claude");

type RecordCommand = Extract<
  OrchestrationV2ServerCommand,
  { type: "browser_profile_request.record" }
>;

/** Cards settle as the orchestrator settles them: a decided card stays decided. */
const withService = <A, E>(
  body: (input: {
    readonly service: BrowserProfileRequests.BrowserProfileRequests["Service"];
    readonly settings: ServerSettings.ServerSettingsService["Service"];
    readonly asked: Deferred.Deferred<TurnItemId>;
    readonly endRun: () => void;
    /** A steer gives the run a new root, as it does when the provider changes. */
    readonly steer: () => void;
    /** The asking call closes the card just before an approval records. */
    readonly closeBeforeApproval: () => void;
    /** A steer lands after the answer read the run, just before its approval records. */
    readonly steerBeforeApproval: () => void;
    /** The next settings write fails, as a full disk or a managed setting would. */
    readonly failNextSave: () => void;
    /** The next settings write waits until the returned effect runs. */
    readonly holdNextSave: () => Effect.Effect<void>;
    readonly dispatched: Array<RecordCommand>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const asked = yield* Deferred.make<TurnItemId>();
    const cards = new Map<string, RecordCommand>();
    const dispatched: Array<RecordCommand> = [];
    let runStatus = "running";
    let rootNodeId = "node-root";
    let closeFirst = false;
    let steerFirst = false;
    let failSave = false;
    let heldSave: Deferred.Deferred<void> | undefined;
    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: () =>
        Effect.sync(
          () =>
            ({
              thread: { projectId, providerInstanceId },
              runs: [
                {
                  id: "run-1",
                  status: runStatus,
                  rootNodeId,
                  providerInstanceId,
                  ordinal: 1,
                },
              ],
              turnItems: [...cards.values()].map((card) => ({
                id: card.turnItemId,
                threadId: card.threadId,
                runId: card.runId,
                nodeId: card.nodeId,
                type: "browser_profile_request",
                profileId: card.profileId,
                profileName: card.profileName,
                ...(card.url === undefined ? {} : { url: card.url }),
                accessStatus: card.accessStatus,
              })),
            }) as never,
        ),
      dispatch: (command) =>
        Effect.gen(function* () {
          if (command.type !== "browser_profile_request.record") return {} as never;
          dispatched.push(command);
          if (closeFirst && command.accessStatus === "approved") {
            cards.set(command.turnItemId, { ...command, accessStatus: "cancelled" });
            return {} as never;
          }
          if (steerFirst && command.accessStatus === "approved") rootNodeId = "node-steered";
          // As the orchestrator does: an approval needs the attempt that asked.
          if (command.accessStatus === "approved" && rootNodeId !== command.nodeId) {
            return yield* Effect.fail(new Error("not the root") as never);
          }
          const existing = cards.get(command.turnItemId);
          const reopening =
            (existing?.accessStatus === "approved" || existing?.accessStatus === "cancelled") &&
            command.accessStatus === "pending" &&
            runStatus === "running" &&
            rootNodeId === existing.nodeId;
          const pending = command.accessStatus === "pending";
          const clearsAddress =
            existing?.accessStatus === "pending" &&
            pending &&
            existing.url !== undefined &&
            command.url === undefined;
          if (
            existing === undefined ||
            (existing.accessStatus === "pending" && !pending) ||
            reopening ||
            clearsAddress
          ) {
            cards.set(
              command.turnItemId,
              pending || existing === undefined ? command : { ...command, url: existing.url },
            );
          }
          if (command.accessStatus === "pending")
            yield* Deferred.succeed(asked, command.turnItemId);
          return {} as never;
        }),
    });
    return yield* Effect.gen(function* () {
      return yield* body({
        service: yield* BrowserProfileRequests.BrowserProfileRequests,
        settings: yield* ServerSettings.ServerSettingsService,
        asked,
        endRun: () => {
          runStatus = "completed";
        },
        steer: () => {
          rootNodeId = "node-steered";
        },
        closeBeforeApproval: () => {
          closeFirst = true;
        },
        steerBeforeApproval: () => {
          steerFirst = true;
        },
        failNextSave: () => {
          failSave = true;
        },
        holdNextSave: () => {
          const held = Deferred.makeUnsafe<void>();
          heldSave = held;
          return Deferred.succeed(held, undefined).pipe(Effect.asVoid);
        },
        dispatched,
      });
    }).pipe(
      Effect.provide(
        BrowserProfileRequests.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              threads,
              slowSettings({
                failing: () => failSave,
                held: () => {
                  const held = heldSave;
                  failSave = false;
                  heldSave = undefined;
                  return held;
                },
              }),
            ),
          ),
          Layer.provide(SecureRandom.layerWebCrypto),
        ),
      ),
    );
  });

/** Real test settings whose next write can fail or wait. */
const slowSettings = (next: {
  readonly failing: () => boolean;
  readonly held: () => Deferred.Deferred<void> | undefined;
}) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const real = yield* ServerSettings.ServerSettingsService;
      return ServerSettings.ServerSettingsService.of({
        ...real,
        updateSettings: (patch) =>
          Effect.suspend(() => {
            const failing = next.failing();
            const held = next.held();
            const write = failing
              ? Effect.fail(
                  new ServerSettingsError({
                    settingsPath: "settings.json",
                    operation: "write-file",
                  }),
                )
              : real.updateSettings(patch);
            return held === undefined ? write : Deferred.await(held).pipe(Effect.andThen(write));
          }),
      });
    }),
  ).pipe(Layer.provide(ServerSettings.layerTest()));

const ask = { threadId, providerInstanceId, profileId: "profile-work", profileName: "Work" };

it.effect("approving saves the grant at the chosen scope before the agent sees approved", () =>
  Effect.forEach(
    [
      ["thread", threadId],
      ["project", projectId],
      ["providerInstance", providerInstanceId],
    ] as const satisfies ReadonlyArray<readonly [AgentBrowserProfileGrantScope, string]>,
    ([scope, scopeId]) =>
      withService(({ service, settings, asked }) =>
        Effect.gen(function* () {
          const waiting = yield* service.request(ask).pipe(Effect.forkChild);
          const turnItemId = yield* Deferred.await(asked);
          yield* service.answer({ threadId, turnItemId, answer: { type: "approve", scope } });
          const { agentBrowserProfileGrants } = yield* settings.getSettings;
          assert.deepStrictEqual(Object.values(agentBrowserProfileGrants), [
            { profileId: "profile-work", profileName: "Work", scope, scopeId },
          ]);
          yield* TestClock.adjust("1 second");
          assert.strictEqual(yield* Fiber.join(waiting), "approved");
        }),
      ),
  ),
);

it.effect("a failed save reopens the card, so the user can answer again", () =>
  withService(({ service, settings, asked, failNextSave, dispatched }) =>
    Effect.gen(function* () {
      const waiting = yield* service.request(ask).pipe(Effect.forkChild);
      const turnItemId = yield* Deferred.await(asked);
      failNextSave();
      const approve = {
        threadId,
        turnItemId,
        answer: { type: "approve", scope: "thread" },
      } as const;
      const failed = yield* service.answer(approve).pipe(Effect.flip);
      assert.strictEqual(failed.reason, "save_failed");
      assert.deepStrictEqual((yield* settings.getSettings).agentBrowserProfileGrants, {});
      // The agent keeps waiting on the reopened card instead of opening without access.
      yield* TestClock.adjust("20 seconds");
      assert.strictEqual(waiting.pollUnsafe(), undefined);

      yield* service.answer(approve);
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(waiting), "approved");
      assert.deepStrictEqual(
        dispatched.map((command) => command.accessStatus),
        ["pending", "approved", "pending", "approved"],
      );
    }),
  ),
);

it.effect("the agent waits for the grant its approved card is saving", () =>
  withService(({ service, asked, holdNextSave }) =>
    Effect.gen(function* () {
      const waiting = yield* service.request(ask).pipe(Effect.forkChild);
      const turnItemId = yield* Deferred.await(asked);
      const releaseSave = holdNextSave();
      const answering = yield* service
        .answer({ threadId, turnItemId, answer: { type: "approve", scope: "thread" } })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      assert.strictEqual(waiting.pollUnsafe(), undefined);
      yield* releaseSave;
      yield* Fiber.join(answering);
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(waiting), "approved");
    }),
  ),
);

it.effect("an open refused just before the grant was saved finds it instead of reopening", () =>
  withService(({ service, asked, dispatched }) =>
    Effect.gen(function* () {
      const first = yield* service.request(ask).pipe(Effect.forkChild);
      const turnItemId = yield* Deferred.await(asked);
      yield* service.answer({ threadId, turnItemId, answer: { type: "approve", scope: "thread" } });
      assert.strictEqual(yield* service.request(ask), "approved");
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(first), "approved");
      assert.deepStrictEqual(
        dispatched.map((command) => command.accessStatus),
        ["pending", "approved"],
      );
    }),
  ),
);

it.effect("an approval saves its grant even when the answering client disconnects", () =>
  withService(({ service, settings, asked, holdNextSave }) =>
    Effect.gen(function* () {
      const waiting = yield* service.request(ask).pipe(Effect.forkChild);
      const turnItemId = yield* Deferred.await(asked);
      const releaseSave = holdNextSave();
      const answering = yield* service
        .answer({ threadId, turnItemId, answer: { type: "approve", scope: "thread" } })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const disconnect = yield* Fiber.interrupt(answering).pipe(Effect.forkChild);
      // The interrupt lands while the save is still held.
      yield* Effect.yieldNow;
      yield* releaseSave;
      yield* Fiber.join(disconnect);
      assert.lengthOf(Object.keys((yield* settings.getSettings).agentBrowserProfileGrants), 1);
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(waiting), "approved");
    }),
  ),
);

it.effect("asking again after the grant was removed reopens the approved card", () =>
  withService(({ service, settings, asked }) =>
    Effect.gen(function* () {
      const first = yield* service.request(ask).pipe(Effect.forkChild);
      const turnItemId = yield* Deferred.await(asked);
      yield* service.answer({ threadId, turnItemId, answer: { type: "approve", scope: "thread" } });
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(first), "approved");
      const [key] = Object.keys((yield* settings.getSettings).agentBrowserProfileGrants);
      yield* settings.updateSettings({ agentBrowserProfileGrants: { [key!]: null } });

      const again = yield* service.request(ask).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* service.answer({ threadId, turnItemId, answer: { type: "decline" } });
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(again), "declined");
    }),
  ),
);

it.effect("an agent stops waiting when its grant is removed before it sees the approval", () =>
  withService(({ service, settings, asked }) =>
    Effect.gen(function* () {
      const waiting = yield* service.request(ask).pipe(Effect.forkChild);
      const turnItemId = yield* Deferred.await(asked);
      yield* service.answer({ threadId, turnItemId, answer: { type: "approve", scope: "thread" } });
      const [key] = Object.keys((yield* settings.getSettings).agentBrowserProfileGrants);
      yield* settings.updateSettings({ agentBrowserProfileGrants: { [key!]: null } });
      yield* TestClock.adjust("1 second");
      assert.isDefined(waiting.pollUnsafe(), "the agent stopped waiting");
      assert.strictEqual(yield* Fiber.join(waiting), "cancelled");
    }),
  ),
);

it.effect("one of two waiting opens leaving does not close the card for the other", () =>
  withService(({ service, asked, dispatched }) =>
    Effect.gen(function* () {
      const leaving = yield* service.request(ask).pipe(Effect.forkChild);
      const turnItemId = yield* Deferred.await(asked);
      const staying = yield* service.request(ask).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* Fiber.interrupt(leaving);
      yield* service.answer({ threadId, turnItemId, answer: { type: "approve", scope: "thread" } });
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(staying), "approved");
      assert.notInclude(
        dispatched.map((command) => command.accessStatus),
        "cancelled",
      );
    }),
  ),
);

it.effect("a card that closed unanswered can be asked again in the same run", () =>
  withService(({ service, asked }) =>
    Effect.gen(function* () {
      const first = yield* service.request(ask).pipe(Effect.forkChild);
      const turnItemId = yield* Deferred.await(asked);
      yield* TestClock.adjust("11 minutes");
      assert.strictEqual(yield* Fiber.join(first), "timed_out");

      const again = yield* service.request(ask).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* service.answer({ threadId, turnItemId, answer: { type: "approve", scope: "thread" } });
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(again), "approved");
    }),
  ),
);

it.effect("an approval as the wait runs out counts once its grant is saved", () =>
  withService(({ service, asked, holdNextSave }) =>
    Effect.gen(function* () {
      const waiting = yield* service.request(ask).pipe(Effect.forkChild);
      const turnItemId = yield* Deferred.await(asked);
      yield* TestClock.adjust("9 minutes");
      const releaseSave = holdNextSave();
      const answering = yield* service
        .answer({ threadId, turnItemId, answer: { type: "approve", scope: "thread" } })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("2 minutes");
      assert.strictEqual(waiting.pollUnsafe(), undefined);
      yield* releaseSave;
      yield* Fiber.join(answering);
      assert.strictEqual(yield* Fiber.join(waiting), "approved");
    }),
  ),
);

it.effect("after a steer the new attempt gets a card of its own, but a decline still holds", () =>
  withService(({ service, asked, steer }) =>
    Effect.gen(function* () {
      const first = yield* service.request(ask).pipe(Effect.forkChild);
      const firstCard = yield* Deferred.await(asked);
      steer();
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(first), "cancelled");

      const again = yield* service.request(ask).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const cards = yield* service
        .answer({ threadId, turnItemId: firstCard, answer: { type: "decline" } })
        .pipe(Effect.flip);
      assert.strictEqual(cards.reason, "already_answered");
      yield* Fiber.interrupt(again);

      // Declining the new attempt's card holds for the rest of the run.
      const third = yield* service.request(ask).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const secondCard = TurnItemId.make(firstCard.replace("node-root", "node-steered"));
      yield* service.answer({ threadId, turnItemId: secondCard, answer: { type: "decline" } });
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(third), "declined");
      assert.strictEqual(yield* service.request(ask), "declined");
    }),
  ),
);

it.effect("a decline in one attempt holds for the next after a steer", () =>
  withService(({ service, asked, steer, dispatched }) =>
    Effect.gen(function* () {
      const first = yield* service.request(ask).pipe(Effect.forkChild);
      const turnItemId = yield* Deferred.await(asked);
      yield* service.answer({ threadId, turnItemId, answer: { type: "decline" } });
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(first), "declined");
      steer();
      assert.strictEqual(yield* service.request(ask), "declined");
      assert.lengthOf(dispatched, 2);
    }),
  ),
);

it.effect("a card two opens wait on names no address when they go to different pages", () =>
  withService(({ service, asked, dispatched }) =>
    Effect.gen(function* () {
      yield* service.request({ ...ask, url: "https://mail.example" }).pipe(Effect.forkChild);
      yield* Deferred.await(asked);
      yield* service.request({ ...ask, url: "https://mail.example" }).pipe(Effect.forkChild);
      yield* service.request({ ...ask, url: "https://bank.example" }).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(
        dispatched.map((command) => command.url),
        ["https://mail.example", "https://mail.example", undefined],
      );
    }),
  ),
);

it.effect("an agent keeps waiting through a slow save that fails, and the card reopens", () =>
  withService(({ service, asked, settings, holdNextSave, failNextSave }) =>
    Effect.gen(function* () {
      const waiting = yield* service.request(ask).pipe(Effect.forkChild);
      const turnItemId = yield* Deferred.await(asked);
      const releaseSave = holdNextSave();
      failNextSave();
      const answering = yield* service
        .answer({ threadId, turnItemId, answer: { type: "approve", scope: "thread" } })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("30 seconds");
      yield* releaseSave;
      assert.strictEqual((yield* Effect.flip(Fiber.join(answering))).reason, "save_failed");
      yield* TestClock.adjust("1 second");
      assert.strictEqual(waiting.pollUnsafe(), undefined);
      assert.deepStrictEqual((yield* settings.getSettings).agentBrowserProfileGrants, {});

      yield* service.answer({ threadId, turnItemId, answer: { type: "approve", scope: "thread" } });
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(waiting), "approved");
    }),
  ),
);

it.effect("a decline holds for the rest of the run and saves nothing", () =>
  withService(({ service, settings, asked, dispatched }) =>
    Effect.gen(function* () {
      const waiting = yield* service.request(ask).pipe(Effect.forkChild);
      const turnItemId = yield* Deferred.await(asked);
      yield* service.answer({ threadId, turnItemId, answer: { type: "decline" } });
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(waiting), "declined");
      // Asking again in the same run finds the declined card instead of showing a new one.
      assert.strictEqual(yield* service.request(ask), "declined");
      assert.deepStrictEqual((yield* settings.getSettings).agentBrowserProfileGrants, {});
      const answerAgain = yield* service
        .answer({ threadId, turnItemId, answer: { type: "approve", scope: "project" } })
        .pipe(Effect.flip);
      assert.strictEqual(answerAgain.reason, "already_answered");
      assert.deepStrictEqual(
        dispatched.map((command) => command.accessStatus),
        ["pending", "declined"],
      );
    }),
  ),
);

it.effect("a card closes as cancelled when its run ends or nobody answers in time", () =>
  withService(({ service, asked, endRun, dispatched }) =>
    Effect.gen(function* () {
      const timedOut = yield* service
        .request({ ...ask, profileId: "profile-client", profileName: "Client" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(asked);
      yield* TestClock.adjust("11 minutes");
      assert.strictEqual(yield* Fiber.join(timedOut), "timed_out");

      const ended = yield* service.request(ask).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      endRun();
      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* Fiber.join(ended), "cancelled");
      assert.deepStrictEqual(
        dispatched.map((command) => [command.profileId, command.accessStatus]),
        [
          ["profile-client", "pending"],
          ["profile-client", "cancelled"],
          ["profile-work", "pending"],
          ["profile-work", "cancelled"],
        ],
      );
    }),
  ),
);

it.effect.each(["steered", "steered mid-answer", "closed"] as const)(
  "an approval saves nothing once the attempt that asked is gone or its card is: %s",
  (race) =>
    withService(({ service, settings, asked, steer, closeBeforeApproval, steerBeforeApproval }) =>
      Effect.gen(function* () {
        yield* service.request(ask).pipe(Effect.forkChild);
        const turnItemId = yield* Deferred.await(asked);
        if (race === "steered") steer();
        else if (race === "closed") closeBeforeApproval();
        else steerBeforeApproval();
        const refused = yield* service
          .answer({
            threadId,
            turnItemId,
            answer: { type: "approve", scope: "providerInstance" },
          })
          .pipe(Effect.flip);
        expect(["agent_stopped", "record_failed", "already_answered"]).toContain(refused.reason);
        assert.deepStrictEqual((yield* settings.getSettings).agentBrowserProfileGrants, {});
      }),
    ),
);
