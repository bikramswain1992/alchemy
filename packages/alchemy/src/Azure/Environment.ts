import { Credentials } from "@distilled.cloud/azure/Credentials";
import type { Config } from "@distilled.cloud/azure/Credentials";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const DEFAULT_AZURE_LOCATION = "eastus";

export interface AzureEnvironmentShape extends Config {
  /** Default location for resources that do not specify one. */
  readonly location: string;
}

export class AzureSubscriptionMissing extends Data.TaggedError(
  "Azure.SubscriptionMissing",
)<{ message: string }> {}

/** ARM credentials and subscription context resolved at the time of each call. */
export class AzureEnvironment extends Context.Service<
  AzureEnvironment,
  Effect.Effect<AzureEnvironmentShape, AzureSubscriptionMissing>
>()("Azure::Environment") {
  static current = AzureEnvironment.use((env) => env);
}

/** Keep the credential effect live: cached layer construction must not pin an expiring token. */
export const fromCredentials = (location?: string) =>
  Layer.effect(
    AzureEnvironment,
    Effect.gen(function* () {
      const credentials = yield* Credentials;
      return Effect.gen(function* () {
        const config = yield* credentials;
        if (!config.subscriptionId) {
          return yield* new AzureSubscriptionMissing({
            message: "Set AZURE_SUBSCRIPTION_ID or configure an Azure profile.",
          });
        }
        return {
          ...config,
          location:
            location ??
            ("location" in config && typeof config.location === "string"
              ? config.location
              : DEFAULT_AZURE_LOCATION),
        };
      });
    }),
  );
