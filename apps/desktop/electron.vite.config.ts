import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite";

/**
 * Directories the dev server must never watch.
 *
 * The test suites create their scratch trees under `apps/desktop/` because they
 * need a real path on a real volume. Some of those trees hold a live Chromium
 * profile, and Chromium keeps temporary files open inside it. Vite's watcher
 * then hits `EBUSY` on such a file and emits an unhandled `error` on the
 * FSWatcher, which takes the whole dev process down with it. That is not
 * hypothetical: it killed three PI-Desktop sessions on 2026-11-10 while the
 * desktop test suites were running.
 *
 * Ignoring them is the right fix here. Moving the tests elsewhere would weaken
 * what they check (real paths, real junctions, real backup roots), and merely
 * catching the watcher error would leave the dev server watching a tree that
 * other processes rewrite underneath it.
 */
const TEST_SCRATCH_IGNORE = [
  // Every suite that creates a scratch tree under `apps/desktop/` is listed
  // here. The list is derived from the `mkdtemp(join(root, "apps/desktop/.<name>-"))`
  // calls in the suites, so a new suite has to be added here too.
  //
  // There is deliberately no catch-all for "any hidden hyphenated directory".
  // Such a rule would also swallow a real source directory -- one named
  // `.internal-docs` or `.generated-types` would silently stop being watched,
  // and the dev server would serve a stale build of it. The explicit list
  // names only the trees the suites actually create, and
  // `test/dev-watcher-ignore.test.mjs` fails when a suite adds one that is
  // not here.
  "**/.custom-provider-no-api-key-ui-*/**",
  "**/.fallback-ui-*/**",
  "**/.fast-mode-launch-test-*/**",
  "**/.isolated-launch-test-*/**",
  "**/.jev-launch-test-*/**",
  "**/.jev-service-ui-*/**",
  "**/.jev-settings-ui-*/**",
  "**/.plugin-provider-catalog-ui-*/**",
  "**/.remote-project-ui-*/**",
  "**/.worktree-menu-ui-*/**",
  "**/.artifacts/**",
];

/**
 * The workspace packages the desktop imports, resolved to their sources.
 *
 * The desktop reaches them through junctions under `node_modules/@pi-desktop`,
 * and those junctions point at the package roots. A package root is not
 * readable as source by a bundler: its manifest points `main`/`exports` at
 * `dist` (`packages/computer-use` exports `./dist/index.js`), so the bundler
 * imports the compiled output, and the watcher only sees the tree it reads.
 * A source edit therefore reached the bundle late -- only after `tsc` had
 * emitted into `dist` -- and a package the build had never emitted was
 * invisible to the desktop altogether.
 *
 * Aliasing the package entry points to their sources fixes both halves of
 * that: the bundler reads the file that was just edited, and the watcher
 * tracks it through the module graph even though it sits outside the
 * application's root directory.
 *
 * The patterns are anchored so that a package's own subpath exports keep
 * working. `@pi-desktop/agent-runtime` exports `./sidecar`,
 * `./proxy-tunnel` and `./system-proxy-relay` beside its main entry, and each
 * of those resolves to its own file; a loose prefix match would rewrite them
 * all into the main entry point.
 */
const WORKSPACE_PACKAGE_ALIASES = [
  {
    find: /^@pi-desktop\/computer-use$/,
    replacement: resolve(__dirname, "../../packages/computer-use/src/index.ts"),
  },
  {
    find: /^@pi-desktop\/agent-runtime$/,
    replacement: resolve(__dirname, "../../packages/agent-runtime/src/index.ts"),
  },
  {
    find: /^@pi-desktop\/shared$/,
    replacement: resolve(__dirname, "../../packages/shared/src/index.ts"),
  },
];

// Dev needs 'unsafe-eval' for vite HMR tooling; production must not ship it.
function tightenCsp(): Plugin {
  return {
    name: "pi-tighten-csp",
    apply: "build",
    transformIndexHtml(html) {
      return html
        .replace(" 'unsafe-eval'", "")
        .replace(
          /connect-src [^;]*;/,
          "connect-src 'self';",
        );
    },
  };
}

// Electron 43 ships a Chromium that always supports woff2, but KaTeX's
// stylesheet lists woff and truetype fallbacks for every face. Dropping those
// src entries lets Rollup tree-shake ~0.8 MB of .woff/.ttf assets it would
// otherwise emit but never serve.
function dropLegacyFontFallbacks(): Plugin {
  return {
    name: "pi-drop-legacy-font-fallbacks",
    apply: "build",
    // Must run before Vite rewrites url() into asset references, otherwise the
    // .woff/.ttf files are already registered for emission.
    enforce: "pre",
    transform(code, id) {
      if (!/\.css(?:\?.*)?$/.test(id)) return null;
      const stripped = code.replace(
        /,\s*url\([^)]+\)\s*format\("(?:woff|truetype)"\)/g,
        "",
      );
      return stripped === code ? null : { code: stripped, map: null };
    },
  };
}

