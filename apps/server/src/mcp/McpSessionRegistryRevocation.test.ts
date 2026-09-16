import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpServer } from "effect/unstable/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

const fakeHttpServer = HttpServer.HttpServer.of({
  address: { _tag: "TcpAddress", hostname: "127.0.0.1", port: 43123 },
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});
const fakeEnvironment = ServerEnvironment.ServerEnvironment.of({
  getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-revocation")),
  getDescriptor: Effect.die("unused"),
});

const makeRegistry = (now: () => number) =>
  McpSessionRegistry.__testing
    .make({
      now,
      livenessWindowMs: 100,
    })
    .pipe(
      Effect.provideService(HttpServer.HttpServer, fakeHttpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, fakeEnvironment),
      Effect.provide(NodeServices.layer),
    );

it.effect("closes a concurrent start when revocation wins hook registration", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* makeRegistry(() => 1_000);
      const issued = yield* registry.issue({
        threadId: ThreadId.make("thread-revocation-race"),
        providerInstanceId: ProviderInstanceId.make("cursor"),
        capabilities: new Set(),
      });
      const register = yield* Deferred.make<void>();
      let finalized = false;
      const registrationFiber = yield* Deferred.await(register).pipe(
        Effect.andThen(
          registry.onProviderSessionRevoked(
            issued.config.providerSessionId,
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        ),
        Effect.forkScoped,
      );
      yield* registry.revokeProviderSession(issued.config.providerSessionId);
      yield* Deferred.succeed(register, undefined);
      yield* Fiber.join(registrationFiber);
      expect(finalized).toBe(true);
    }),
  ),
);
