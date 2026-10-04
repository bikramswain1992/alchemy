import { ConfigError } from "@distilled.cloud/core/errors";
import { Credentials } from "@distilled.cloud/azure/Credentials";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import {
  deferUntilFirstUse,
  orDieCredentialsUnavailable,
  resolveProviderConfig,
} from "../Auth/Resolve.ts";
import {
  AZURE_AUTH_PROVIDER_NAME,
  cliAccount,
  cliToken,
  type AzureAuthConfig,
  type AzureResolvedCredentials,
} from "./AuthProvider.ts";

export {
  Credentials,
  CredentialsFromEnv,
  type Config as CredentialsConfig,
} from "@distilled.cloud/azure/Credentials";

/** Resolves the configured Azure identity on every ARM request, refreshing tokens as needed. */
export const fromAuthProvider = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const lookup = yield* resolveProviderConfig<
        AzureAuthConfig,
        AzureResolvedCredentials
      >(AZURE_AUTH_PROVIDER_NAME).pipe(
        deferUntilFirstUse,
        Effect.flatMap(Effect.cached),
      );
      return lookup.pipe(
        Effect.flatMap(({ resolve }) =>
          resolve.pipe(
            Effect.map(
              ({
                bearerToken,
                subscriptionId,
                tenantId,
                apiBaseUrl,
                location,
              }) => ({
                bearerToken,
                subscriptionId,
                tenantId,
                apiBaseUrl,
                location,
              }),
            ),
            Effect.mapError(
              (cause) =>
                new ConfigError({
                  message: `Azure credentials unavailable: ${cause.message}`,
                }),
            ),
          ),
        ),
        orDieCredentialsUnavailable(AZURE_AUTH_PROVIDER_NAME),
      );
    }),
  );

/** Use the current `az login` identity without creating or changing an Alchemy profile. */
export const fromCli = () =>
  Layer.effect(
    Credentials,
    Effect.gen(function* () {
      const cache = yield* Ref.make<
        { token: string; expiresAt: number; subscriptionId: string } | undefined
      >(undefined);
      return Effect.gen(function* () {
        const account = yield* cliAccount;
        const cached = yield* Ref.get(cache);
        const now = yield* Clock.currentTimeMillis;
        const value =
          cached?.subscriptionId === account.subscriptionId &&
          cached.expiresAt - now > 300_000
            ? cached
            : yield* cliToken.pipe(
                Effect.tap((next) =>
                  Ref.set(cache, {
                    ...next,
                    subscriptionId: account.subscriptionId,
                  }),
                ),
              );
        return {
          bearerToken: Redacted.make(value.token),
          subscriptionId: account.subscriptionId,
          tenantId: account.tenantId,
          apiBaseUrl: "https://management.azure.com",
        };
      }).pipe(orDieCredentialsUnavailable(AZURE_AUTH_PROVIDER_NAME));
    }),
  );
