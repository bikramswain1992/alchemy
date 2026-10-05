import * as web from "@distilled.cloud/azure/web";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import type * as Bundle from "../../Bundle/Bundle.ts";
import { isResolved } from "../../Diff.ts";
import * as Output from "../../Output.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import { Platform, type Main, type PlatformProps } from "../../Platform.ts";
import * as Provider from "../../Provider.ts";
import { type Resource } from "../../Resource.ts";
import { packEnvValue } from "../../RuntimeContext.ts";
import {
  createHostRuntimeContext,
  type HostRuntimeContext,
} from "../../Server/Process.ts";
import { Stack } from "../../Stack.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  stripInternalTags,
  tagRecord,
} from "../../Tags.ts";
import { RoleAssignment } from "../Authorization/RoleAssignment.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { FunctionDeployment } from "./FunctionDeployment.ts";

export interface FunctionAppProps extends PlatformProps {
  /** Containing resource group name, which may be externally managed. */
  resourceGroupName: string;
  /** Existing or stack-managed Linux FC1 App Service plan ARM ID. Immutable. */
  planId: string;
  /** Existing or stack-managed StorageV2 account ARM ID. Immutable. */
  storageAccountId: string;
  /** Existing or stack-managed private Blob container ARM ID for packages. Immutable. */
  deploymentContainerId: string;
  /** Globally unique hostname prefix. Defaults to a deterministic physical name. */
  name?: string;
  /** Function App region. Changing region replaces the app. */
  location?: string;
  /** Effect-native HTTP handler entry to bundle and publish. */
  main: string;
  /** Selected export of `main`. @default "default" */
  handler?: string;
  /** User environment variables; observed platform-managed settings are retained. */
  env?: Record<string, any>;
  /** User tags; Alchemy ownership tags are added automatically. */
  tags?: Record<string, string>;
  /** Bundler configuration. */
  build?: Bundle.BundleConfig;
}

export type FunctionApp = Resource<
  "Azure.Web.FunctionApp",
  FunctionAppProps,
  {
    /** ARM site ID. */ id: string;
    /** Function App name. */ name: string;
    /** Subscription ID. */ subscriptionId: string;
    /** Containing resource group. */ resourceGroupName: string;
    /** Region. */ location: string;
    /** Flex plan ARM ID. */ planId: string;
    /** Host storage account ARM ID. */ storageAccountId: string;
    /** Deployment container ARM ID. */ deploymentContainerId: string;
    /** System-assigned identity object ID. */ principalId: string;
    /** Public HTTPS origin. */ url: string;
    /** User tags. */ tags: Record<string, string>;
  },
  { env?: Record<string, any> },
  Providers
>;

export type FunctionAppRuntimeContext = HostRuntimeContext;
export type FunctionAppShape = Main;

/**
 * An Effect-native HTTP Azure Function App running Node.js 22 on Linux Flex FC1.
 * The app's system identity receives storage roles before its code is published.
 * Passing ARM IDs for an external plan or storage resource does not transfer ownership.
 *
 * ### Hosting an HTTP Function
 * **Example:** Use existing plan and storage resources
 * ```typescript
 * const app = yield* Azure.Web.FunctionApp("Http", {
 *   resourceGroupName: group.name,
 *   planId: plan.id,
 *   storageAccountId: account.id,
 *   deploymentContainerId: container.id,
 *   main: new URL("./src/Http.ts", import.meta.url).href,
 * }, Effect.succeed({ fetch: Effect.succeed(HttpServerResponse.text("hello")) }));
 * ```
 *
 * @resource
 * @category Web
 */
export const FunctionApp: Platform<
  FunctionApp,
  never,
  FunctionAppShape,
  FunctionAppRuntimeContext
> = Platform("Azure.Web.FunctionApp", {
  createRuntimeContext: createHostRuntimeContext("Azure.Web.FunctionApp"),
  onCreate: (app: FunctionApp, props: FunctionAppProps) =>
    Effect.gen(function* () {
      if (globalThis.__ALCHEMY_RUNTIME__) return;
      const subscriptionId = app.subscriptionId;
      const role = (guid: string) =>
        Output.interpolate`/subscriptions/${subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${guid}`;
      const blob = yield* RoleAssignment(`${app.LogicalId}-HostBlob`, {
        scope: props.storageAccountId,
        principalId: app.principalId,
        roleDefinitionId: role("b7e6dc6d-f1e8-4753-8033-0f276bb0955b"),
      });
      const table = yield* RoleAssignment(`${app.LogicalId}-HostTable`, {
        scope: props.storageAccountId,
        principalId: app.principalId,
        roleDefinitionId: role("0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3"),
      });
      const queue = yield* RoleAssignment(`${app.LogicalId}-HostQueue`, {
        scope: props.storageAccountId,
        principalId: app.principalId,
        roleDefinitionId: role("974c5e8b-45b9-4653-ba55-5f855dd0fb88"),
      });
      yield* FunctionDeployment(`${app.LogicalId}-Code`, {
        appId: app.id,
        ownerId: app.LogicalId,
        url: app.url,
        grantIds: [blob.id, table.id, queue.id],
        main: props.main,
        handler: props.handler,
        build: props.build,
        isExternal: props.isExternal,
      });
    }),
});

