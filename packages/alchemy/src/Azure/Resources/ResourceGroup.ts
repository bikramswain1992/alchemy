import * as resources from "@distilled.cloud/azure/resources";
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

export interface ResourceGroupProps {
  /** Azure resource group name. Generated from the stack and logical ID when omitted. Changing it replaces the group. */
  name?: string;
  /** Location of the resource group's metadata. Changing it replaces the group. */
  location?: string;
  /** User-defined Azure tags. Alchemy ownership tags are added automatically. */
  tags?: Record<string, string>;
}

export type ResourceGroup = Resource<
  "Azure.Resources.ResourceGroup",
  ResourceGroupProps,
  {
    /** Fully qualified ARM resource ID. */
    id: string;
    /** Resource group name. */
    name: string;
    /** Azure subscription ID. */
    subscriptionId: string;
    /** Metadata location. */
    location: string;
    /** User-defined tags, excluding Alchemy ownership tags. */
    tags: Record<string, string>;
  },
  never,
  Providers
>;

/**
 * A subscription-scoped Azure resource group. Delete refuses to remove a
 * nonempty group, so foreign or independently owned resources stay intact.
 * To reference an existing group without adopting its lifecycle, pass its
 * name to a child resource instead of declaring a `ResourceGroup`.
 *
 * ### Creating a Resource Group
 * **Example:** Create with generated name and user tags
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("Application", {
 *   tags: { team: "platform" },
 * });
 * ```
 *
 * @resource
 * @category Resources
 */
export const ResourceGroup = Resource<ResourceGroup>(
  "Azure.Resources.ResourceGroup",
);

export class ResourceGroupNotEmpty extends Data.TaggedError(
  "Azure.ResourceGroupNotEmpty",
)<{
  name: string;
}> {}

export class ResourceGroupUnowned extends Data.TaggedError(
  "Azure.ResourceGroupUnowned",
)<{
  name: string;
}> {}

export class ResourceGroupNotReady extends Data.TaggedError(
  "Azure.ResourceGroupNotReady",
)<{
  name: string;
}> {}

const groupName = (id: string, name?: string) =>
  name ? Effect.succeed(name) : createPhysicalName({ id, maxLength: 90 });

const get = (subscriptionId: string, name: string) =>
  resources
    .GetResourceGroup({ subscriptionId, resourceGroupName: name })
    .pipe(
      Effect.catchTag(
        ["ResourceGroupNotFound", "ResourceNotFound", "NotFound"],
        () => Effect.succeed(undefined),
      ),
    );

const attrs = (
  subscriptionId: string,
  observed: resources.GetResourceGroupResponse,
) => ({
  id:
    observed.id ??
    `/subscriptions/${subscriptionId}/resourceGroups/${observed.name ?? ""}`,
  name: observed.name ?? "",
  subscriptionId,
  location: observed.location,
  tags: stripInternalTags(tagRecord(observed.tags)),
});

const waitForGroup = (subscriptionId: string, name: string) =>
  get(subscriptionId, name).pipe(
    Effect.flatMap((observed) =>
      observed === undefined
        ? Effect.fail(new ResourceGroupNotReady({ name }))
        : Effect.succeed(observed),
    ),
    Effect.retry({
      while: (error) => error._tag === "Azure.ResourceGroupNotReady",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

export const ResourceGroupProvider = () =>
  Provider.succeed(ResourceGroup, {
    stables: ["id", "name", "subscriptionId"],
    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      if (
        (news.name && news.name !== (olds?.name ?? output?.name)) ||
        (news.location &&
          output?.location &&
          news.location.toLowerCase() !== output.location.toLowerCase())
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = yield* groupName(id, olds?.name ?? output?.name);
      const observed = yield* get(subscriptionId, name);
      if (!observed) return undefined;
      const result = attrs(subscriptionId, observed);
      return (yield* hasAlchemyTags(id, observed.tags))
        ? result
        : Unowned(result);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId, location: defaultLocation } =
        yield* AzureEnvironment.current;
      const name = yield* groupName(id, news.name ?? output?.name);
      const desiredTags = { ...news.tags, ...(yield* createInternalTags(id)) };
      let observed = yield* get(subscriptionId, name);
      if (!observed) {
        yield* resources
          .ResourceGroupsCreateOrUpdate({
            subscriptionId,
            resourceGroupName: name,
            location: news.location ?? defaultLocation,
            tags: desiredTags,
          })
          .pipe(
            Effect.catchTag(
              ["ResourceConflict", "Conflict"],
              () => Effect.void,
            ),
          );
        observed = yield* waitForGroup(subscriptionId, name);
      }
      const { upsert, removed } = diffTags(
        tagRecord(observed.tags),
        desiredTags,
      );
      if (upsert.length || removed.length) {
        yield* resources.ResourceGroupsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: name,
          location: observed.location,
          tags: desiredTags,
        });
        observed = yield* waitForGroup(subscriptionId, name);
      }
      return attrs(subscriptionId, observed);
    }),
    delete: Effect.fn(function* ({ id, output }) {
      const observed = yield* get(output.subscriptionId, output.name);
      if (!observed) return;
      if (!(yield* hasAlchemyTags(id, observed.tags))) {
        return yield* new ResourceGroupUnowned({ name: output.name });
      }
      // ARM DELETE recursively destroys *every* resource, including foreign assets.
      // A single unowned (or not-yet-cleaned-up) child must prevent that.
      const children = yield* resources.ListResourceByResourceGroup({
        subscriptionId: output.subscriptionId,
        resourceGroupName: output.name,
        _top: 1,
      });
      if (children.value.length || children.nextLink)
        return yield* new ResourceGroupNotEmpty({ name: output.name });
      yield* resources
        .DeleteResourceGroup({
          subscriptionId: output.subscriptionId,
          resourceGroupName: output.name,
        })
        .pipe(
          Effect.catchTag(
            ["ResourceGroupNotFound", "ResourceNotFound", "NotFound"],
            () => Effect.void,
          ),
        );
      yield* get(output.subscriptionId, output.name).pipe(
        Effect.flatMap((group) =>
          group === undefined
            ? Effect.void
            : Effect.fail(new ResourceGroupNotReady({ name: output.name })),
        ),
        Effect.retry({
          while: (error) => error._tag === "Azure.ResourceGroupNotReady",
          times: 8,
          schedule: Schedule.spaced("6 seconds"),
        }),
      );
    }),
  });
