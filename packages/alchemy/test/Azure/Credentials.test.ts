import { parseAzureCliAccessToken } from "@/Azure/CliToken.ts";
import { AzureEnvironment, fromCredentials } from "@/Azure/Environment.ts";
import { Credentials } from "@distilled.cloud/azure/Credentials";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";

describe(
  "Azure credentials",
  { tags: ["unit", "provider:azure", "local"] },
  () => {
    it("accepts a CLI token with a numeric expiration and rejects invalid output", () => {
      expect(
        parseAzureCliAccessToken(
          JSON.stringify({ accessToken: "abc", expires_on: 1_800_000_000 }),
        ),
      ).toEqual({ token: "abc", expiresAt: 1_800_000_000_000 });
      expect(() => parseAzureCliAccessToken('{"accessToken":""}')).toThrow();
    });

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
  },
);
