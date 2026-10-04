import { parseAzureCliAccessToken } from "@/Azure/CliToken.ts";
import {
  AzureAuth,
  type AzureAuthConfig,
  type AzureResolvedCredentials,
} from "@/Azure/AuthProvider.ts";
import { fromCli } from "@/Azure/Credentials.ts";
import { AzureEnvironment, fromCredentials } from "@/Azure/Environment.ts";
import { AuthProviders, getAuthProvider } from "@/Auth/AuthProvider.ts";
import { Credentials } from "@distilled.cloud/azure/Credentials";
import * as resources from "@distilled.cloud/azure/resources";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "alchemy-test";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

describe(
  "Azure credentials",
  { tags: ["unit", "provider:azure", "local"] },
  () => {
    it("accepts a CLI token with a numeric expiration and rejects invalid output", () => {
      expect(
        parseAzureCliAccessToken(
          JSON.stringify({ accessToken: "abc", expires_on: 1_800_000_000 }),
          1_700_000_000_000,
        ),
      ).toEqual({ token: "abc", expiresAt: 1_800_000_000_000 });
      expect(() =>
        parseAzureCliAccessToken('{"accessToken":""}', 1_700_000_000_000),
      ).toThrow();
    });

    it.effect("rejects expired CLI tokens before passing them to ARM", () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        expect(() =>
          parseAzureCliAccessToken(
            JSON.stringify({
              accessToken: "expired-token",
              expires_on: Math.floor(now / 1000) - 60,
            }),
            now,
          ),
        ).toThrow();
      }),
    );

    it.effect("resolves fresh credentials for every operation", () =>
      Effect.gen(function* () {
        const token = yield* Ref.make("first");
        const layer = fromCredentials().pipe(
          Layer.provide(
            Layer.succeed(
              Credentials,
              Ref.get(token).pipe(
                Effect.map((value) => ({
                  bearerToken: Redacted.make(value),
                  subscriptionId: "sub-1",
                  apiBaseUrl: "https://management.azure.com",
                })),
              ),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const env = yield* AzureEnvironment;
          expect(Redacted.value((yield* env).bearerToken)).toBe("first");
          yield* Ref.set(token, "second");
          expect(Redacted.value((yield* env).bearerToken)).toBe("second");
        }).pipe(Effect.provide(layer));
      }),
    );

    it.effect(
      "uses the configured Azure location from renewable credentials",
      () =>
        Effect.gen(function* () {
          const env = yield* AzureEnvironment.current;
          expect(env.location).toBe("westus2");
        }).pipe(
          Effect.provide(fromCredentials()),
          Effect.provideService(
            Credentials,
            Effect.succeed({
              bearerToken: Redacted.make("example"),
              subscriptionId: "subscription-1",
              apiBaseUrl: "https://management.azure.com",
              location: "westus2",
            }),
          ),
        ),
    );

    it.effect(
      "reports missing service-principal configuration without contacting Azure",
      () =>
        Effect.gen(function* () {
          const auth = yield* getAuthProvider<
            AzureAuthConfig,
            AzureResolvedCredentials
          >("Azure");
          const result = yield* Effect.result(auth.readEnvironment!);
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe("AuthError");
            expect(result.failure.message).toContain("AZURE_CLIENT_SECRET");
          }
        }).pipe(
          Effect.provide(AzureAuth),
          Effect.provideService(AuthProviders, {}),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.make(() => Effect.succeed(undefined)),
          ),
          Effect.provide(BunServices.layer),
        ),
    );

    it.effect(
      "refreshes short-lived service-principal tokens on repeated credential reads",
      () => {
        let tokenRequests = 0;
        return Effect.gen(function* () {
          const auth = yield* getAuthProvider<
            AzureAuthConfig,
            AzureResolvedCredentials
          >("Azure");
          const config = {
            method: "servicePrincipal" as const,
            subscriptionId: "subscription-1",
            tenantId: "tenant-1",
            clientId: "client-1",
            clientSecret: "private-secret",
          };
          const first = yield* auth.read("testing", config);
          const second = yield* auth.read("testing", config);
          expect(Redacted.value(first.bearerToken)).toBe("token-1");
          expect(Redacted.value(second.bearerToken)).toBe("token-2");
          expect(second.subscriptionId).toBe("subscription-1");
        }).pipe(
          Effect.provide(AzureAuth),
          Effect.provideService(AuthProviders, {}),
          Effect.provide(BunServices.layer),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                expect(request.url).toBe(
                  "https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token",
                );
                expect(request.method).toBe("POST");
                const count = ++tokenRequests;
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    access_token: `token-${count}`,
                    expires_in: 60,
                  }),
                );
              }),
            ),
          ),
        );
      },
    );
  },
);

it.effect(
  "uses the supplied CLI identity for a read-only ARM request",
  () =>
    Effect.gen(function* () {
      const credentials = yield* Credentials;
      const { subscriptionId } = yield* credentials;
      expect(subscriptionId.length).toBeGreaterThan(0);
      const groups = yield* resources.ListResourceGroups({
        subscriptionId,
        _top: 1,
      });
      expect(Array.isArray(groups.value)).toBe(true);
    }).pipe(Effect.provide(fromCli()), Effect.provide(FetchHttpClient.layer)),
  { tags: ["provider:azure", "live"], timeout: 45_000 },
);
