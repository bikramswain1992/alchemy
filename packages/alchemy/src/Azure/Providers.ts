import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Provider from "../Provider.ts";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import { AzureAuth } from "./AuthProvider.ts";
import * as Credentials from "./Credentials.ts";
import { fromCredentials } from "./Environment.ts";
import {
  ResourceGroup,
  ResourceGroupProvider,
} from "./Resources/ResourceGroup.ts";
import {
  StorageAccount,
  StorageAccountProvider,
} from "./Storage/StorageAccount.ts";
import {
  BlobContainer,
  BlobContainerProvider,
} from "./Storage/BlobContainer.ts";
import {
  AppServicePlan,
  AppServicePlanProvider,
} from "./Web/AppServicePlan.ts";
import { FunctionApp, FunctionAppProvider } from "./Web/FunctionApp.ts";
import {
  FunctionDeployment,
  FunctionDeploymentProvider,
} from "./Web/FunctionDeployment.ts";
import {
  RoleAssignment,
  RoleAssignmentProvider,
} from "./Authorization/RoleAssignment.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Azure",
) {}

const azureLive = <R>(
  credentials: Layer.Layer<Credentials.Credentials, never, R>,
) =>
  fromCredentials().pipe(
    Layer.provideMerge(credentials),
    Layer.provideMerge(AzureAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
  );

/** Register the Azure resource providers and ARM authentication services for a stack. */
export const providers = (credentials = Credentials.fromAuthProvider()) =>
  Layer.effect(
    Providers,
    Effect.gen(function* () {
      return yield* Provider.collection([
        ResourceGroup,
        StorageAccount,
        BlobContainer,
        AppServicePlan,
        FunctionApp,
        FunctionDeployment,
        RoleAssignment,
      ]);
    }),
  ).pipe(
    Layer.provide(ResourceGroupProvider()),
    Layer.provide(StorageAccountProvider()),
    Layer.provide(BlobContainerProvider()),
    Layer.provide(AppServicePlanProvider()),
    Layer.provide(FunctionAppProvider()),
    Layer.provide(FunctionDeploymentProvider()),
    Layer.provide(RoleAssignmentProvider()),
    Layer.provideMerge(azureLive(credentials)),
    Layer.orDie,
  );
