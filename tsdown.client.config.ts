/**
 * VENDORED FROM: deepseek-harness @ 528c682e061696f5a160f363f236ecbf53cbd006
 *   sources:
 *   - packages/client/tsdown.client.ts
 *       regions: 22-31 (CSS virtual-id prefixes — the ids must not end in
 *                `.css`, tsdown's own guard would take them),
 *                33-53 (styleInjectionModule: tagged <style> injector +
 *                hashed class-map module),
 *                427-436 (escapeSpecifier / matchesSpecifier),
 *                437-567 (clientConfig: cjs closure-factory artifact —
 *                entry/outDir/format/platform/sourcemap/clean, module-edge
 *                deps, purity gate, the three CSS plugins, the
 *                NODE_ENV/import.meta.env defines, and the banner/footer/
 *                intro handoff into window.__ModuleLoader__.load)
 *   - packages/client/web/src/platform.ts
 *       regions: 8-17 (PLATFORM_MODULES + PRELOADED_CLIENT_EXTERNALS, the
 *                shell-seeded module-table baseline)
 *   - packages/client/modules/src/client/manifest.ts
 *       region: 119-125 (optionalStringArray — dsh.client.external shape
 *                validation)
 *   copied:  2026-08-21
 *
 * This is the external-plugin replica of the harness client-bundle preset:
 * dsh plugins cannot import packages/client/tsdown.client.ts, so the
 * artifact contract is reproduced here and driven by `tsdown -c
 * tsdown.client.config.ts` (npm script build:client). Adaptations are
 * marked [fork:adapt] below; the build contract itself (bytes of
 * banner/footer/intro, external set, defines, css-module behavior) is
 * unchanged.
 *
 * Upstream license (preserved): the copied code is
 * Copyright (c) DeepSeek, licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/**
 * [fork:adapt] upstream reads PLATFORM_MODULES + PRELOADED_CLIENT_EXTERNALS
 * from packages/client/web/src/platform.ts; an external plugin cannot
 * import that file, so the lists are copied verbatim from platform.ts:8-17
 * of the same commit. Keep them in sync with the harness version the host
 * runs — the loader module table can only answer these exact keys.
 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  'zod', '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

const PRELOADED_CLIENT_EXTERNALS = [] as const

/** The plugin id stamped into the loader handoff and the injected style tags. */
const PLUGIN_ID = 'dsh-session-fork'

/**
 * [fork:adapt] upstream locates the package manifest through the repository
 * workspace glob (workspaceManifest); this plugin reads its own package.json
 * from the config file's directory instead. The dsh.client.external request
 * validation is vendored from modules/src/client/manifest.ts:119-125.
 */
const MANIFEST = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as {
  readonly dsh?: { readonly client?: { readonly external?: unknown } }
}

function optionalStringArray(subject: string, field: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`client-modules: ${subject} ${field} must be a string array`)
  }
  return value as string[]
}

/** Module-table specifiers this package's client bundle may leave as requires. */
const requested = new Set([
  ...PLATFORM_MODULES,
  ...PRELOADED_CLIENT_EXTERNALS,
  ...(optionalStringArray(PLUGIN_ID, 'dsh.client.external', MANIFEST.dsh?.client?.external) ?? []),
])

const isRequested = (specifier: string): boolean => requested.has(specifier)

/**
 * Wire/type layers a client bundle may inline: browser-safe contracts with no
 * runtime identity to share (upstream tsdown.client.ts:61, kept for gate
 * fidelity; this plugin currently imports none of them).
 */
const INLINE_SAFE = /^@deepseek-ai\/dsh-(host-apiproxy|file-reference|session|llm|tools|brand)(\/|$)/

/** Vendored framework libraries (upstream tsdown.client.ts:69). */
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

/** Generated descriptor/codec contribution (upstream tsdown.client.ts:72). */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

/**
 * Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline
 * (which requires @tsdown/css). The suffix matters: tsdown's guard matches
 * ids ending in `.css`, so the virtual id must not (upstream :22-31).
 */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const GLOBAL_CSS_VIRTUAL_PREFIX = '\0dsh-global-css:'
const INLINE_CSS_VIRTUAL_PREFIX = '\0dsh-inline-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const INLINE_CSS_QUERY = '?inline'