export class FunctionAppNotReady extends Data.TaggedError(
  "Azure.FunctionAppNotReady",
)<{ name: string }> {}
export class FunctionAppUnowned extends Data.TaggedError(
  "Azure.FunctionAppUnowned",
)<{ name: string }> {}
export class FunctionAppInvalidDependency extends Data.TaggedError(
  "Azure.FunctionAppInvalidDependency",
)<{ id: string }> {}
export class FunctionAppPlanInUse extends Data.TaggedError(
  "Azure.FunctionAppPlanInUse",
)<{ planId: string }> {}

const segments = (id: string, type: "plan" | "account" | "container") => {
  const prefix =
    /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.(.+)$/i.exec(
      id,
    );
  if (!prefix) return undefined;
  const path = prefix[3]!;
  const match = (
    type === "plan"
      ? /^Web\/serverfarms\/([^/]+)$/i
      : type === "account"
        ? /^Storage\/storageAccounts\/([^/]+)$/i
        : /^Storage\/storageAccounts\/([^/]+)\/blobServices\/default\/containers\/([^/]+)$/i
  ).exec(path);
  return match
    ? {
        subscriptionId: prefix[1]!,
        resourceGroupName: prefix[2]!,
        name: match[type === "container" ? 2 : 1]!,
        accountName: type === "container" ? match[1] : undefined,
      }
    : undefined;
};

const locationKey = (location: string) =>
  location.toLowerCase().replace(/[\s-]/g, "");

