// node --test tests/parse-model.test.mjs
// src/parse-model.ts with three.js's real loaders, no renderer.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { isModelFile, parseModel } from '../src/parse-model.ts'

const bytes = path => {
  const b = readFileSync(new URL(path, import.meta.url))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}

test('a meshopt-compressed GLB (Tripo’s compress: "geometry") opens', async () => {
  // fixtures/meshopt-cube.glb requires EXT_meshopt_compression: without the decoder GLTFLoader refuses it.
  const { root, clips } = await parseModel(bytes('fixtures/meshopt-cube.glb'), 'pbr_model.glb')
  const meshes = []
  root.traverse(node => node.isMesh && meshes.push(node))
  assert.equal(meshes.length, 1)
  assert.equal(meshes[0].geometry.index.count / 3, 12)
  assert.deepEqual([...meshes[0].geometry.attributes.position.array.slice(0, 3)], [-1, -1, -1])
  assert.deepEqual(clips, [])
})

test('a glTF that needs files beside it, and formats the viewer does not draw, are refused with a reason', async () => {
  const gltf = new TextEncoder().encode(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'model.bin', byteLength: 4 }] }))
  await assert.rejects(parseModel(gltf.buffer, 'model.gltf'), /references external files/)
  await assert.rejects(parseModel(new ArrayBuffer(8), 'model.obj'), /No 3D preview for \.obj files/)
})

test('the viewer opens GLB, glTF and FBX files only', () => {
  for (const name of ['pbr_model.glb', 'MODEL.GLB', 'scene.gltf', 'rig.fbx', '/out/a.glb?x=1']) assert.ok(isModelFile(name), name)
  for (const name of ['preview.png', 'model.obj', 'model.usdz', 'task.json', 'glb']) assert.ok(!isModelFile(name), name)
})
