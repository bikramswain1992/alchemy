import * as web from "@distilled.cloud/azure/web";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  stripInternalTags,
  tagRecord,
} from "../../Tags.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

export interface AppServicePlanProps {
  /** Name of the resource group that contains this plan. */
  resourceGroupName: string;
  /** Plan name, generated when omitted. */
  name?: string;
  /** Azure region. */
  location?: string;
  /** User tags. */
  tags?: Record<string, string>;
}

export type AppServicePlan = Resource<
  "Azure.Web.AppServicePlan",
  AppServicePlanProps,
  {
    /** ARM identifier for attaching one Flex Function App. */
    id: string;
    /** Plan name. */
    name: string;
    /** Subscription identifier. */
    subscriptionId: string;
    /** Resource group name. */
    resourceGroupName: string;
    /** Location. */
    location: string;
    /** User tags. */
    tags: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * Linux FC1 Flex Consumption hosting plan for one Azure Function App.
 *
 * ### Creating a Flex Plan
 * **Example:** Host a Function App
 * ```typescript
 * const plan = yield* Azure.Web.AppServicePlan("Plan", {
 *   resourceGroupName: group.name,
 * });
 * ```
 *
 * @resource
 * @category Web
 */
export const AppServicePlan = Resource<AppServicePlan>(
  "Azure.Web.AppServicePlan",
);

export class AppServicePlanNotReady extends Data.TaggedError(
  "Azure.AppServicePlanNotReady",
)<{
  name: string;
}> {}

export class AppServicePlanInUse extends Data.TaggedError(
  "Azure.AppServicePlanInUse",
)<{
  name: string;
}> {}

export class AppServicePlanUnowned extends Data.TaggedError(
  "Azure.AppServicePlanUnowned",
)<{
  name: string;
}> {}

const get = (subscriptionId: string, resourceGroupName: string, name: string) =>
  web
    .GetAppServicePlan({ subscriptionId, resourceGroupName, name })
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
    Effect.flatMap((plan) =>
      plan &&
      (!plan.properties?.provisioningState ||
        plan.properties.provisioningState === "Succeeded")
        ? Effect.succeed(plan)
        : Effect.fail(new AppServicePlanNotReady({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "Azure.AppServicePlanNotReady",
      schedule: Schedule.spaced("3 seconds"),
      times: 10,
    }),
  );

const attrs = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
  observed: web.GetAppServicePlanResponse,
) => ({
  id:
    observed.id ??
    `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.Web/serverfarms/${name}`,
  name,
  subscriptionId,
  resourceGroupName,
  location: observed.location,
  tags: stripInternalTags(tagRecord(observed.tags)),
});

export const AppServicePlanProvider = () =>
  Provider.succeed(AppServicePlan, {
    stables: ["id", "name", "subscriptionId", "resourceGroupName"],
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      if (
        (news.name && news.name !== (olds?.name ?? output?.name)) ||
        (output && news.resourceGroupName !== output.resourceGroupName) ||
        (news.location &&
          output?.location &&
          news.location.toLowerCase() !== output.location.toLowerCase())
      )
        return { action: "replace" as const, deleteFirst: true };
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName =
        olds?.resourceGroupName ?? output?.resourceGroupName;
      if (!resourceGroupName) return undefined;
      const name =
        olds?.name ??
        output?.name ??
        (yield* createPhysicalName({ id, maxLength: 40, lowercase: true }));
      const observed = yield* get(subscriptionId, resourceGroupName, name);
      if (!observed) return undefined;
      const result = attrs(subscriptionId, resourceGroupName, name, observed);
      return (yield* hasAlchemyTags(id, observed.tags))
        ? result
        : Unowned(result);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId, location } = yield* AzureEnvironment.current;
      const resourceGroupName = news.resourceGroupName;
      const name =
        news.name ??
        output?.name ??
        (yield* createPhysicalName({ id, maxLength: 40, lowercase: true }));
      const desiredTags = { ...news.tags, ...(yield* createInternalTags(id)) };
      let observed = yield* get(subscriptionId, resourceGroupName, name);
      if (!observed) {
        yield* web
          .AppServicePlansCreateOrUpdate({
            subscriptionId,
            resourceGroupName,
            name,
            location: news.location ?? location,
            kind: "linux",
            sku: { name: "FC1", tier: "FlexConsumption" },
            properties: { reserved: true },
            tags: desiredTags,
          })
          .pipe(Effect.catchTag("ResourceConflict", () => Effect.void));
        observed = yield* waitReady(subscriptionId, resourceGroupName, name);
      }
      const { upsert, removed } = diffTags(
        tagRecord(observed.tags),
        desiredTags,
      );
      if (upsert.length || removed.length) {
        yield* web.AppServicePlansCreateOrUpdate({
          subscriptionId,
          resourceGroupName,
          name,
          location: observed.location,
          kind: observed.kind ?? "linux",
          sku: observed.sku,
          properties: { reserved: true },
          tags: desiredTags,
        });
        observed = yield* waitReady(subscriptionId, resourceGroupName, name);
      }
      return attrs(subscriptionId, resourceGroupName, name, observed);
    }),
    delete: Effect.fn(function* ({ id, output }) {
      const observed = yield* get(
        output.subscriptionId,
        output.resourceGroupName,
        output.name,
      );
      if (!observed) return;
      if (!(yield* hasAlchemyTags(id, observed.tags)))
        return yield* new AppServicePlanUnowned({ name: output.name });
      if (observed.properties?.numberOfSites)
        return yield* new AppServicePlanInUse({ name: output.name });
      yield* web
        .DeleteAppServicePlan({
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
      yield* get(
        output.subscriptionId,
        output.resourceGroupName,
        output.name,
      ).pipe(
        Effect.flatMap((plan) =>
          plan
            ? Effect.fail(new AppServicePlanNotReady({ name: output.name }))
            : Effect.void,
        ),
        Effect.retry({
          while: (error) => error._tag === "Azure.AppServicePlanNotReady",
          schedule: Schedule.spaced("3 seconds"),
          times: 10,
        }),
      );
    }),
  });