const get = (subscriptionId: string, resourceGroupName: string, name: string) =>
  web
    .GetWebApp({ subscriptionId, resourceGroupName, name })
    .pipe(
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const waitReady = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  get(subscriptionId, resourceGroupName, name).pipe(
    Effect.flatMap((site) =>
      site?.identity?.principalId
        ? Effect.succeed(site)
        : Effect.fail(new FunctionAppNotReady({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "Azure.FunctionAppNotReady",
      schedule: Schedule.spaced("4 seconds"),
      times: 10,
    }),
  );

const attrs = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
  observed: web.GetWebAppResponse,
  storageAccountId: string,
  deploymentContainerId: string,
) => ({
  id:
    observed.id ??
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Web/sites/${name}`,
  name,
  subscriptionId,
  resourceGroupName,
  location: observed.location,
  planId: observed.properties?.serverFarmId ?? "",
  storageAccountId,
  deploymentContainerId,
  principalId: observed.identity?.principalId ?? "",
  url: `https://${observed.properties?.defaultHostName ?? `${name}.azurewebsites.net`}`,
  tags: stripInternalTags(tagRecord(observed.tags)),
});

export const FunctionAppProvider = () =>
  Provider.succeed(FunctionApp, {
    stables: [
      "id",
      "name",
      "subscriptionId",
      "resourceGroupName",
      "location",
      "planId",
      "storageAccountId",
      "deploymentContainerId",
    ],
    diff: Effect.fn(function* ({ news, output, olds }) {
      if (!isResolved(news)) return undefined;
      if (
        output &&
        ((news.name && news.name !== output.name) ||
          news.resourceGroupName.toLowerCase() !==
            output.resourceGroupName.toLowerCase() ||
          (news.location !== undefined &&
            locationKey(news.location) !== locationKey(output.location)) ||
          news.planId.toLowerCase() !== output.planId.toLowerCase() ||
          (output.storageAccountId &&
            news.storageAccountId.toLowerCase() !==
              output.storageAccountId.toLowerCase()) ||
          (output.deploymentContainerId &&
            news.deploymentContainerId.toLowerCase() !==
              output.deploymentContainerId.toLowerCase()))
      )
        return { action: "replace" as const, deleteFirst: true };
      if (
        olds &&
        (news.planId !== olds.planId ||
          news.storageAccountId !== olds.storageAccountId ||
          news.deploymentContainerId !== olds.deploymentContainerId)
      )
        return { action: "replace" as const, deleteFirst: true };
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const group = olds?.resourceGroupName ?? output?.resourceGroupName;
      if (!group) return undefined;
      const name =
        olds?.name ??
        output?.name ??
        (yield* createPhysicalName({ id, maxLength: 48, lowercase: true }));
      const site = yield* get(subscriptionId, group, name);
      if (!site) return undefined;
      const result = attrs(
        subscriptionId,
        group,
        name,
        site,
        olds?.storageAccountId ?? output?.storageAccountId ?? "",
        olds?.deploymentContainerId ?? output?.deploymentContainerId ?? "",
      );
      return (yield* hasAlchemyTags(id, site.tags)) ? result : Unowned(result);
    }),
    reconcile: Effect.fn(function* ({ id, news, output, bindings, olds }) {
      const { subscriptionId, location } = yield* AzureEnvironment.current;
      const stack = yield* Stack;
      const name =
        news.name ??
        output?.name ??
        (yield* createPhysicalName({ id, maxLength: 48, lowercase: true }));
      const storage = segments(news.storageAccountId, "account");
      const container = segments(news.deploymentContainerId, "container");
      if (
        !storage ||
        !container ||
        storage.name.toLowerCase() !== container.accountName?.toLowerCase() ||
        storage.subscriptionId.toLowerCase() !==
          container.subscriptionId.toLowerCase() ||
        storage.resourceGroupName.toLowerCase() !==
          container.resourceGroupName.toLowerCase()
      )
        return yield* new FunctionAppInvalidDependency({
          id: news.deploymentContainerId,
        });
      const desiredConfig: web.FunctionAppConfig = {
        runtime: { name: "node", version: "22" },
        scaleAndConcurrency: {
          instanceMemoryMB: 2048,
          maximumInstanceCount: 100,
        },
        deployment: {
          storage: {
            type: "blobContainer",
            value: `https://${storage.name}.blob.core.windows.net/${container.name}`,
            authentication: { type: "SystemAssignedIdentity" },
          },
        },
      };
      const desiredTags = { ...news.tags, ...(yield* createInternalTags(id)) };
      let observed = yield* get(subscriptionId, news.resourceGroupName, name);
      if (observed) {
        const deployedStorage =
          observed.properties?.functionAppConfig?.deployment?.storage?.value;
        if (
          deployedStorage &&
          deployedStorage.replace(/\/$/, "").toLowerCase() !==
            desiredConfig.deployment?.storage?.value?.toLowerCase()
        )
          return yield* new FunctionAppInvalidDependency({
            id: news.deploymentContainerId,
          });
      }
      if (!observed) {
        const plan = segments(news.planId, "plan");
        if (!plan)
          return yield* new FunctionAppInvalidDependency({ id: news.planId });
        const livePlan = yield* web.GetAppServicePlan({
          subscriptionId: plan.subscriptionId,
          resourceGroupName: plan.resourceGroupName,
          name: plan.name,
        });
        if (livePlan.properties?.numberOfSites)
          return yield* new FunctionAppPlanInUse({ planId: news.planId });
        yield* web
          .WebAppsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: news.resourceGroupName,
            name,
            location: news.location ?? location,
            kind: "functionapp,linux",
            identity: { type: "SystemAssigned" },
            tags: desiredTags,
            properties: {
              serverFarmId: news.planId,
              reserved: true,
              httpsOnly: true,
              functionAppConfig: desiredConfig,
              siteConfig: {
                appSettings: [
                  {
                    name: "AzureWebJobsStorage__accountName",
                    value: storage.name,
                  },
                  {
                    name: "AzureWebJobsStorage__credential",
                    value: "managedidentity",
                  },
                ],
              },
            },
          })
          .pipe(Effect.catchTag("ResourceConflict", () => Effect.void));
        observed = yield* waitReady(
          subscriptionId,
          news.resourceGroupName,
          name,
        );
      }
      // `read` gates foreign sites behind explicit adoption. Once adopted,
      // reconcile their observed tags and settings like any owned site.
      const changes = diffTags(tagRecord(observed.tags), desiredTags);
      if (
        changes.upsert.length ||
        changes.removed.length ||
        observed.identity?.type !== "SystemAssigned" ||
        observed.properties?.httpsOnly !== true ||
        observed.properties?.functionAppConfig?.runtime?.name !== "node" ||
        observed.properties?.functionAppConfig?.runtime?.version !== "22" ||
        observed.properties?.functionAppConfig?.scaleAndConcurrency
          ?.instanceMemoryMB !== 2048 ||
        observed.properties?.functionAppConfig?.scaleAndConcurrency
          ?.maximumInstanceCount !== 100 ||
        observed.properties?.functionAppConfig?.deployment?.storage?.value !==
          desiredConfig.deployment?.storage?.value ||
        observed.properties?.functionAppConfig?.deployment?.storage
          ?.authentication?.type !== "SystemAssignedIdentity"
      ) {
        yield* web.WebAppsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: news.resourceGroupName,
          name,
          location: observed.location,
          kind: observed.kind ?? "functionapp,linux",
          identity: { type: "SystemAssigned" },
          tags: desiredTags,
          properties: {
            serverFarmId: news.planId,
            reserved: true,
            httpsOnly: true,
            functionAppConfig: {
              ...observed.properties?.functionAppConfig,
              ...desiredConfig,
            },
          },
        });
        observed = yield* waitReady(
          subscriptionId,
          news.resourceGroupName,
          name,
        );
      }
      const desired: Record<string, string> = {
        AzureWebJobsStorage__accountName: storage.name,
        AzureWebJobsStorage__credential: "managedidentity",
        ALCHEMY_STACK_NAME: stack.name,
        ALCHEMY_STAGE: stack.stage,
        ALCHEMY_PHASE: "runtime",
        ...Object.fromEntries(
          Object.entries(news.env ?? {}).map(([key, value]) => [
            key,
            packEnvValue(value),
          ]),
        ),
        ...Object.fromEntries(
          (bindings ?? []).flatMap((binding) =>
            Object.entries(binding.data?.env ?? {}).map(([key, value]) => [
              key,
              packEnvValue(value),
            ]),
          ),
        ),
      };
      const currentSettings =
        (yield* web
          .ListWebAppApplicationSettings({
            subscriptionId,
            resourceGroupName: news.resourceGroupName,
            name,
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "ResourceConflict",
              schedule: Schedule.spaced("3 seconds"),
              times: 8,
            }),
          )).properties ?? {};
      const next = { ...currentSettings, ...desired };
      for (const key of Object.keys(olds?.env ?? {}))
        if (!(key in desired)) delete next[key];
      if (
        Object.keys(next).some((key) => next[key] !== currentSettings[key]) ||
        Object.keys(currentSettings).some((key) => !(key in next))
      ) {
        yield* web
          .UpdateWebAppApplicationSettings({
            subscriptionId,
            resourceGroupName: news.resourceGroupName,
            name,
            properties: next,
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "ResourceConflict",
              schedule: Schedule.spaced("3 seconds"),
              times: 8,
            }),
          );
      }
      return attrs(
        subscriptionId,
        news.resourceGroupName,
        name,
        observed,
        news.storageAccountId,
        news.deploymentContainerId,
      );
    }),
    delete: Effect.fn(function* ({ id, output }) {
      const site = yield* get(
        output.subscriptionId,
        output.resourceGroupName,
        output.name,
      );
      if (!site) return;
      if (!(yield* hasAlchemyTags(id, site.tags)))
        return yield* new FunctionAppUnowned({ name: output.name });
      if (site.properties?.state !== "Stopped") {
        yield* web
          .StopWebApp({
            subscriptionId: output.subscriptionId,
            resourceGroupName: output.resourceGroupName,
            name: output.name,
          })
          .pipe(
            Effect.catchTag(
              ["ResourceNotFound", "ResourceGroupNotFound"],
              () => Effect.void,
            ),
          );
      }
      yield* web
        .DeleteWebApp({
          subscriptionId: output.subscriptionId,
          resourceGroupName: output.resourceGroupName,
          name: output.name,
          deleteEmptyServerFarm: false,
        })
        .pipe(
          Effect.catchTag(
            ["ResourceNotFound", "ResourceGroupNotFound"],
            () => Effect.void,
          ),
        );
      yield* get(
        output.subscriptionId,
        output.resourceGroupName,
        output.name,
      ).pipe(
        Effect.flatMap((current) =>
          current
            ? Effect.fail(new FunctionAppNotReady({ name: output.name }))
            : Effect.void,
        ),
        Effect.retry({
          while: (error) => error._tag === "Azure.FunctionAppNotReady",
          schedule: Schedule.spaced("4 seconds"),
          times: 10,
        }),
      );
    }),
  });
