// node --test tests/parse-model.test.mjs
// src/parse-model.ts with three.js's real loaders, no renderer.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { Box3, BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial } from 'three'

import { indexMeshes, isModelFile, mtlLibOf, mtlTextures, parseModel, siblingPath } from '../src/parse-model.ts'

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
  await assert.rejects(parseModel(new ArrayBuffer(8), 'model.blend'), /No 3D preview for \.blend files/)
})

test('the viewer opens GLB, glTF, FBX, OBJ, STL, USDZ and 3MF files', () => {
  for (const name of ['pbr_model.glb', 'MODEL.GLB', 'scene.gltf', 'rig.fbx', 'model.obj', 'print.STL', 'scene.usdz', 'part.3mf', '/out/a.glb?x=1']) {
    assert.ok(isModelFile(name), name)
  }
  for (const name of ['preview.png', 'model.mtl', 'model.zip', 'model.blend', 'task.json', 'glb']) assert.ok(!isModelFile(name), name)
})

test('an OBJ takes its colours from the .mtl it names and is drawn as an indexed mesh', async () => {
  // A square of two triangles: OBJLoader writes six corners, the merge keeps the four shared ones.
  const obj = 'mtllib model.mtl\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nusemtl red\nf 1 2 3\nf 1 3 4\n'
  const mtl = `data:text/plain;base64,${Buffer.from('newmtl red\nKd 1 0 0\n').toString('base64')}`
  const { root } = await parseModel(new TextEncoder().encode(obj).buffer, 'model.obj', { 'model.mtl': mtl })
  const meshes = []
  root.traverse(node => node.isMesh && meshes.push(node))
  assert.equal(meshes.length, 1)
  assert.equal(meshes[0].geometry.index.count, 6)
  assert.equal(meshes[0].geometry.attributes.position.count, 4)
  assert.deepEqual([meshes[0].material.color.r, meshes[0].material.color.g], [1, 0])
  assert.equal(mtlLibOf(obj), 'model.mtl')
  assert.deepEqual(mtlTextures('newmtl a\nmap_Kd -s 1 1 1 tex.png\nbump normal.png\n'), ['tex.png', 'normal.png'])
})

test('an OBJ’s companions resolve beside it only', () => {
  assert.equal(siblingPath('/out/convert/model.obj', 'model.mtl'), '/out/convert/model.mtl')
  assert.equal(siblingPath('/out/convert/model.obj', 'tex/a.png'), '/out/convert/tex/a.png')
  assert.equal(siblingPath('C:\\out\\model.obj', 'model.mtl'), 'C:\\out\\model.mtl')
  for (const rel of ['../secret.png', '/etc/passwd', 'C:/x.png', '']) assert.equal(siblingPath('/out/model.obj', rel), null, rel)
})

test('an STL (Z-up, like 3MF) is stood up in the Y-up viewer', async () => {
  const stl = 'solid t\nfacet normal 1 0 0\nouter loop\nvertex 0 0 0\nvertex 0 1 0\nvertex 0 0 2\nendloop\nendfacet\nendsolid t\n'
  const { root } = await parseModel(new TextEncoder().encode(stl).buffer, 'print.stl')
  const box = new Box3().setFromObject(root)
  assert.ok(Math.abs(box.max.y - 2) < 1e-6 && Math.abs(box.min.y) < 1e-6, `height ${box.min.y}..${box.max.y}`)
})

test('a mesh FBXLoader writes per corner is indexed again with its material groups kept', () => {
  const corners = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0]
  const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(corners, 3))
  geometry.addGroup(0, 3, 0)
  geometry.addGroup(3, 3, 1)
  const root = new Group().add(new Mesh(geometry, [new MeshBasicMaterial(), new MeshBasicMaterial()]))
  indexMeshes(root)
  const merged = root.children[0].geometry
  assert.equal(merged.attributes.position.count, 4)
  assert.deepEqual([...merged.index.array], [0, 1, 2, 0, 2, 3])
  assert.deepEqual(merged.groups.map(g => [g.start, g.count, g.materialIndex]), [[0, 3, 0], [3, 3, 1]])
})
