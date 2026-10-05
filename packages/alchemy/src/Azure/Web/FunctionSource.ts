import * as Effect from "effect/Effect";
import * as Bundle from "../../Bundle/Bundle.ts";
import { findCwdForBundle, resolveMainPath } from "../../Bundle/TempRoot.ts";
import { sha256Object } from "../../Util/sha256.ts";

/** Source archive for an Effect-native Azure Functions v4 HTTP app. */
const hostJson = `${JSON.stringify(
  { version: "2.0", extensions: { http: { routePrefix: "" } } },
  null,
  2,
)}\n`;

const packageJson = `${JSON.stringify(
  {
    private: true,
    type: "module",
    main: "index.mjs",
    dependencies: { "@azure/functions": "^4.0.0" },
  },
  null,
  2,
)}\n`;

/** Generated entry: set the runtime flag before evaluating the user's module. */
export const makeFunctionBootstrap =
  (handler: string) =>
  (importPath: string): string =>
    `
import { app } from "@azure/functions";
import { makeHandler } from "alchemy/Runtime/Bootstrap/AzureFunction";

globalThis.__ALCHEMY_RUNTIME__ = true;
const entrypoint = (await import(${JSON.stringify(importPath)}))[${JSON.stringify(handler)}];

app.http("handler", {
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
  authLevel: "anonymous",
  route: "{*path}",
  handler: makeHandler(entrypoint),
});
`;

/** Bundle the entry and the Azure v4 host manifests; publishing is the caller's job. */
export const makeFunctionSource = Effect.gen(function* () {
  const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;

  const bundle = Effect.fn(function* (options: {
    main: string;
    handler?: string;
    build?: Bundle.BundleConfig;
    isExternal?: boolean;
  }) {
    const realMain = yield* resolveMainPath(options.main);
    const cwd = yield* findCwdForBundle(realMain);
    const configuredExternal = options.build?.input?.external;
    const output = yield* Bundle.build(
      {
        ...options.build?.input,
        input: realMain,
        cwd,
        platform: "node",
        // The v4 worker loads this dependency from the archive's package.json.
        // Preserve user-specified externals (including predicate externals).
        external: (id, parent, resolved) => {
          if (id === "@azure/functions") return true;
          if (typeof configuredExternal === "function") {
            return configuredExternal(id, parent, resolved);
          }
          const matchers = Array.isArray(configuredExternal)
            ? configuredExternal
            : configuredExternal === undefined
              ? []
              : [configuredExternal];
          return matchers.some((matcher) =>
            typeof matcher === "string" ? matcher === id : matcher.test(id),
          );
        },
        resolve: {
          conditionNames: [...Bundle.NODE_CONDITION_NAMES],
          ...options.build?.input?.resolve,
        },
        plugins: [
          options.build?.input?.plugins,
          options.isExternal
            ? undefined
            : virtualEntryPlugin(
                makeFunctionBootstrap(options.handler ?? "default"),
              ),
        ],
      },
      {
        ...options.build?.output,
        format: "esm",
        sourcemap: options.build?.output?.sourcemap ?? false,
        minify: options.build?.output?.minify ?? false,
        entryFileNames: "index.mjs",
      },
      options.build,
    );
    const files = [
      ...output.files.map((file) => ({
        path: file.path,
        content: file.content,
      })),
      { path: "host.json", content: hostJson },
      { path: "package.json", content: packageJson },
    ];
    const codeHash = (yield* sha256Object({
      bundle: output.hash,
      hostJson,
      packageJson,
    })).slice(0, 16);
    return { files, codeHash };
  });

  return { bundle };
});
