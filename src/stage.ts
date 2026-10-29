/**
 * The three.js stage: one WebGLRenderer, a camera with orbit controls, studio lighting, and whichever model is
 * loaded (formats: see parse-model.ts). Plain DOM + three, no React: the React side mounts a <div>, hands it
 * to `createStage`, and calls `dispose()` on unmount, so a scrolled-away transcript card frees its GPU context
 * instead of leaking one per message (Chromium caps live WebGL contexts at ~16).
 *
 * Adapted from Nous Research's Meshy plugin (hermes-official-plugins, MIT, Copyright (c) 2025 Nous Research).
 */

import {
  ACESFilmicToneMapping,
  AmbientLight,
  type AnimationAction,
  type AnimationClip,
  AnimationMixer,
  Box3,
  Clock,
  Color,
  DirectionalLight,
  GridHelper,
  LoopOnce,
  LoopRepeat,
  type Material,
  type Mesh,
  type Object3D,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

import { parseModel } from './parse-model.ts'

export interface ModelStats {
  triangles: number
  vertices: number
  /** Animation clip names, in file order (a rigged and animated Tripo model carries its preset). */
  animations: string[]
}

export interface Stage {
  /** `name` picks the loader by extension (default glTF/GLB); `siblings`: an OBJ's .mtl and textures as data URLs. */
  load: (bytes: ArrayBuffer, name?: string, siblings?: Readonly<Record<string, string>>) => Promise<ModelStats>
  setAutoRotate: (on: boolean) => void
  setWireframe: (on: boolean) => void
  setGrid: (on: boolean) => void
  resetView: () => void
  /** Switch to a clip by index. */
  playClip: (index: number) => void
  /** Pause or resume the current clip (keeps its pose while paused; a finished play-once clip restarts). */
  setPlaying: (on: boolean) => void
  /** Loop the clip (default) or play it once and hold the last pose. */
  setLoop: (on: boolean) => void
  /** `fn` runs when a play-once clip reaches its end. */
  onClipEnd: (fn: () => void) => void
  /** `fn` runs when the GPU drops this viewer's WebGL context; after a loss the browser may refuse new contexts to
   *  the whole window until the app restarts. */
  onContextLost: (fn: () => void) => void
  dispose: () => void
}

/** A CSS colour as #rrggbb. Theme values can take forms three.js cannot parse (color-mix(...)), so let the browser
 *  paint it and read the pixel back; an invalid value keeps the fallback. */
export function cssHex(value: string, fallback = '#1b1d22'): string {
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const g = canvas.getContext('2d')
    if (!g) {
      return fallback
    }
    g.fillStyle = fallback
    g.fillStyle = value
    g.fillRect(0, 0, 1, 1)
    const [r, gr, b] = g.getImageData(0, 0, 1, 1).data
    return `#${[r, gr, b].map(n => n.toString(16).padStart(2, '0')).join('')}`
  } catch {
    return fallback
  }
}

