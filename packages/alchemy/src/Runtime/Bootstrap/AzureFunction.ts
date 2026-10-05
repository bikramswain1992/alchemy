/**
 * Azure Functions v4 HTTP bridge for an Effect-native Platform program.
 * The generated archive registers {@link makeHandler} with `app.http`.
 * The program is built once per worker; each invocation receives its own
 * HttpServerRequest and Scope (including response-body consumption).
 */
import { NodeServices } from "@effect/platform-node";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as EffectHttp from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { HttpServer, safeHttpEffect } from "../../Http.ts";
import { reifyBoundConfigProvider } from "../../Runtime.ts";
import { entrypointLayer, resolveProgram, stackFromEnv } from "./Process.ts";

/** The Azure v4 request subset consumed by the bridge. */
export interface AzureHttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Azure v4 accepts binary response bodies as ArrayBufferView. */
export interface AzureHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

type Dispatch = (request: Request) => Promise<Response>;

const captureServer = (dispatch: Deferred.Deferred<Dispatch>) =>
  Layer.succeed(HttpServer, {
    serve: (handler) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<any>();
        const safe = safeHttpEffect(handler as any);
        const run: Dispatch = (webRequest) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const scope = yield* Scope.make();
              const out = yield* Deferred.make<Response>();
              return yield* Effect.gen(function* () {
                yield* EffectHttp.toHandled(safe, (req, response) =>
                  Deferred.succeed(
                    out,
                    HttpServerResponse.toWeb(
                      EffectHttp.scopeTransferToStream(response),
                      { withoutBody: req.method === "HEAD", context },
                    ),
                  ),
                ).pipe(
                  Effect.provideService(
                    HttpServerRequest.HttpServerRequest,
                    HttpServerRequest.fromWeb(webRequest),
                  ),
                  Effect.provideService(Scope.Scope, scope),
                );
                return yield* Deferred.await(out);
              }).pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
            }).pipe(Effect.provideContext(context as Context.Context<never>)),
          );
        yield* Deferred.succeed(dispatch, run);
      }) as any,
  });

/** Construct a v4 `app.http` handler from an Effect-native entrypoint. */
export const makeHandler = (entrypoint: unknown) => {
  const dispatch = Deferred.makeUnsafe<Dispatch>();
  const platform = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );
  const program = resolveProgram("program", { telemetry: true }).pipe(
    Effect.provide(
      entrypointLayer(entrypoint).pipe(
        Layer.provideMerge(stackFromEnv),
        Layer.provideMerge(captureServer(dispatch)),
        Layer.provideMerge(platform),
        Layer.provideMerge(
          Layer.succeed(
            ConfigProvider.ConfigProvider,
            reifyBoundConfigProvider(ConfigProvider.fromEnv(), process.env),
          ),
        ),
      ),
    ),
    Effect.scoped,
  );
  Effect.runFork(
    program.pipe(
      Effect.tapCause((cause) =>
        Effect.logError("Azure Function program failed", cause),
      ),
      Effect.onExit(() =>
        Deferred.die(
          dispatch,
          new Error("Azure Function program exited without serving HTTP"),
        ),
      ),
    ) as Effect.Effect<unknown>,
  );
  const ready = Effect.runPromise(Deferred.await(dispatch));
  ready.catch(() => undefined);

  return async (request: AzureHttpRequest): Promise<AzureHttpResponse> => {
    try {
      const webRequest = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body:
          request.method === "GET" || request.method === "HEAD"
            ? undefined
            : new Uint8Array(await request.arrayBuffer()),
      });
      const response = await (await ready)(webRequest);
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      return {
        status: response.status,
        headers,
        body: new Uint8Array(await response.arrayBuffer()),
      };
    } catch (error) {
      console.error("Azure Function request failed", error);
      return { status: 500, headers: {}, body: new Uint8Array() };
    }
  };
};