/** Emit one plugin-owned style injector and an optional CSS Modules export (upstream :33-53). */
function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap?: Readonly<Record<string, string>>,
): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

function basename(path: string): string {
  const segments = path.split(/[\\/]/)
  return segments[segments.length - 1] ?? path
}

/**
 * [fork:adapt] upstream clientConfig is one face of a workspace build-face
 * function (host/client phases); this plugin has no workspace and builds the
 * client face explicitly via `tsdown -c tsdown.client.config.ts`, so the
 * face selection and the node-half lib configs are dropped. The browser
 * artifact contract below is otherwise the upstream clientConfig verbatim:
 * entry { client }, outDir lib, cjs, browser platform, sourcemap, clean off
 * (the node tsc build owns the rest of lib/), requested specifiers external
 * + everything else inlined, purity gate, CSS plugins, and the
 * NODE_ENV/import.meta.env defines (zustand probes import.meta.env truthily
 * and import.meta.env.MODE precisely — a CJS output carries neither, so
 * both keys plus the bare one must be defined or the factory throws
 * EMPTY_IMPORT_META/ReferenceError, upstream :463-478).
 *
 * [fork:adapt] clientBuildEnvironmentDefines (DSH_CLIENT_* static env
 * helper) is dropped: no code in this plugin reads those values yet.
 *
 * [fork:adapt] outputOptions.sourcemapPathTransform (browserSourcePath) is
 * dropped: upstream only rewrites sources that resolve inside the harness
 * repository's packages/ tree; for this plugin every relative source is
 * already browser-relative to lib/, so upstream's transform would return
 * each source unchanged — dropping it preserves that exact behavior.
 */
const config: UserConfig = {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: isRequested,
    // Anything NOT requested from the loader module table must inline — a
    // require() the table cannot answer is a guaranteed runtime throw.
    alwaysBundle: (specifier: string) => !isRequested(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    // Bundle purity gate (build-time mirror of the module-edge rules):
    // baseline/requested specifiers stay external, inline-safe wire layers
    // inline, and every other @deepseek-ai value import is a build error —
    // a cross-plugin value import either inlines a duplicate runtime
    // instance or requires a specifier the module table cannot answer.
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (isRequested(source)) return null // requested module-table row: external wins
      if (VENDORED_LIBRARY.test(source)) return null // vendored library: inline, no shared identity
      if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null // wire contribution: inline is the point
      throw new Error(
        `client bundle purity: "${source}" is not in the default client externals or ${PLUGIN_ID}'s dsh.client.external, an inline-safe wire layer, or a generated /remote contribution — `
        + 'cross-plugin value imports are forbidden; declare a non-default module request or collaborate through cordis services '
        + '(type-only imports are erased and never reach this gate)',
      )
    },
  }, {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile(path: string): void }, virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      // The virtual id otherwise hides the physical stylesheet from the watch graph.
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      const exportEntries = Object.entries(cssExports ?? {})
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      for (const [local, exp] of exportEntries) classMap[local] = exp.name
      return styleInjectionModule(PLUGIN_ID, fileId, code.toString(), classMap)
    },
  }, {
    name: 'dsh-css-text-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith(`.css${INLINE_CSS_QUERY}`)) return null
      const stylesheet = source.slice(0, -INLINE_CSS_QUERY.length)
      const abs = importer !== undefined ? sourceAssetPath(stylesheet, importer) : stylesheet
      return INLINE_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile(path: string): void }, virtualId: string) {
      if (!virtualId.startsWith(INLINE_CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(INLINE_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code } = transform({ filename: fileId, code: source, minify: true })
      return `export default ${JSON.stringify(code.toString())};`
    },
  }, {
    name: 'dsh-css-global-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
      return GLOBAL_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(this: { addWatchFile(path: string): void }, virtualId: string) {
      if (!virtualId.startsWith(GLOBAL_CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(GLOBAL_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code } = transform({ filename: fileId, code: source, minify: true })
      return styleInjectionModule(PLUGIN_ID, fileId, code.toString())
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default config

/**
 * [fork:adapt] upstream sourceAssetPath also handles the lib/types↔src
 * mapping of its tsc phase; this plugin bundles sources directly, so the
 * importer-relative resolution is the whole function.
 */
function sourceAssetPath(source: string, importer: string): string {
  return resolve(dirname(importer), source)
}