export function createStage(host: HTMLElement, background: string): Stage {
  const renderer = new WebGLRenderer({ antialias: true, alpha: false })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.domElement.style.display = 'block'
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.outline = 'none'
  host.appendChild(renderer.domElement)

  const scene = new Scene()
  scene.background = new Color(cssHex(background))
  const pmrem = new PMREMGenerator(renderer)
  const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environment = envTexture
  scene.add(new AmbientLight(0xffffff, 0.25))
  const key = new DirectionalLight(0xffffff, 1.6)
  key.position.set(3, 5, 4)
  scene.add(key)

  const camera = new PerspectiveCamera(40, 1, 0.01, 1000)
  camera.position.set(2, 1.5, 2.5)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.autoRotateSpeed = 1.2

  const grid = new GridHelper(4, 16, 0x888888, 0x444444)
  ;(grid.material as Material).transparent = true
  ;(grid.material as Material).opacity = 0.35
  scene.add(grid)

  let model: Object3D | null = null
  let clips: AnimationClip[] = []
  let mixer: AnimationMixer | null = null
  let action: AnimationAction | null = null
  let playing = false
  let loop = true
  let clipEnded = () => {}
  const clock = new Clock()
  let dirty = true
  let home = { pos: camera.position.clone(), target: new Vector3() }
  let frame = 0
  let disposed = false
  let contextLost = () => {}
  // dispose() drops the context on purpose (forceContextLoss): only a loss before that is news.
  renderer.domElement.addEventListener('webglcontextlost', () => !disposed && contextLost())

  const resize = () => {
    const w = Math.max(1, host.clientWidth)
    const h = Math.max(1, host.clientHeight)
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    dirty = true
  }
  const observer = new ResizeObserver(resize)
  observer.observe(host)
  resize()

  // Render on demand: a frame is drawn only when the camera moved (orbit, damping, auto-rotate) or something
  // visible changed, and never while the viewport is off-screen or the window hidden.
  let onScreen = true
  const invalidate = () => {
    dirty = true
  }
  const visibility = new IntersectionObserver(entries => {
    onScreen = entries.some(e => e.isIntersecting)
    dirty = true
  })
  visibility.observe(host)
  controls.addEventListener('change', invalidate)

  const tick = () => {
    if (disposed) {
      return
    }
    frame = requestAnimationFrame(tick)
    if (!onScreen || document.hidden) {
      return
    }
    const moved = controls.update()
    // Read the clock every tick so a resume after a pause or an off-screen stretch does not jump the pose.
    const delta = clock.getDelta()
    const animating = playing && mixer !== null && action !== null
    if (animating) {
      mixer!.update(Math.min(delta, 0.1))
    }
    if (moved || dirty || animating) {
      dirty = false
      renderer.render(scene, camera)
    }
  }
  tick()

  const disposeModel = () => {
    if (!model) {
      return
    }
    mixer?.stopAllAction()
    mixer?.uncacheRoot(model)
    mixer = null
    action = null
    clips = []
    playing = false
    scene.remove(model)
    model.traverse(node => {
      const mesh = node as Mesh
      if (!mesh.isMesh) {
        return
      }
      mesh.geometry?.dispose()
      for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        for (const value of Object.values(mat ?? {})) {
          if (value && typeof value === 'object' && 'isTexture' in value) {
            ;(value as { dispose: () => void }).dispose()
          }
        }
        mat?.dispose()
      }
    })
    model = null
  }

  const frameModel = (root: Object3D) => {
    const box = new Box3().setFromObject(root)
    const size = box.getSize(new Vector3())
    const center = box.getCenter(new Vector3())
    // Sit the model on the grid, centred; scale the grid to the model's footprint.
    root.position.sub(new Vector3(center.x, box.min.y, center.z))
    const radius = Math.max(size.x, size.y, size.z) || 1
    grid.scale.setScalar(radius / 2)
    const dist = (radius / (2 * Math.tan((camera.fov * Math.PI) / 360))) * 1.35
    const target = new Vector3(0, size.y / 2, 0)
    camera.near = radius / 100
    camera.far = radius * 100
    camera.position.copy(target).add(new Vector3(0.75, 0.45, 1).normalize().multiplyScalar(dist))
    camera.updateProjectionMatrix()
    controls.target.copy(target)
    controls.update()
    home = { pos: camera.position.clone(), target: target.clone() }
  }

  const playClipAt = (index: number) => {
    if (!mixer || index < 0 || index >= clips.length) {
      return
    }
    const next = mixer.clipAction(clips[index])
    if (next !== action) {
      action?.fadeOut(0.25)
      next.setLoop(loop ? LoopRepeat : LoopOnce, Infinity)
      next.clampWhenFinished = true
      next.reset().fadeIn(action ? 0.25 : 0).play()
      action = next
    }
    if (!loop && action.time >= action.getClip().duration) {
      action.reset().play()
    }
    action.paused = false
    playing = true
    clock.getDelta()
    dirty = true
  }

  return {
    async load(bytes, name, siblings) {
      const parsed = await parseModel(bytes, name, siblings)
      if (disposed) {
        throw new Error('viewer closed')
      }
      // Link the shaders before the first draw, without blocking: a draw that waits on a slow link stalls Chromium's
      // GPU process, and on macOS such a stall has timed out a GPU queue and frozen the whole screen.
      await renderer.compileAsync(parsed.root, camera, scene)
      if (disposed) {
        throw new Error('viewer closed')
      }
      disposeModel()
      model = parsed.root
      scene.add(model)
      clips = parsed.clips
      if (clips.length) {
        mixer = new AnimationMixer(model)
        // A play-once clip holds its last pose. Only the current clip ends playback: one fading out after a switch
        // fires `finished` too.
        mixer.addEventListener('finished', (e: { action?: unknown }) => {
          if (e.action === action) {
            playing = false
            dirty = true
            clipEnded()
          }
        })
        // Frame on the first clip's first pose: a rig's bind pose can differ from its animated stance.
        playClipAt(0)
        mixer.update(0)
      }
      frameModel(model)
      dirty = true
      clock.getDelta()
      const stats: ModelStats = { triangles: 0, vertices: 0, animations: clips.map((c, i) => c.name || `Clip ${i + 1}`) }
      model.traverse(node => {
        const mesh = node as Mesh
        if (!mesh.isMesh) {
          return
        }
        const pos = mesh.geometry.getAttribute('position')
        stats.vertices += pos?.count ?? 0
        stats.triangles += mesh.geometry.index ? mesh.geometry.index.count / 3 : (pos?.count ?? 0) / 3
      })
      return stats
    },
    setAutoRotate(on) {
      controls.autoRotate = on
      dirty = true
    },
    setWireframe(on) {
      model?.traverse(node => {
        const mesh = node as Mesh
        if (mesh.isMesh) {
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            ;(m as Material & { wireframe?: boolean }).wireframe = on
          }
        }
      })
      dirty = true
    },
    setGrid(on) {
      grid.visible = on
      dirty = true
    },
    resetView() {
      camera.position.copy(home.pos)
      controls.target.copy(home.target)
      controls.update()
      dirty = true
    },
    playClip: playClipAt,
    setPlaying(on) {
      if (!action) {
        return
      }
      if (on && !loop && action.time >= action.getClip().duration - 1e-3) {
        action.reset().play()
      }
      playing = on
      action.paused = !on
      clock.getDelta()
      dirty = true
    },
    setLoop(on) {
      loop = on
      if (action) {
        action.setLoop(on ? LoopRepeat : LoopOnce, Infinity)
        action.clampWhenFinished = true
      }
    },
    onClipEnd(fn) {
      clipEnded = fn
    },
    onContextLost(fn) {
      contextLost = fn
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      visibility.disconnect()
      controls.removeEventListener('change', invalidate)
      controls.dispose()
      disposeModel()
      envTexture.dispose()
      pmrem.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
    }
  }
}

export function dataUrlToBuffer(dataUrl: string): ArrayBuffer {
  const comma = dataUrl.indexOf(',')
  const bin = atob(dataUrl.slice(comma + 1))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i)
  }
  return out.buffer
}
