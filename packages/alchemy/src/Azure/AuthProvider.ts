import * as Clock from "effect/Clock";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { AuthError, AuthProviderLayer } from "../Auth/AuthProvider.ts";
import { getEnv, getEnvRedacted, mapPromptCancellation } from "../Auth/Env.ts";
import * as Interaction from "../Interaction.ts";
import { parseAzureCliAccessToken } from "./CliToken.ts";
import { DEFAULT_AZURE_LOCATION } from "./Environment.ts";

export const AZURE_AUTH_PROVIDER_NAME = "Azure";

export const AzureAuthConfigSchema = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("cli"),
    subscriptionId: Schema.optionalKey(Schema.String),
    location: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    method: Schema.Literal("servicePrincipal"),
    subscriptionId: Schema.String,
    tenantId: Schema.String,
    clientId: Schema.String,
    clientSecret: Schema.String,
    location: Schema.optionalKey(Schema.String),
  }),
]);
export type AzureAuthConfig = typeof AzureAuthConfigSchema.Type;

export interface AzureResolvedCredentials {
  readonly bearerToken: Redacted.Redacted<string>;
  readonly subscriptionId: string;
  readonly tenantId?: string;
  readonly apiBaseUrl: string;
  readonly location: string;
  readonly source: "cli" | "servicePrincipal";
}

const BASE_URL = "https://management.azure.com";
const EXPIRY_SKEW = 5 * 60 * 1000;

/** The Azure CLI maintains its own renewable login; ask it for a current ARM token. */
export const cliToken = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const executable = yield* Effect.sync(() =>
    process.platform === "win32" ? "az.cmd" : "az",
  );
  const child = yield* spawner.spawn(
    ChildProcess.make(
      executable,
      [
        "account",
        "get-access-token",
        "--resource",
        BASE_URL + "/",
        "--output",
        "json",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    ),
  );
  const { stdout, stderr, exitCode } = yield* Effect.all(
    {
      stdout: child.stdout.pipe(Stream.decodeText, Stream.mkString),
      stderr: child.stderr.pipe(Stream.decodeText, Stream.mkString),
      exitCode: child.exitCode,
    },
    { concurrency: "unbounded" },
  );
  if (exitCode !== 0) {
    return yield* new AuthError({
      message: `Azure CLI could not acquire a token: ${stderr.trim()}`,
    });
  }
  const now = yield* Clock.currentTimeMillis;
  return yield* Effect.try({
    try: () => parseAzureCliAccessToken(stdout, now),
    catch: (cause) =>
      new AuthError({
        message: "Azure CLI returned an invalid ARM token",
        cause,
      }),
  });
}).pipe(
  Effect.scoped,
  Effect.timeout("20 seconds"),
  Effect.mapError(
    (cause) =>
      new AuthError({
        message: "Could not acquire Azure CLI credentials",
        cause,
      }),
  ),
  Effect.provide(BunServices.layer),
);

