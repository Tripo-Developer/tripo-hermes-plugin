/**
 * Bytes of one saved model → a three.js object, with three.js's own loaders for the single-file formats Tripo
 * exports (GLB/glTF, meshopt-compressed with `compress: "geometry"` included, and FBX). Kept apart from the WebGL
 * stage so a plain page (or test harness) can parse without a renderer.
 *
 * The viewer gets bytes from the plugin backend, never a URL, so nothing may load relative to the app page: a
 * glTF that points at files beside it is refused, and an FBX's external texture names resolve to an empty data
 * URL (a missing texture, not a request).
 *
 * Adapted from Nous Research's Meshy plugin (hermes-official-plugins, MIT, Copyright (c) 2025 Nous Research).
 */

import { type AnimationClip, LoadingManager, type Mesh, type Object3D } from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

export interface ParsedModel {
  root: Object3D
  clips: AnimationClip[]
}

/** The viewer's formats, by extension. */
export const MODEL_EXTENSIONS = ['glb', 'gltf', 'fbx']

export const extensionOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name.split(/[?#]/)[0])?.[1]?.toLowerCase() ?? ''

export const isModelFile = (name: string) => MODEL_EXTENSIONS.includes(extensionOf(name))

/** URIs of buffers/images a glTF (JSON or GLB) loads from outside its own bytes; `data:` URIs are embedded. */
export function externalResources(bytes: ArrayBuffer): string[] {
  let json: unknown
  try {
    const view = new DataView(bytes)
    if (bytes.byteLength >= 20 && view.getUint32(0, true) === 0x46546c67) {
      // GLB: 12-byte header, then the JSON chunk (length, type 'JSON', data).
      const length = view.getUint32(12, true)
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes, 20, Math.min(length, bytes.byteLength - 20))))
    } else {
      json = JSON.parse(new TextDecoder().decode(bytes))
    }
  } catch {
    return [] // not parseable here: let the loader report it
  }
  const doc = json as { buffers?: Array<{ uri?: unknown }>; images?: Array<{ uri?: unknown }> }
  return [...(Array.isArray(doc?.buffers) ? doc.buffers : []), ...(Array.isArray(doc?.images) ? doc.images : [])]
    .map(entry => entry?.uri)
    .filter((uri): uri is string => typeof uri === 'string' && !/^data:/i.test(uri))
}

const countMeshes = (root: Object3D) => {
  let n = 0
  root.traverse(node => {
    if ((node as Mesh).isMesh) {
      n += 1
    }
  })
  return n
}

/** `name` (file name or path) picks the loader by extension; anything else is read as glTF/GLB. */
export async function parseModel(bytes: ArrayBuffer, name = ''): Promise<ParsedModel> {
  const format = extensionOf(name) || 'glb'
  let parsed: ParsedModel
  if (format === 'fbx') {
    const manager = new LoadingManager()
    manager.setURLModifier(url => (/^(data|blob):/i.test(url) ? url : 'data:,'))
    const group = new FBXLoader(manager).parse(bytes, '')
    parsed = { root: group, clips: group.animations ?? [] }
  } else if (format === 'glb' || format === 'gltf') {
    if (externalResources(bytes).length) {
      throw new Error('This .gltf references external files. Open the .glb, or a .gltf with embedded data.')
    }
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes, '')
    parsed = { root: gltf.scene, clips: gltf.animations ?? [] }
  } else {
    throw new Error(`No 3D preview for .${format} files`)
  }
  if (!countMeshes(parsed.root)) {
    throw new Error(`This .${format} file has no mesh the viewer can draw`)
  }
  return parsed
}
