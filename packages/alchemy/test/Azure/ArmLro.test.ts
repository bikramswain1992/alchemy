import { waitForArmLro } from "@/Azure/ArmLro.ts";
import { Credentials } from "@distilled.cloud/azure/Credentials";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Clock from "effect/Clock";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

const origin = "https://management.azure.com";

describe(
  "Azure ARM long-running operations",
  { tags: ["unit", "provider:azure", "local"] },
  () => {
    it.effect(
      "polls Azure-AsyncOperation with renewed credentials and re-reads after success",
      () => {
        let token = 0;
        const calls: string[] = [];
        return Effect.gen(function* () {
          let reads = 0;
          const result = yield* waitForArmLro(
            {
              statusCode: 202,
              azureAsyncOperation: `${origin}/operations/one`,
              retryAfter: "0",
            },
            {
              read: Effect.sync(() => {
                reads++;
                return reads === 2
                  ? { provisioningState: "Succeeded" }
                  : undefined;
              }),
              isReady: (value) => value?.provisioningState === "Succeeded",
              maxAttempts: 4,
              pollInterval: "0 millis",
            },
          );
          expect(result).toEqual({ provisioningState: "Succeeded" });
          expect(calls).toEqual([
            `Bearer token-1 ${origin}/operations/one`,
            `Bearer token-2 ${origin}/operations/one`,
          ]);
          expect(reads).toBe(2);
        }).pipe(
          Effect.provideService(
            Credentials,
            Effect.sync(() => ({
              bearerToken: Redacted.make(`token-${++token}`),
              subscriptionId: "sub-1",
              apiBaseUrl: origin,
            })),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                calls.push(`${request.headers.authorization} ${request.url}`);
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    status: calls.length === 1 ? "InProgress" : "Succeeded",
                  }),
                );
              }),
            ),
          ),
        );
      },
    );

    it.effect(
      "uses Location when no Azure-AsyncOperation header is present",
      () => {
        const urls: string[] = [];
        return waitForArmLro(
          {
            statusCode: 202,
            location: `${origin}/operations/location`,
            retryAfter: "0",
          },
          {
            read: Effect.succeed("ready"),
            isReady: (value) => value === "ready",
            pollInterval: "0 millis",
          },
        ).pipe(
          Effect.tap((value) =>
            Effect.sync(() => {
              expect(value).toBe("ready");
              expect(urls).toEqual([`${origin}/operations/location`]);
            }),
          ),
          Effect.provideService(
            Credentials,
            Effect.succeed({
              bearerToken: Redacted.make("token"),
              subscriptionId: "sub-1",
              apiBaseUrl: origin,
            }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                urls.push(request.url);
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({ id: "resource-id" }),
                );
              }),
            ),
          ),
        );
      },
    );

    it.effect(
      "fails on terminal Failed without running the resource read",
      () => {
        let reads = 0;
        return Effect.gen(function* () {
          const outcome = yield* Effect.result(
            waitForArmLro(
              {
                statusCode: 202,
                azureAsyncOperation: `${origin}/operations/fail`,
                retryAfter: "0",
              },
              {
                read: Effect.sync(() => ++reads),
                isReady: () => true,
                pollInterval: "0 millis",
              },
            ),
          );
          expect(Result.isFailure(outcome)).toBe(true);
          if (Result.isFailure(outcome)) {
            expect(outcome.failure).toMatchObject({
              _tag: "Azure.ArmLroFailed",
              status: "Failed",
              message: "quota exceeded",
            });
          }
          expect(reads).toBe(0);
        }).pipe(
          Effect.provideService(
            Credentials,
            Effect.succeed({
              bearerToken: Redacted.make("token"),
              subscriptionId: "sub-1",
              apiBaseUrl: origin,
            }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    status: "Failed",
                    error: { code: "QuotaExceeded", message: "quota exceeded" },
                  }),
                ),
              ),
            ),
          ),
        );
      },
    );

    it.effect(
      "bounds repeated pending polls and never reads before operation success",
      () => {
        let polls = 0;
        let reads = 0;
        return Effect.gen(function* () {
          const result = yield* Effect.result(
            waitForArmLro(
              {
                statusCode: 202,
                azureAsyncOperation: `${origin}/operations/pending`,
                retryAfter: "0",
              },
              {
                read: Effect.sync(() => ++reads),
                isReady: () => true,
                maxAttempts: 3,
                pollInterval: "0 millis",
              },
            ),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure).toMatchObject({
              _tag: "Azure.ArmLroTimedOut",
              attempts: 3,
            });
          expect(polls).toBe(3);
          expect(reads).toBe(0);
        }).pipe(
          Effect.provideService(
            Credentials,
            Effect.succeed({
              bearerToken: Redacted.make("token"),
              subscriptionId: "sub-1",
              apiBaseUrl: origin,
            }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                polls++;
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({ status: "InProgress" }),
                );
              }),
            ),
          ),
        );
      },
    );

    it.effect(
      "rejects a cross-origin polling URL before sending a credential",
      () => {
        let requests = 0;
        return Effect.gen(function* () {
          const result = yield* Effect.result(
            waitForArmLro(
              {
                statusCode: 202,
                azureAsyncOperation: "https://example.com/steal",
                retryAfter: "0",
              },
              {
                read: Effect.succeed("ready"),
                isReady: () => true,
                pollInterval: "0 millis",
              },
            ),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure._tag).toBe("Azure.ArmLroInvalidResponse");
          expect(requests).toBe(0);
        }).pipe(
          Effect.provideService(
            Credentials,
            Effect.succeed({
              bearerToken: Redacted.make("token"),
              subscriptionId: "sub-1",
              apiBaseUrl: origin,
            }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                requests++;
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({ status: "Succeeded" }),
                );
              }),
            ),
          ),
        );
      },
    );

    it.effect("respects Retry-After on the polling response", () => {
      let polls = 0;
      return Effect.gen(function* () {
        const start = yield* Clock.currentTimeMillis;
        const fiber = yield* waitForArmLro(
          {
            statusCode: 202,
            azureAsyncOperation: `${origin}/operations/delay`,
            retryAfter: "0",
          },
          {
            read: Effect.succeed("ready"),
            isReady: () => true,
            pollInterval: "0 millis",
          },
        ).pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(fiber);
        const elapsed = (yield* Clock.currentTimeMillis) - start;
        expect(result).toBe("ready");
        expect(polls).toBe(2);
        expect(elapsed).toBeGreaterThan(999);
      }).pipe(
        Effect.provideService(
          Credentials,
          Effect.succeed({
            bearerToken: Redacted.make("token"),
            subscriptionId: "sub-1",
            apiBaseUrl: origin,
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              polls++;
              return HttpClientResponse.fromWeb(
                request,
                Response.json(
                  { status: polls === 1 ? "InProgress" : "Succeeded" },
                  {
                    headers: polls === 1 ? { "Retry-After": "1" } : {},
                  },
                ),
              );
            }),
          ),
        ),
      );
    });

    it.effect(
      "re-reads immediately when ARM returns 204 without a polling URL",
      () => {
        let reads = 0;
        let polls = 0;
        return Effect.gen(function* () {
          const result = yield* waitForArmLro(
            { statusCode: 204 },
            {
              read: Effect.sync(() => ++reads === 2),
              isReady: (gone) => gone,
              pollInterval: "0 millis",
            },
          );
          expect(result).toBe(true);
          expect(reads).toBe(2);
          expect(polls).toBe(0);
        }).pipe(
          Effect.provideService(
            Credentials,
            Effect.succeed({
              bearerToken: Redacted.make("token"),
              subscriptionId: "sub-1",
              apiBaseUrl: origin,
            }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                polls++;
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({ status: "Succeeded" }),
                );
              }),
            ),
          ),
        );
      },
    );

    it.effect(
      "returns a typed failure on nonretryable ARM poll responses",
      () => {
        let polls = 0;
        return Effect.gen(function* () {
          const result = yield* Effect.result(
            waitForArmLro(
              {
                statusCode: 202,
                azureAsyncOperation: `${origin}/operations/denied`,
                retryAfter: "0",
              },
              {
                read: Effect.succeed("ready"),
                isReady: () => true,
                pollInterval: "0 millis",
              },
            ),
          );
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure).toMatchObject({
              _tag: "Azure.ArmLroHttpFailure",
              statusCode: 403,
            });
          expect(polls).toBe(1);
        }).pipe(
          Effect.provideService(
            Credentials,
            Effect.succeed({
              bearerToken: Redacted.make("token"),
              subscriptionId: "sub-1",
              apiBaseUrl: origin,
            }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                polls++;
                return HttpClientResponse.fromWeb(
                  request,
                  new Response("denied", { status: 403 }),
                );
              }),
            ),
          ),
        );
      },
    );

    it.effect(
      "retries throttled polls without reading the resource early",
      () => {
        let polls = 0;
        let reads = 0;
        return Effect.gen(function* () {
          const result = yield* waitForArmLro(
            {
              statusCode: 202,
              azureAsyncOperation: `${origin}/operations/throttled`,
              retryAfter: "0",
            },
            {
              read: Effect.sync(() => ++reads),
              isReady: (n) => n === 1,
              maxAttempts: 3,
              pollInterval: "0 millis",
            },
          );
          expect(result).toBe(1);
          expect(polls).toBe(2);
          expect(reads).toBe(1);
        }).pipe(
          Effect.provideService(
            Credentials,
            Effect.succeed({
              bearerToken: Redacted.make("token"),
              subscriptionId: "sub-1",
              apiBaseUrl: origin,
            }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                polls++;
                return HttpClientResponse.fromWeb(
                  request,
                  polls === 1
                    ? new Response("throttled", {
                        status: 429,
                        headers: { "Retry-After": "0" },
                      })
                    : Response.json({ status: "Succeeded" }),
                );
              }),
            ),
          ),
        );
      },
    );

    it.effect(
      "does not confuse the create response's resource location with a Location header",
      () => {
        let polls = 0;
        return Effect.gen(function* () {
          const result = yield* waitForArmLro(
            { statusCode: 200, location: "eastus" },
            {
              read: Effect.succeed("ready"),
              isReady: () => true,
              pollInterval: "0 millis",
            },
          );
          expect(result).toBe("ready");
          expect(polls).toBe(0);
        }).pipe(
          Effect.provideService(
            Credentials,
            Effect.succeed({
              bearerToken: Redacted.make("token"),
              subscriptionId: "sub-1",
              apiBaseUrl: origin,
            }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                polls++;
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({ status: "Succeeded" }),
                );
              }),
            ),
          ),
        );
      },
    );
  },
);
