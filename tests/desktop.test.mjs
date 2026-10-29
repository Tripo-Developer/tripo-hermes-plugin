// node --test tests/desktop.test.mjs
// Registers the real Desktop half (src/plugin.tsx, bundled by esbuild) against a stub SDK, once as a Desktop with the
// tool-media renderer seam and once as an older Desktop without it, and checks the names the docs promise.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const flush = () => new Promise(resolve => setImmediate(resolve))

// Stub modules: the SDK (with or without the seam's export) and just enough of React to register and render one level.
const sdkStub = withArea => `
  export const host = { notify() {}, navigate() {}, state: {} }
  export const PALETTE_AREA = 'palette'
  export const STATUSBAR_AREAS = { left: 'status.left', right: 'status.right' }
  export const TRANSCRIPT_DIRECTIVE_AREA = 'transcript.directive'
  ${withArea ? "export const TOOL_MEDIA_RENDERER_AREA = 'transcript.toolMedia'" : ''}
  const C = () => null
  export const Button = C, Codicon = C
`
const reactStub = `
  export const useEffect = () => {}, useCallback = f => f, useRef = v => ({ current: v }), useState = v => [typeof v === 'function' ? v() : v, () => {}]
  export const Fragment = 'Fragment'
  export const jsx = (type, props) => ({ type, props }), jsxs = jsx
`

async function loadPlugin(withArea, status = {}) {
  const stubs = {
    name: 'stubs',
    setup(b) {
      b.onResolve({ filter: /^(@hermes\/plugin-sdk|react|react\/jsx-runtime)$/ }, a => ({ path: a.path, namespace: 'stub' }))
      b.onLoad({ filter: /.*/, namespace: 'stub' }, a => ({ contents: a.path === '@hermes/plugin-sdk' ? sdkStub(withArea) : reactStub, loader: 'js' }))
    }
  }
  const out = await build({ entryPoints: [`${root}src/plugin.tsx`], bundle: true, format: 'esm', jsx: 'automatic', write: false, plugins: [stubs], logLevel: 'error' })
  const code = Buffer.from(out.outputFiles[0].contents).toString('base64')
  const plugin = (await import(`data:text/javascript;base64,${code}`)).default
  const registered = []
  const events = []
  const paths = []
  plugin.register({
    source: 'test',
    registerMany: cs => (registered.push(...cs), () => {}),
    onDispose() {},
    onEvent: type => (events.push(type), () => {}),
    rest: async path => (paths.push(path), path === 'status' ? status : {})
  })
  await flush()
  return { plugin, registered, events, paths }
}

const media = over => ({
  file: { path: '/home/me/.hermes/plugin-data/agent-plugin-tripo-ec9d55cb/tripo-out/text_to_model-a1b2c3d4/pbr_model.glb', name: 'pbr_model.glb', kind: 'file', mime: 'model/gltf-binary', resolveUrl: async () => '' },
  toolName: 'mcp__tripo__tripo_download',
  toolCallId: 'call-1',
  args: { task_id: 'a1b2c3d4-0000-4000-8000-000000000001' },
  result: '{}',
  sessionId: 's-1',
  fallback: 'BUILT-IN FILE ROW',
  ...over
})

// Render one level: the contribution's element is a component of this plugin, which picks a card or the fallback.
const pick = element => element.type(element.props)

test('a Desktop with the seam gets a model renderer for this package’s own MCP tools only', async () => {
  const { registered } = await loadPlugin(true)
  const renderers = registered.filter(c => c.area === 'transcript.toolMedia')
  assert.equal(renderers.length, 1)
  assert.deepEqual(renderers[0].data.tools, ['mcp__tripo__*'])
  const card = pick(renderers[0].data.render(media()))
  assert.equal(card.type.name, 'TranscriptCard')
  assert.equal(card.props.attrs.path, media().file.path)
  // Anything that is not a model the viewer opens keeps the built-in row.
  for (const name of ['preview.png', 'task.json', 'model.mtl', 'model.zip']) {
    const fallback = pick(renderers[0].data.render(media({ file: { ...media().file, name, path: `/tmp/${name}` } })))
    assert.equal(fallback.props.children, 'BUILT-IN FILE ROW', name)
  }
})

test('an older Desktop without the seam loads the plugin with its card, chip and commands', async () => {
  const { registered, events, paths } = await loadPlugin(false)
  assert.ok(!registered.some(c => c.area === 'transcript.toolMedia' || c.area === undefined))
  const directive = registered.find(c => c.area === 'transcript.directive')
  assert.equal(directive.data.name, 'tripo-model')
  assert.ok(registered.some(c => c.area === 'status.right' && typeof c.render === 'function'))
  assert.deepEqual(registered.filter(c => c.area === 'palette').map(c => c.data.label), ['Tripo: recent generations', 'Tripo: settings'])
  assert.deepEqual([...new Set(events)].sort(), ['plugin.tripo.settings.changed', 'tool.complete'])
  assert.deepEqual(paths, ['status'], 'registering reads the balance once and nothing else')
})

test('with inline cards turned off the directive line shows as text and model files keep the built-in row', async () => {
  const { registered } = await loadPlugin(true, { configured: false, settings: { inline_viewer: false } })
  const directive = registered.find(c => c.area === 'transcript.directive')
  const source = '::tripo-model{task="a1b2c3d4-0000-4000-8000-000000000001"}'
  const shown = pick(directive.data.render({ attrs: { task: 'a1b2c3d4-0000-4000-8000-000000000001' }, source, streaming: false }))
  assert.equal(shown.type, 'p')
  assert.equal(shown.props.children, source)
  const renderer = registered.find(c => c.area === 'transcript.toolMedia')
  assert.equal(pick(renderer.data.render(media())).props.children, 'BUILT-IN FILE ROW')
})

test('every theme colour comes from Desktop’s documented plugin variables (--ui-*)', async () => {
  // Desktop compiles its own --color-* tokens into its stylesheet, so a plugin reading var(--color-border) gets nothing.
  const out = await build({ entryPoints: [`${root}src/plugin.tsx`], bundle: true, format: 'esm', jsx: 'automatic', write: false, external: ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'], logLevel: 'error' })
  const code = Buffer.from(out.outputFiles[0].contents).toString()
  const used = [...new Set([...code.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]))]
  assert.ok(used.length > 3, `found ${used}`)
  assert.deepEqual(used.filter(v => !v.startsWith('--ui-')), [])
})

test('the names the README and the skill use are the ones the plugin registers', async () => {
  const { registered } = await loadPlugin(false)
  const readme = readFileSync(`${root}README.md`, 'utf8')
  const skill = readFileSync(`${root}skills/tripo-3d/SKILL.md`, 'utf8')
  const directive = registered.find(c => c.area === 'transcript.directive').data.name
  const written = new Set([...`${readme}\n${skill}`.matchAll(/::([a-z][a-z0-9-]*)\{/g)].map(m => m[1]))
  assert.deepEqual([...written], [directive])
  const labels = registered.filter(c => c.area === 'palette').map(c => c.data.label)
  for (const quoted of readme.matchAll(/"(Tripo: [^"]+)"/g)) {
    assert.ok(labels.includes(quoted[1]), `README quotes "${quoted[1]}"; registered: ${labels}`)
  }
})
