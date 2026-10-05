import { createHash } from "node:crypto";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";

export interface RoleAssignmentProps {
  /** ARM resource ID to grant access to. */
  scope: string;
  /** Object ID of a user, service principal, or managed identity. */
  principalId: string;
  /** Fully qualified ARM role definition ID. */
  roleDefinitionId: string;
}

export type RoleAssignment = Resource<
  "Azure.Authorization.RoleAssignment",
  RoleAssignmentProps,
  {
    /** ARM role assignment ID. */
    id: string;
    /** Deterministic GUID of this assignment. */
    name: string;
    /** Scope of the grant. */
    scope: string;
    /** Granted identity. */
    principalId: string;
    /** Granted role. */
    roleDefinitionId: string;
  },
  never,
  Providers
>;

/**
 * Grant an Azure identity a role at a specific ARM scope.
 *
 * ### Granting Storage Access
 * **Example:** Grant a Function App identity Blob access
 * ```typescript
 * const grant = yield* Azure.Authorization.RoleAssignment("BlobAccess", {
 *   scope: account.id,
 *   principalId: app.principalId,
 *   roleDefinitionId: Output.interpolate`/subscriptions/${account.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe`,
 * });
 * ```
 *
 * @resource
 * @category Authorization
 */
export const RoleAssignment = Resource<RoleAssignment>(
  "Azure.Authorization.RoleAssignment",
);

export class RoleAssignmentUnowned extends Data.TaggedError(
  "Azure.RoleAssignmentUnowned",
)<{
  name: string;
}> {}

export class RoleAssignmentNotReady extends Data.TaggedError(
  "Azure.RoleAssignmentNotReady",
)<{
  name: string;
}> {}

const identity = (id: string, props: RoleAssignmentProps) =>
  Effect.sync(() => {
    const hex = createHash("sha256")
      .update(
        JSON.stringify([
          id,
          props.scope.toLowerCase(),
          props.principalId.toLowerCase(),
          props.roleDefinitionId.toLowerCase(),
        ]),
      )
      .digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  });

const ownership = (id: string) =>
  createInternalTags(id).pipe(
    Effect.map((tags) =>
      JSON.stringify([
        tags["alchemy::stack"],
        tags["alchemy::stage"],
        tags["alchemy::id"],
      ]),
    ),
  );

const get = (scope: string, name: string) =>
  authorization
    .GetRoleAssignment({ scope, roleAssignmentName: name })
    .pipe(
      Effect.catchTag(["ResourceNotFound", "RoleAssignmentNotFound"], () =>
        Effect.succeed(undefined),
      ),
    );

const attrs = (
  scope: string,
  name: string,
  principalId: string,
  roleDefinitionId: string,
  observed: authorization.GetRoleAssignmentResponse,
) => ({
  id:
    observed.id ??
    `${scope}/providers/Microsoft.Authorization/roleAssignments/${name}`,
  name,
  scope,
  principalId,
  roleDefinitionId,
});

export const RoleAssignmentProvider = () =>
  Provider.succeed(RoleAssignment, {
    stables: ["id", "name", "scope", "principalId", "roleDefinitionId"],
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news)) return undefined;
      if (
        olds &&
        (news.scope.toLowerCase() !== olds.scope.toLowerCase() ||
          news.principalId.toLowerCase() !== olds.principalId.toLowerCase() ||
          news.roleDefinitionId.toLowerCase() !==
            olds.roleDefinitionId.toLowerCase())
      )
        return { action: "replace" as const, deleteFirst: true };
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const props = olds ?? output;
      // An interrupted host create can leave this dependent grant registered
      // before the principal ID has resolved; no assignment could exist yet.
      if (!props?.scope || !props.principalId || !props.roleDefinitionId)
        return undefined;
      const name = output?.name ?? (yield* identity(id, props));
      const observed = yield* get(props.scope, name);
      if (!observed) return undefined;
      const result = attrs(
        props.scope,
        name,
        props.principalId,
        props.roleDefinitionId,
        observed,
      );
      return observed.properties?.description === (yield* ownership(id))
        ? result
        : Unowned(result);
    }),
    reconcile: Effect.fn(function* ({ id, news }) {
      const name = yield* identity(id, news);
      const description = yield* ownership(id);
      let observed = yield* get(news.scope, name);
      if (observed && observed.properties?.description !== description)
        return yield* new RoleAssignmentUnowned({ name });
      if (!observed) {
        yield* authorization
          .CreateRoleAssignment({
            scope: news.scope,
            roleAssignmentName: name,
            properties: {
              principalId: news.principalId,
              roleDefinitionId: news.roleDefinitionId,
              description,
            },
          })
          .pipe(Effect.catchTag("ResourceConflict", () => Effect.void));
        observed = yield* get(news.scope, name).pipe(
          Effect.flatMap((value) =>
            value
              ? Effect.succeed(value)
              : Effect.fail(new RoleAssignmentNotReady({ name })),
          ),
          Effect.retry({
            while: (error) => error._tag === "Azure.RoleAssignmentNotReady",
            schedule: Schedule.spaced("3 seconds"),
            times: 8,
          }),
        );
      }
      return attrs(
        news.scope,
        name,
        news.principalId,
        news.roleDefinitionId,
        observed,
      );
    }),
    delete: Effect.fn(function* ({ id, output }) {
      const observed = yield* get(output.scope, output.name);
      if (!observed) return;
      if (observed.properties?.description !== (yield* ownership(id)))
        return yield* new RoleAssignmentUnowned({ name: output.name });
      yield* authorization
        .DeleteRoleAssignment({
          scope: output.scope,
          roleAssignmentName: output.name,
        })
        .pipe(
          Effect.catchTag(
            ["ResourceNotFound", "RoleAssignmentNotFound"],
            () => Effect.void,
          ),
        );
      yield* get(output.scope, output.name).pipe(
        Effect.flatMap((value) =>
          value
            ? Effect.fail(new RoleAssignmentNotReady({ name: output.name }))
            : Effect.void,
        ),
        Effect.retry({
          while: (error) => error._tag === "Azure.RoleAssignmentNotReady",
          schedule: Schedule.spaced("3 seconds"),
          times: 8,
        }),
      );
    }),
  });