export default defineConfig({
  main: {
    // `ws` loads its optional native accelerators (bufferutil, utf-8-validate)
    // inside `require` + try/catch and falls back to its own JavaScript
    // implementation when they are absent. A bundle cannot fail a require, and
    // Vite turns the unresolved optional peer into a module-level throw that
    // kills the whole Main bundle before the app starts, so state the documented
    // "no native accelerator" input to that branch at build time instead.
    define: {
      "process.env.WS_NO_BUFFER_UTIL": "\"1\"",
      "process.env.WS_NO_UTF_8_VALIDATE": "\"1\"",
      // The main bundle is ESM (`type: module`), where Node does not provide
      // the CommonJS `__dirname` global used by Electron's relative asset paths.
      "__dirname": "import.meta.dirname",
    },
    build: {
      // The main bundle is built with `build.watch`, not served by a dev
      // server, so `server.watch` does not apply to it. Rollup's watcher
      // follows the module graph, so a workspace package is picked up through
      // the source aliases below rather than through a directory list.
      rollupOptions: {
        // Bundle JS workspace packages into Main. Native voice modules must
        // resolve from packaged node_modules because their loaders locate
        // platform libraries relative to their own package directories.
        // jiti is loaded lazily by the sidecar's trusted-extension loader
        // (D387); Electron main never calls it, and its transpiled dist
        // breaks the main bundle's esbuild transform.
        external: [
          "original-fs",
          "electron-updater",
          "jiti",
          "jiti/static",
          "@picovoice/pvrecorder-node",
          "transcribe-cpp",
        ],
        input: {
          index: resolve(__dirname, "electron/main/entry.ts"),
          // Forked per plugin by PluginRuntime (ADR 0008); must stay a
          // standalone entry so utilityProcess can point at a real file.
          "plugin-host-process": resolve(__dirname, "electron/main/plugin-host-process.mjs"),
        },
      },
    },
    resolve: {
      alias: WORKSPACE_PACKAGE_ALIASES,
    },
  },

  preload: {
    // The preload must be a fully bundled CJS file so it can run in a
    // sandboxed renderer without Node module resolution.
    // Main and renderer already consume the shared source entry; this exact
    // subpath alias prevents preload from bundling a stale shared dist file.
    resolve: {
      alias: [
        {
          find: /^@pi-desktop\/shared\/protocol$/,
          replacement: resolve(__dirname, "../../packages/shared/src/protocol.ts"),
        },
      ],
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "electron/preload/index.ts"),
          "plugin-panel": resolve(__dirname, "electron/preload/plugin-panel.ts"),
        },
        output: {
          format: "cjs",
          // Main window preload stays .cjs; plugin panels use .js as referenced by panel host.
          entryFileNames: (chunk) =>
            chunk.name === "plugin-panel" ? "[name].js" : "[name].cjs",
        },
      },
    },
  },
  renderer: {
    // Tailwind and the React refresh runtime watch this same root, so the
    // scratch trees have to be ignored here too, not only on `main`.
    //
    // The watcher only follows the application's own root, so a workspace
    // package outside it is reached through the source aliases below and
    // tracked by the module graph rather than by a directory list.
    server: {
      watch: {
        ignored: TEST_SCRATCH_IGNORE,
      },
    },
    root: ".",
    build: {
      // electron-vite's renderer preset hard-defaults minify to false, unlike
      // plain Vite. Enabling esbuild minification roughly halves the emitted
      // renderer chunks with no behavior change.
      minify: "esbuild",
      rollupOptions: {
        input: {
          index: resolve(__dirname, "index.html"),
        },
      },
    },
    plugins: [react(), tailwindcss(), tightenCsp(), dropLegacyFontFallbacks()],
    resolve: {
      alias: [
        ...WORKSPACE_PACKAGE_ALIASES,
        { find: "@renderer", replacement: resolve("src") },
        { find: "@renderer", replacement: resolve("src") },
        {
          find: /^@pi-desktop\/i18n\/locales\/([^/]+)$/,
          replacement: resolve(
            __dirname,
            "../../packages/i18n/src/locales/$1/index.ts",
          ),
        },
        {
          find: "@pi-desktop/i18n/locale-info",
          replacement: resolve(
            __dirname,
            "../../packages/i18n/src/locale-info.ts",
          ),
        },
        // Always read locale source so new keys work without a stale packages/*/dist.
        {
          find: "@pi-desktop/i18n",
          replacement: resolve(__dirname, "../../packages/i18n/src/index.ts"),
        },
      ],
    },
  },
});
