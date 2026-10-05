import { Credentials } from "@distilled.cloud/azure/Credentials";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

export class ArmLroFailed extends Data.TaggedError("Azure.ArmLroFailed")<{
  readonly url: string;
  readonly status: string;
  readonly message?: string;
}> {}

export class ArmLroHttpFailure extends Data.TaggedError(
  "Azure.ArmLroHttpFailure",
)<{
  readonly url: string;
  readonly statusCode: number;
  readonly body: string;
}> {}

export class ArmLroInvalidResponse extends Data.TaggedError(
  "Azure.ArmLroInvalidResponse",
)<{
  readonly message: string;
}> {}

export class ArmLroTimedOut extends Data.TaggedError("Azure.ArmLroTimedOut")<{
  readonly attempts: number;
}> {}

/** The response metadata modeled by ARM create/delete operations in Distilled. */
export interface ArmLroResponse {
  readonly statusCode: number;
  readonly azureAsyncOperation?: string;
  readonly location?: string;
  readonly locationHeader?: string;
  readonly retryAfter?: string;
}

export interface ArmLroOptions<A, E, R> {
  /** Observe actual resource state (including absence after delete) after the operation completes. */
  readonly read: Effect.Effect<A, E, R>;
  readonly isReady: (value: A) => boolean;
  /** Maximum poll/read cycles, including the first; defaults to 10 (capped at 10). */
  readonly maxAttempts?: number;
  /** Delay when ARM omits Retry-After; defaults to 5 seconds. Delays are capped at 5 seconds. */
  readonly pollInterval?: Duration.Input;
}

const retryDelay = (
  header: string | undefined,
  fallback: number,
  now: number,
) => {
  if (!header) return fallback;
  const seconds = Number(header);
  const millis =
    Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : Date.parse(header) - now;
  return Number.isFinite(millis)
    ? Math.min(5_000, Math.max(0, millis))
    : fallback;
};

const safeUrl = (raw: string, base: string) =>
  Effect.try({
    try: () => {
      const url = new URL(raw);
      const endpoint = new URL(base);
      if (
        url.protocol !== "https:" ||
        url.origin !== endpoint.origin ||
        url.username ||
        url.password ||
        url.hash
      ) {
        throw new Error(
          "ARM polling URL must be an HTTPS URL on the credential endpoint",
        );
      }
      return url.toString();
    },
    catch: () =>
      new ArmLroInvalidResponse({
        message:
          "ARM polling URL is invalid or outside the credential endpoint",
      }),
  });

/**
 * Wait for an ARM LRO, then repeatedly read until the requested resource state is visible.
 * Refreshes Azure Credentials for every polling GET. At most 10 cycles and 90 seconds
 * elapse, including observation; Retry-After delays are capped at 5 seconds.
 */
export const waitForArmLro = <A, E, R>(
  response: ArmLroResponse,
  options: ArmLroOptions<A, E, R>,
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const credentials = yield* Credentials;
    const attempts = Math.max(
      1,
      Math.min(10, Math.trunc(options.maxAttempts ?? 10) || 10),
    );
    const interval = Math.min(
      5_000,
      Math.max(0, Duration.toMillis(options.pollInterval ?? "5 seconds")),
    );
    const pollingUrl =
      response.azureAsyncOperation ??
      response.locationHeader ??
      // Storage Account create has a body `location` (e.g. "eastus"); delete
      // models the Location header under the same property name.
      (response.location?.includes("://") ? response.location : undefined);
    let delay = response.retryAfter;
    let operationDone = !pollingUrl;
    for (let i = 0; i < attempts; i++) {
      if (i > 0 || pollingUrl) {
        const now = yield* Clock.currentTimeMillis;
        const wait = yield* Effect.sync(() => retryDelay(delay, interval, now));
        yield* Effect.sleep(Duration.millis(wait));
      }
      if (!operationDone && pollingUrl) {
        // Resolve the credential effect on EACH GET, rather than capturing a token in the layer.
        const { bearerToken, apiBaseUrl } = yield* credentials;
        const url = yield* safeUrl(pollingUrl, apiBaseUrl);
        const result = yield* client.execute(
          HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeader(
              "Authorization",
              `Bearer ${Redacted.value(bearerToken)}`,
            ),
          ),
        );
        delay = result.headers["retry-after"];
        const body = yield* result.text;
        if (result.status < 200 || result.status >= 300) {
          if (![409, 429, 500, 502, 503, 504].includes(result.status)) {
            return yield* new ArmLroHttpFailure({
              url,
              statusCode: result.status,
              body,
            });
          }
          continue;
        }
        const payload = yield* Effect.try({
          try: () => (body.trim() ? (JSON.parse(body) as unknown) : {}),
          catch: () =>
            new ArmLroInvalidResponse({
              message: "ARM polling response was not valid JSON",
            }),
        });
        if (
          payload === null ||
          typeof payload !== "object" ||
          Array.isArray(payload)
        ) {
          return yield* new ArmLroInvalidResponse({
            message: "ARM polling response was not an object",
          });
        }
        const value = payload as Record<string, unknown>;
        const status =
          typeof value.status === "string" ? value.status : undefined;
        if (
          status === "Failed" ||
          status === "Canceled" ||
          status === "Cancelled"
        ) {
          const error = value.error;
          const message =
            error &&
            typeof error === "object" &&
            "message" in error &&
            typeof error.message === "string"
              ? error.message
              : undefined;
          return yield* new ArmLroFailed({ url, status, message });
        }
        // Azure-AsyncOperation must explicitly report success; Location may finish with
        // an ordinary resource response containing no status field.
        operationDone =
          status === "Succeeded" ||
          (!response.azureAsyncOperation && !status && result.status !== 202);
      }
      if (operationDone) {
        const observed = yield* options.read;
        if (yield* Effect.sync(() => options.isReady(observed)))
          return observed;
      }
    }
    return yield* new ArmLroTimedOut({ attempts });
  }).pipe(
    Effect.timeoutOption("90 seconds"),
    Effect.flatMap((result) =>
      Option.match(result, {
        onNone: () =>
          Effect.fail(
            new ArmLroTimedOut({
              attempts: Math.max(
                1,
                Math.min(10, Math.trunc(options.maxAttempts ?? 10) || 10),
              ),
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
