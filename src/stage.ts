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
  AnimationClip,
  AnimationMixer,
  type Bone,
  Box3,
  Clock,
  DirectionalLight,
  GridHelper,
  Group,
  LoopOnce,
  LoopRepeat,
  type Material,
  Matrix3,
  type Mesh,
  type Object3D,
  PerspectiveCamera,
  PMREMGenerator,
  PropertyBinding,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

import { parseModel } from './parse-model.ts'
import { bindKeys, type Character, clipRoles, createCharacter, firstHop, type Keys, leftward, type Pose, stripTravel, type XZ } from './play.ts'

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
  /** Play mode: the keyboard drives the character on the focused canvas (see play.ts) and the camera follows it;
   *  off puts the model, its clip and the view back. */
  setPlayMode: (on: boolean) => void
  /** `fn` runs when the GPU drops this viewer's WebGL context; after a loss the browser may refuse new contexts to
   *  the whole window until the app restarts. */
  onContextLost: (fn: () => void) => void
  dispose: () => void
}

export function createStage(host: HTMLElement): Stage {
  // Transparent: Desktop's panel colours are translucent color-mix() values that only look right composited over the
  // page, so the viewer's own CSS background shows through instead of being copied into the scene.
  const renderer = new WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.outputColorSpace = SRGBColorSpace
  renderer.toneMapping = ACESFilmicToneMapping
  renderer.domElement.style.display = 'block'
  renderer.domElement.style.width = '100%'
  renderer.domElement.style.height = '100%'
  renderer.domElement.style.outline = 'none'
  host.appendChild(renderer.domElement)

  const scene = new Scene()
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
  // Play mode: the model sits in `turn` (turned so its front faces the pivot's +Z) inside `pivot`, which walks.
  let play: null | {
    pivot: Group
    turn: Group
    character: Character
    keys: Keys
    unbind: () => void
    actions: AnimationAction[]
    current: AnimationAction | null
    resume: number
    autoRotate: boolean
  } = null
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
    // Read the clock every tick so a resume after a pause or an off-screen stretch does not jump the pose.
    const delta = Math.min(clock.getDelta(), 0.1)
    if (play) {
      stepPlay(delta)
    }
    const moved = controls.update()
    const animating = play !== null || (playing && mixer !== null && action !== null)
    if (animating) {
      mixer?.update(delta)
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
    exitPlay()
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

  // Play on clones of the clips with their travel taken out and a jump that hops more than once cut to its first hop
  // (the viewer goes on playing them as authored), plus a still frame to idle in when the model has no idle clip.
  const enterPlay = () => {
    if (!model || play) {
      return
    }
    const root = model
    root.updateMatrixWorld(true)
    const playClips = clips.map(c => c.clone())
    const roles = clipRoles(playClips.map(c => c.name))
    let travel: XZ | null = null
    for (const [i, clip] of playClips.entries()) {
      const out = stripTravel(clip.tracks)
      const node = out && i === roles.walk ? root.getObjectByName(PropertyBinding.parseTrackName(out.track).nodeName ?? '') : undefined
      if (out && node?.parent) {
        const way = new Vector3(...out.travel).applyMatrix3(new Matrix3().setFromMatrix4(node.parent.matrixWorld))
        travel = [way.x, way.z]
      }
    }
    const jump = roles.jump === null ? null : playClips[roles.jump]
    const landed = jump && firstHop(jump.tracks, track => root.getObjectByName(PropertyBinding.parseTrackName(track).nodeName ?? '')?.parent?.matrixWorld.elements)
    if (jump && landed) {
      jump.tracks.forEach(t => t.trim(0, landed))
      jump.resetDuration()
    }
    const bones: { name: string; x: number; z: number }[] = []
    const at = new Vector3()
    root.traverse(node => {
      if ((node as Bone).isBone) {
        node.getWorldPosition(at)
        bones.push({ name: node.name, x: at.x, z: at.z })
      }
    })
    let still: number | null = null
    if (roles.idle === null && roles.walk !== null) {
      // trim(0, 0) keeps each track's first key.
      playClips.push(new AnimationClip('still', -1, playClips[roles.walk].tracks.map(t => t.clone().trim(0, 0))))
      still = playClips.length - 1
    }
    const height = new Box3().setFromObject(root).getSize(new Vector3()).y || 1
    const character = createCharacter({ roles, durations: playClips.map(c => c.duration), height, travel, left: leftward(bones), still })

    const pivot = new Group()
    const turn = new Group()
    turn.rotation.y = -character.facing
    pivot.rotation.y = character.facing
    scene.remove(root)
    turn.add(root)
    pivot.add(turn)
    scene.add(pivot)
    const resume = action ? Math.max(clips.indexOf(action.getClip()), 0) : 0
    mixer?.stopAllAction()
    action = null
    playing = false
    const canvas = renderer.domElement
    canvas.tabIndex = 0
    // Hermes Desktop sees keys first (window, capture phase): it types a letter or Space into the chat composer and
    // answers a waiting approval on Esc, unless focus is inside [data-terminal]. Its remote screen pane marks itself the
    // same way, plus [data-remote-screen] so that ⌘W does not close a terminal tab instead.
    canvas.setAttribute('data-terminal', '')
    canvas.setAttribute('data-remote-screen', '')
    const { keys, unbind } = bindKeys(canvas)
    const animator = mixer
    const actions = animator ? playClips.map(c => animator.clipAction(c)) : []
    play = { pivot, turn, character, keys, unbind, actions, current: null, resume, autoRotate: controls.autoRotate }
    controls.autoRotate = false
    camera.position.sub(controls.target).multiplyScalar(1.6).add(controls.target) // step back: room to move
    canvas.focus({ preventScroll: true })
    clock.getDelta()
    dirty = true
  }

  const exitPlay = () => {
    if (!play || !model) {
      return
    }
    const { pivot, turn, unbind, actions, resume, autoRotate } = play
    play = null
    unbind()
    renderer.domElement.removeAttribute('tabindex')
    renderer.domElement.removeAttribute('data-terminal')
    renderer.domElement.removeAttribute('data-remote-screen')
    for (const a of actions) {
      a.stop()
      mixer?.uncacheClip(a.getClip())
    }
    turn.remove(model)
    scene.remove(pivot)
    scene.add(model)
    grid.position.set(0, 0, 0)
    controls.autoRotate = autoRotate
    camera.position.copy(home.pos)
    controls.target.copy(home.target)
    controls.update()
    if (clips.length) {
      playClipAt(resume)
      mixer?.update(0)
    }
    dirty = true
  }

  const stepPlay = (delta: number) => {
    if (!play) {
      return
    }
    const view = Math.atan2(controls.target.x - camera.position.x, controls.target.z - camera.position.z)
    const pose: Pose = play.character.step(delta, play.keys, view)
    const { pivot } = play
    // The camera and the grid follow along the ground; the grid moves in whole cells (GridHelper(4, 16)).
    const dx = pose.x - pivot.position.x
    const dz = pose.z - pivot.position.z
    camera.position.x += dx
    camera.position.z += dz
    controls.target.x += dx
    controls.target.z += dz
    const cell = grid.scale.x / 4
    grid.position.set(Math.round(pose.x / cell) * cell, 0, Math.round(pose.z / cell) * cell)
    pivot.position.set(pose.x, pose.y, pose.z)
    pivot.rotation.set(pose.lean, pose.heading, 0, 'YXZ')

    const next = pose.clip === null ? null : (play.actions[pose.clip] ?? null)
    if (next !== play.current) {
      play.current?.fadeOut(0.2)
      next?.reset().setLoop(pose.once ? LoopOnce : LoopRepeat, Infinity).fadeIn(0.2).play()
      play.current = next
    } else if (next && pose.start && pose.once) {
      next.reset().play()
    }
    if (next) {
      next.clampWhenFinished = true
      next.timeScale = pose.timeScale
    }
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
      const at = play ? new Vector3(play.pivot.position.x, 0, play.pivot.position.z) : new Vector3()
      camera.position.copy(home.pos).add(at)
      controls.target.copy(home.target).add(at)
      controls.update()
      dirty = true
    },
    playClip(index) {
      if (!play) {
        playClipAt(index)
      }
    },
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
    setPlayMode(on) {
      if (on) {
        enterPlay()
      } else {
        exitPlay()
      }
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