export const cliAccount = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const executable = yield* Effect.sync(() =>
    process.platform === "win32" ? "az.cmd" : "az",
  );
  const child = yield* spawner.spawn(
    ChildProcess.make(executable, ["account", "show", "--output", "json"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const { stdout, exitCode } = yield* Effect.all(
    {
      stdout: child.stdout.pipe(Stream.decodeText, Stream.mkString),
      stderr: child.stderr.pipe(Stream.decodeText, Stream.mkString),
      exitCode: child.exitCode,
    },
    { concurrency: "unbounded" },
  );
  if (exitCode !== 0)
    return yield* new AuthError({
      message: "Azure CLI account not available. Run az login.",
    });
  return yield* Effect.try({
    try: () => {
      const account: unknown = JSON.parse(stdout);
      if (
        account === null ||
        typeof account !== "object" ||
        !("id" in account) ||
        typeof account.id !== "string" ||
        !account.id
      )
        throw new Error("missing subscription id");
      return {
        subscriptionId: account.id,
        tenantId:
          "tenantId" in account && typeof account.tenantId === "string"
            ? account.tenantId
            : undefined,
      };
    },
    catch: (cause) =>
      new AuthError({
        message: "Azure CLI account has no subscription ID",
        cause,
      }),
  });
}).pipe(
  Effect.scoped,
  Effect.timeout("20 seconds"),
  Effect.mapError(
    (cause) =>
      new AuthError({ message: "Could not read Azure CLI account", cause }),
  ),
  Effect.provide(BunServices.layer),
);

const servicePrincipalToken = (
  tenantId: string,
  clientId: string,
  clientSecret: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    const provided = yield* Effect.serviceOption(HttpClient.HttpClient);
    const http = Option.isSome(provided)
      ? provided.value
      : yield* HttpClient.HttpClient.pipe(
          Effect.provide(FetchHttpClient.layer),
        );
    const response = yield* http
      .execute(
        HttpClientRequest.post(
          `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
        ).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: Redacted.value(clientSecret),
            scope: `${BASE_URL}/.default`,
          }),
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new AuthError({
              message: "Azure service principal token request failed",
              cause,
            }),
        ),
      );
    if (response.status !== 200)
      return yield* new AuthError({
        message: `Azure service principal token request failed (HTTP ${response.status})`,
      });
    const body: unknown = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({
            message: "Azure token response was not JSON",
            cause,
          }),
      ),
    );
    if (
      body === null ||
      typeof body !== "object" ||
      !("access_token" in body) ||
      typeof body.access_token !== "string" ||
      !body.access_token ||
      !("expires_in" in body) ||
      typeof body.expires_in !== "number"
    ) {
      return yield* new AuthError({
        message:
          "Azure token response did not include an access token and expiry",
      });
    }
    const now = yield* Clock.currentTimeMillis;
    return {
      token: body.access_token,
      expiresAt: now + body.expires_in * 1000,
    };
  });

export const AzureAuth = AuthProviderLayer<
  AzureAuthConfig,
  AzureResolvedCredentials
>()(
  AZURE_AUTH_PROVIDER_NAME,
  Effect.gen(function* () {
    const tokenCache = yield* Ref.make<
      { key: string; token: string; expiresAt: number } | undefined
    >(undefined);
    const cachedToken = (
      key: string,
      acquire: Effect.Effect<{ token: string; expiresAt: number }, AuthError>,
    ) =>
      Effect.gen(function* () {
        const cached = yield* Ref.get(tokenCache);
        const now = yield* Clock.currentTimeMillis;
        if (cached?.key === key && cached.expiresAt - now > EXPIRY_SKEW)
          return Redacted.make(cached.token);
        const fresh = yield* acquire;
        yield* Ref.set(tokenCache, { key, ...fresh });
        return Redacted.make(fresh.token);
      });
    const resolve = (config: AzureAuthConfig) =>
      Effect.gen(function* () {
        if (config.method === "cli") {
          const account = yield* cliAccount;
          const subscriptionId =
            config.subscriptionId ?? account.subscriptionId;
          return {
            bearerToken: yield* cachedToken(`cli:${subscriptionId}`, cliToken),
            subscriptionId,
            tenantId: account.tenantId,
            apiBaseUrl: BASE_URL,
            location: config.location ?? DEFAULT_AZURE_LOCATION,
            source: "cli" as const,
          };
        }
        return {
          bearerToken: yield* cachedToken(
            `sp:${config.tenantId}:${config.clientId}:${config.subscriptionId}`,
            servicePrincipalToken(
              config.tenantId,
              config.clientId,
              Redacted.make(config.clientSecret),
            ),
          ),
          subscriptionId: config.subscriptionId,
          tenantId: config.tenantId,
          apiBaseUrl: BASE_URL,
          location: config.location ?? DEFAULT_AZURE_LOCATION,
          source: "servicePrincipal" as const,
        };
      });
    const readEnvironment = Effect.gen(function* () {
      const subscriptionId = yield* getEnv("AZURE_SUBSCRIPTION_ID");
      const tenantId = yield* getEnv("AZURE_TENANT_ID");
      const clientId = yield* getEnv("AZURE_CLIENT_ID");
      const clientSecret = yield* getEnvRedacted("AZURE_CLIENT_SECRET");
      const location = yield* getEnv("AZURE_LOCATION");
      if (!subscriptionId || !tenantId || !clientId || !clientSecret)
        return yield* new AuthError({
          message:
            "Set AZURE_SUBSCRIPTION_ID, AZURE_TENANT_ID, AZURE_CLIENT_ID and AZURE_CLIENT_SECRET for Azure CI authentication.",
        });
      return yield* resolve({
        method: "servicePrincipal",
        subscriptionId,
        tenantId,
        clientId,
        clientSecret: Redacted.value(clientSecret),
        location,
      });
    });
    return {
      configSchema: AzureAuthConfigSchema,
      configure: () =>
        Interaction.accessors.prompt
          .select({
            message: "Azure authentication method",
            options: [
              {
                value: "cli" as const,
                label: "Azure CLI (service principals use CI env variables)",
              },
            ],
          })
          .pipe(
            mapPromptCancellation,
            Effect.map(() => ({ method: "cli" as const })),
          ),
      configureMethods: [
        {
          method: "cli",
          fields: [
            {
              name: "subscriptionId",
              label: "Subscription ID",
              optional: true,
            },
            { name: "location", label: "Default location", optional: true },
          ],
        },
      ],
      configureWith: (_profile, input) =>
        input.method === "cli"
          ? Effect.succeed({
              method: "cli" as const,
              subscriptionId: input.values.subscriptionId || undefined,
              location: input.values.location || undefined,
            })
          : Effect.fail(
              new AuthError({
                message: `Unsupported Azure authentication method: ${input.method}`,
              }),
            ),
      login: (_profile, config) => resolve(config).pipe(Effect.as(config)),
      logout: () => Effect.void,
      details: (_profile, config) =>
        resolve(config).pipe(
          Effect.map(({ subscriptionId, tenantId, location, source }) => ({
            lines: [
              { key: "subscriptionId", value: subscriptionId },
              { key: "tenantId", value: tenantId ?? "" },
              { key: "location", value: location },
              { key: "source", value: source },
            ],
          })),
        ),
      read: (_profile, config) => resolve(config),
      readEnvironment,
      environment: [
        { name: "AZURE_SUBSCRIPTION_ID", required: true },
        { name: "AZURE_TENANT_ID", required: true },
        { name: "AZURE_CLIENT_ID", required: true },
        { name: "AZURE_CLIENT_SECRET", required: true, secret: true },
        { name: "AZURE_LOCATION", required: false },
      ],
    };
  }),
);
