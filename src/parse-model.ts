/**
 * Bytes of one saved model → a three.js object, with three.js's own loader for each format Tripo exports (GLB/glTF,
 * meshopt-compressed with `compress: "geometry"` included, FBX, OBJ + .mtl, STL, USDZ, 3MF). Kept apart from the
 * WebGL stage so a plain page (or test harness) can parse without a renderer.
 *
 * The viewer gets bytes from the plugin backend, never a URL, so nothing may load relative to the app page: a glTF
 * that points at files beside it is refused, and every other loader runs through a LoadingManager that maps a
 * companion file name (an OBJ's .mtl and textures) to the data URL the caller fetched, keeps the data:/blob: URLs
 * loaders make for embedded textures, and turns anything else into an empty data URL (a missing texture, not a
 * request).
 *
 * Adapted from Nous Research's Meshy plugin (hermes-official-plugins, MIT, Copyright (c) 2025 Nous Research).
 */

import { type AnimationClip, Group, LoadingManager, Mesh, MeshStandardMaterial, type Object3D } from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { USDLoader } from 'three/examples/jsm/loaders/USDLoader.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export interface ParsedModel {
  root: Object3D
  clips: AnimationClip[]
}

/** The viewer's formats, by extension. */
export const MODEL_EXTENSIONS = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'usdz', '3mf']

