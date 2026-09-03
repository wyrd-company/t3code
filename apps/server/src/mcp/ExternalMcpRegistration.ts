import { AuthOrchestrationOperateScope, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as McpProviderSession from "./McpProviderSession.ts";

export const EXTERNAL_MCP_REGISTRATION_PATH = "/api/mcp/provider-session";

const ExternalMcpRegistration = Schema.Struct({
  name: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u)),
  ),
  threadId: ThreadId,
  endpoint: Schema.String.check(Schema.isPattern(/^https?:\/\/[^\s]+$/u)),
  authorizationHeader: Schema.String.check(Schema.isPattern(/^Bearer [^\s\r\n]{1,8192}$/u)),
});

const ExternalMcpClear = Schema.Struct({
  name: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u)),
  ),
  threadId: ThreadId,
});

const decodeRegistration = Schema.decodeUnknownEffect(ExternalMcpRegistration);
const decodeClear = Schema.decodeUnknownEffect(ExternalMcpClear);

const invalidRequest = HttpServerResponse.jsonUnsafe(
  { error: "invalid_external_mcp_registration" },
  { status: 400, headers: { "cache-control": "no-store" } },
);

const unauthorized = HttpServerResponse.jsonUnsafe(
  { error: "auth_invalid" },
  { status: 401, headers: { "cache-control": "no-store" } },
);

const forbidden = HttpServerResponse.jsonUnsafe(
  { error: "insufficient_scope", requiredScope: AuthOrchestrationOperateScope },
  { status: 403, headers: { "cache-control": "no-store" } },
);

const internalError = HttpServerResponse.jsonUnsafe(
  { error: "internal_error" },
  { status: 500, headers: { "cache-control": "no-store" } },
);

type RegistrationHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  never
>;
type RegistrationAuthMiddleware = (
  httpEffect: RegistrationHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

const makeAuthMiddleware = EnvironmentAuth.EnvironmentAuth.pipe(
  Effect.map(
    (serverAuth): RegistrationAuthMiddleware =>
      Effect.fn("ExternalMcpRegistration.authenticate")(function* (
        httpEffect: RegistrationHttpEffect,
      ) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
          Effect.match({
            onFailure: (error) =>
              EnvironmentAuth.isServerAuthCredentialError(error) ? unauthorized : internalError,
            onSuccess: (authenticated) => authenticated,
          }),
        );
        if (HttpServerResponse.isHttpServerResponse(session)) return session;
        if (!session.scopes.includes(AuthOrchestrationOperateScope)) return forbidden;
        return yield* httpEffect;
      }),
  ),
);

const AuthMiddlewareLive = HttpRouter.middleware()(makeAuthMiddleware).layer;

const registerRoute = HttpRouter.add(
  "PUT",
  EXTERNAL_MCP_REGISTRATION_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const input = yield* request.json.pipe(Effect.flatMap(decodeRegistration), Effect.option);
    if (input._tag === "None") return invalidRequest;

    const registered = yield* Effect.sync(() => {
      const registration = {
        threadId: input.value.threadId,
        endpoint: input.value.endpoint,
        authorizationHeader: input.value.authorizationHeader,
        ...(input.value.name === undefined ? {} : { name: input.value.name }),
      };
      return McpProviderSession.setExternalMcpProviderSession(registration);
    });
    if (!registered) return invalidRequest;
    return HttpServerResponse.empty({ status: 204 });
  }),
);

const clearRoute = HttpRouter.add(
  "DELETE",
  EXTERNAL_MCP_REGISTRATION_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const input = yield* request.json.pipe(Effect.flatMap(decodeClear), Effect.option);
    if (input._tag === "None") return invalidRequest;

    yield* Effect.sync(() =>
      McpProviderSession.clearExternalMcpProviderSession(input.value.threadId, input.value.name),
    );
    return HttpServerResponse.empty({ status: 204 });
  }),
);

export const layer = Layer.mergeAll(registerRoute, clearRoute).pipe(
  Layer.provide(AuthMiddlewareLive),
);