export const extensionOf = (name: string) => /\.([a-z0-9]+)$/i.exec(name.split(/[?#]/)[0])?.[1]?.toLowerCase() ?? ''

export const isModelFile = (name: string) => MODEL_EXTENSIONS.includes(extensionOf(name))

/** The `mtllib` an OBJ names in its header. */
export function mtlLibOf(objHead: string): null | string {
  const match = /^[ \t]*mtllib[ \t]+(.+?)[ \t]*$/m.exec(objHead)
  return match ? match[1] : null
}

/** Texture files an .mtl references (`map_Kd tex.png`, options like `-s 1 1 1` skipped). */
export function mtlTextures(mtl: string): string[] {
  const out = new Set<string>()
  for (const line of mtl.split(/\r?\n/)) {
    const match = /^[ \t]*(?:map_\w+|bump|disp|norm|refl)[ \t]+(.+?)[ \t]*$/i.exec(line)
    if (!match) {
      continue
    }
    // The file name is the last token; options (-bm 1, -s 1 1 1 ...) come first.
    const tokens = match[1].split(/[ \t]+/)
    out.add(tokens[tokens.length - 1])
  }
  return [...out]
}

/** A companion file beside `modelPath` (`robot.obj` + `robot.mtl` → `/dir/robot.mtl`). Only plain relative
 *  names: anything absolute or climbing out with `..` is refused here (the backend checks roots again). */
export function siblingPath(modelPath: string, rel: string): null | string {
  const clean = rel.trim().replace(/\\/g, '/')
  if (!clean || clean.startsWith('/') || /^[a-z]:/i.test(clean) || clean.split('/').includes('..')) {
    return null
  }
  const cut = Math.max(modelPath.lastIndexOf('/'), modelPath.lastIndexOf('\\'))
  const sep = modelPath.includes('\\') && !modelPath.includes('/') ? '\\' : '/'
  return `${modelPath.slice(0, cut + 1)}${clean.split('/').join(sep)}`
}

const EMPTY = 'data:,'

function companionManager(siblings: Readonly<Record<string, string>>): LoadingManager {
  const manager = new LoadingManager()
  manager.setURLModifier(url => {
    if (/^(data|blob):/i.test(url)) {
      return url
    }
    const clean = url.replace(/\\/g, '/').replace(/^\.\//, '')
    return siblings[clean] ?? siblings[clean.split('/').pop() ?? ''] ?? EMPTY
  })
  return manager
}

function dataUrlText(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  const body = dataUrl.slice(comma + 1)
  if (!/;base64$/i.test(dataUrl.slice(0, comma))) {
    return decodeURIComponent(body)
  }
  const bin = atob(body)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i)
  }
  return new TextDecoder().decode(out)
}

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

/** USDZ archives are stored uncompressed (USDZ spec) with the root layer first, so a text layer's header,
 *  where `upAxis` lives, is readable in the first bytes. three.js's USD reader ignores it; Blender writes Z. */
function usdzIsZUp(bytes: ArrayBuffer): boolean {
  const head = new TextDecoder('latin1').decode(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 8192)))
  return /\bupAxis\s*=\s*"Z"/.test(head)
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

/** FBXLoader and OBJLoader write one vertex per triangle corner, about six times what the same Tripo model has as a
 *  GLB; merged back into an indexed mesh, the preview sends the GPU what the GLB would. */
export function indexMeshes(root: Object3D) {
  root.traverse(node => {
    const mesh = node as Mesh
    if (mesh.isMesh && !mesh.geometry.index) {
      mesh.geometry = mergeVertices(mesh.geometry)
    }
  })
}

/** `name` (file name or path) picks the loader by extension; anything else is read as glTF/GLB. `siblings`: an OBJ's
 *  companion files by the name it uses for them (`model.mtl`, `texture.png`) → data URL. */
export async function parseModel(bytes: ArrayBuffer, name = '', siblings: Readonly<Record<string, string>> = {}): Promise<ParsedModel> {
  const format = extensionOf(name) || 'glb'
  const manager = companionManager(siblings)
  let parsed: ParsedModel
  switch (format) {
    case 'glb':
    case 'gltf': {
      if (externalResources(bytes).length) {
        throw new Error('This .gltf references external files. Open the .glb, or a .gltf with embedded data.')
      }
      const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(bytes, '')
      parsed = { root: gltf.scene, clips: gltf.animations ?? [] }
      break
    }
    case 'fbx': {
      const group = new FBXLoader(manager).parse(bytes, '')
      indexMeshes(group)
      parsed = { root: group, clips: group.animations ?? [] }
      break
    }
    case 'obj': {
      const text = new TextDecoder().decode(bytes)
      const loader = new OBJLoader(manager)
      const lib = mtlLibOf(text.slice(0, 65_536))
      const mtl = lib ? siblings[lib] : undefined
      if (mtl) {
        const materials = new MTLLoader(manager).parse(dataUrlText(mtl), '')
        materials.preload()
        loader.setMaterials(materials)
      }
      const group = loader.parse(text)
      indexMeshes(group)
      parsed = { root: group, clips: [] }
      break
    }
    case 'stl': {
      const geometry = new STLLoader().parse(bytes)
      const colored = (geometry as { hasColors?: boolean }).hasColors === true
      const material = new MeshStandardMaterial({ color: colored ? 0xffffff : 0xb9bec7, roughness: 0.6, metalness: 0.05, vertexColors: colored })
      parsed = { root: new Mesh(geometry, material), clips: [] }
      break
    }
    case 'usdz': {
      parsed = { root: new USDLoader(manager).parse(bytes), clips: [] }
      if (!countMeshes(parsed.root)) {
        // three.js reads USDZ with text (USDA) layers, meshes under Xform prims; its binary USDC reader is still a stub.
        throw new Error('The viewer cannot draw this USDZ: it reads text USD layers only, and most USDZ files store binary USD. Open the GLB instead.')
      }
      break
    }
    case '3mf': {
      parsed = { root: new ThreeMFLoader(manager).parse(bytes), clips: [] }
      break
    }
    default:
      throw new Error(`No 3D preview for .${format} files`)
  }
  if (!countMeshes(parsed.root)) {
    throw new Error(`This .${format} file has no mesh the viewer can draw`)
  }
  if (format === 'stl' || format === '3mf' || (format === 'usdz' && usdzIsZUp(bytes))) {
    // Printing formats are Z-up; stand the model up in three.js's Y-up world.
    const upright = new Group()
    parsed.root.rotation.x = -Math.PI / 2
    upright.add(parsed.root)
    parsed = { root: upright, clips: parsed.clips }
  }
  return parsed
}
