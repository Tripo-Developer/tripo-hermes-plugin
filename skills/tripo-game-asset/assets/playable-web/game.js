// A third-person arena for a rigged, animated Tripo character: collect every coin while slimes (or another Tripo
// model) chase you; strike them, burn them with a special move, run and jump. play.js holds the character logic (the
// same code as the Tripo card's Play mode in Hermes Desktop). Serve this folder over http, since browsers block
// modules and model files on file://:
//   python3 -m http.server 8000 --bind 127.0.0.1   then open http://127.0.0.1:8000
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone } from 'three/addons/utils/SkeletonUtils.js'

import { bindKeys, clipRoles, CONTROLS, createCharacter, firstHop, inReach, leftward, noKeys, stripTravel } from './play.js'

const CONFIG = {
  // The animated GLB (?model=other.glb overrides it), its height in metres, and more GLBs animating the same rig
  // whose clips it also gets.
  model: new URLSearchParams(location.search).get('model') || 'character.glb',
  height: 1.8,
  clips: [],
  // Clip names for roles the names do not give away, e.g. { attack: 'Spin' }. Roles: idle, walk, run, jump, attack,
  // hurt; one without a clip is made up in code.
  roles: {},
  // A second attack on K, paid in stamina: a cone of particles that defeats every enemy it reaches (null: none).
  special: { name: 'Fire breath', color: '#ff7a1a', cost: 40 },
  // How many enemies chase the character, and optionally an animated GLB to use instead of slimes (another Tripo
  // model), with its height in metres.
  enemies: { count: 5, model: null, height: 0.6 },
  // Collect them all to win.
  coins: 8,
  // Arena radius, in metres.
  arena: 15
}

const message = document.getElementById('message')
const score = document.getElementById('score')
const healthBar = document.getElementById('health')
const staminaBar = document.getElementById('stamina')
document.getElementById('controls').textContent =
  `${CONTROLS}${CONFIG.special ? ` · K: ${CONFIG.special.name}` : ''} · drag to turn the camera · R restarts`

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.shadowMap.enabled = true
document.body.appendChild(renderer.domElement)
const canvas = renderer.domElement
canvas.tabIndex = 0

const scene = new THREE.Scene()
scene.background = new THREE.Color(0x15171c)
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 500)
const controls = new OrbitControls(camera, canvas)
controls.enableDamping = true
controls.enablePan = false
controls.maxPolarAngle = Math.PI * 0.47
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder)

// An animated GLB scaled to `height` metres and stood on the ground at the origin, its clips playing on the spot (game
// code moves it) and a jump that hops more than once cut to its first hop; how far the walk went gives its pace and
// its front.
async function prepare(file, height, more = [], names = {}) {
  const [gltf, ...extra] = await Promise.all([file, ...more].map(f => loader.loadAsync(f)))
  const model = gltf.scene
  const clips = [...gltf.animations, ...extra.flatMap(g => g.animations)]
  model.traverse(node => {
    if (node.isMesh) {
      node.castShadow = true
      node.frustumCulled = false // a skinned mesh's bounds do not follow its animation
    }
  })
  const roles = clipRoles(clips.map(c => c.name))
  for (const [role, name] of Object.entries(names)) {
    const i = clips.findIndex(c => c.name === name)
    if (i >= 0) roles[role] = i
  }
  const moved = clips.map(c => stripTravel(c.tracks))
  model.updateMatrixWorld(true)
  const jump = roles.jump === null ? null : clips[roles.jump]
  const landed = jump && firstHop(jump.tracks, track => model.getObjectByName(THREE.PropertyBinding.parseTrackName(track).nodeName)?.parent?.matrixWorld.elements)
  if (landed) {
    jump.tracks.forEach(t => t.trim(0, landed))
    jump.resetDuration()
  }
  // No idle clip: idle on the walk's first frame (trim(0, 0) keeps each track's first key).
  let still = null
  if (roles.idle === null && roles.walk !== null) {
    clips.push(new THREE.AnimationClip('still', -1, clips[roles.walk].tracks.map(t => t.clone().trim(0, 0))))
    still = clips.length - 1
  }
  const mixer = new THREE.AnimationMixer(model)
  const actions = clips.map(c => mixer.clipAction(c))
  const first = roles.idle ?? still
  const current = first === null ? null : actions[first].play()
  mixer.update(0)

  model.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(model)
  model.scale.multiplyScalar(height / (box.max.y - box.min.y || 1))
  model.updateMatrixWorld(true)
  box.setFromObject(model)
  const center = box.getCenter(new THREE.Vector3())
  model.position.sub(new THREE.Vector3(center.x, box.min.y, center.z))
  model.updateMatrixWorld(true)

  let travel = null
  const out = roles.walk === null ? null : moved[roles.walk]
  const node = out && model.getObjectByName(THREE.PropertyBinding.parseTrackName(out.track).nodeName)
  if (node?.parent) {
    const way = new THREE.Vector3(...out.travel).applyMatrix3(new THREE.Matrix3().setFromMatrix4(node.parent.matrixWorld))
    travel = [way.x, way.z]
  }
  const bones = []
  model.traverse(bone => {
    if (bone.isBone) {
      const at = bone.getWorldPosition(new THREE.Vector3())
      bones.push({ name: bone.name, x: at.x, z: at.z })
    }
  })
  return { model, clips, roles, still, mixer, actions, current, travel, left: leftward(bones), h: height }
}

async function main() {
  const [hero, foe] = await Promise.all([
    prepare(CONFIG.model, CONFIG.height, CONFIG.clips, CONFIG.roles),
    CONFIG.enemies.model ? prepare(CONFIG.enemies.model, CONFIG.enemies.height) : null
  ])
  const { model, clips, roles, mixer, actions, h } = hero
  let current = hero.current
  const arena = CONFIG.arena
  const options = { roles, durations: clips.map(c => c.duration), height: h, travel: hero.travel, left: hero.left, still: hero.still, bounds: arena - 0.5 * h }
  let character = createCharacter(options)

  // The model sits in `turn`, turned so its front faces the pivot's +Z; the pivot walks and faces the heading.
  const pivot = new THREE.Group()
  const turn = new THREE.Group()
  turn.rotation.y = -character.facing
  turn.add(model)
  pivot.add(turn)
  scene.add(pivot)
  const filled = ['idle', 'run', 'jump', 'attack'].filter(role => roles[role] === null)
  document.getElementById('clips').textContent =
    `Clips: ${clips.filter(c => c.name !== 'still').map(c => c.name).join(', ') || 'none'}` + (filled.length ? ` · made up in code: ${filled.join(', ')}` : '')

  scene.fog = new THREE.Fog(0x15171c, arena * 0.9, arena * 2.5)
  scene.add(new THREE.HemisphereLight(0xdde6ff, 0x30281f, 1.2))
  const sun = new THREE.DirectionalLight(0xffffff, 2)
  sun.position.set(0.3 * arena, arena, 0.2 * arena)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  Object.assign(sun.shadow.camera, { left: -arena, right: arena, top: arena, bottom: -arena, near: 0.1, far: 3 * arena })
  sun.shadow.camera.updateProjectionMatrix()
  scene.add(sun)
  const ground = new THREE.Mesh(new THREE.CircleGeometry(arena, 64), new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 0.95 }))
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  scene.add(ground)
  const grid = new THREE.GridHelper(arena * 2, Math.round((arena * 4) / h), 0x4a5260, 0x363c46)
  grid.position.y = 0.002 * h
  scene.add(grid)
  const edge = new THREE.Mesh(new THREE.TorusGeometry(arena, 0.03 * h, 8, 96), new THREE.MeshStandardMaterial({ color: 0x5b8def, emissive: 0x1d3a7a }))
  edge.rotation.x = Math.PI / 2
  scene.add(edge)

  // Start behind the character.
  camera.near = h / 50
  camera.far = arena * 6
  camera.updateProjectionMatrix()
  controls.minDistance = 1.5 * h
  controls.maxDistance = 10 * h
  controls.target.set(0, 0.6 * h, 0)
  camera.position.set(-Math.sin(character.facing) * 3.2 * h, 1.6 * h, -Math.cos(character.facing) * 3.2 * h)

  // Enemies: slimes, or clones of the enemy model walking on the spot and turned to face the character.
  const er = CONFIG.enemies.height / 2
  const slime = new THREE.SphereGeometry(er, 24, 16)
  const foeFacing = foe && createCharacter({ roles: foe.roles, durations: foe.clips.map(c => c.duration), height: foe.h, travel: foe.travel, left: foe.left }).facing
  const foeClip = foe && (foe.roles.walk ?? foe.roles.run ?? (foe.clips.length ? 0 : null))
  const enemies = []
  const spawn = e => {
    const a = Math.random() * 2 * Math.PI
    const r = arena * (0.4 + 0.4 * Math.random())
    Object.assign(e, { x: Math.sin(a) * r, z: Math.cos(a) * r, dying: 0, down: 0 })
    e.mesh.visible = true
    e.mesh.scale.setScalar(1)
  }
  for (let i = 0; i < CONFIG.enemies.count; i += 1) {
    const e = { phase: Math.random() * 6, mixer: null }
    if (foe) {
      const body = clone(foe.model)
      const facing = new THREE.Group().add(body)
      facing.rotation.y = -foeFacing
      e.mesh = new THREE.Group().add(facing)
      e.mixer = new THREE.AnimationMixer(body)
      if (foeClip !== null) e.mixer.clipAction(foe.clips[foeClip]).play()
    } else {
      e.mesh = new THREE.Mesh(slime, new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.25 + 0.15 * Math.random(), 0.6, 0.5), roughness: 0.35 }))
      e.mesh.castShadow = true
    }
    scene.add(e.mesh)
    spawn(e)
    enemies.push(e)
  }

  const coinShape = new THREE.CylinderGeometry(0.12 * h, 0.12 * h, 0.03 * h, 24).rotateX(Math.PI / 2)
  const gold = new THREE.MeshStandardMaterial({ color: 0xffc93c, metalness: 0.3, roughness: 0.35, emissive: 0x4a3000 })
  const coins = Array.from({ length: CONFIG.coins }, () => {
    const coin = new THREE.Mesh(coinShape, gold)
    coin.castShadow = true
    scene.add(coin)
    return coin
  })
  const placeCoins = () =>
    coins.forEach(coin => {
      const a = Math.random() * 2 * Math.PI
      const r = arena * (0.15 + 0.7 * Math.random())
      coin.position.set(Math.sin(a) * r, 0.4 * h, Math.cos(a) * r)
      coin.visible = true
    })
  placeCoins()

  // The special move's particles: a ring buffer of glowing points that fly out of the character and fade.
  const flames = 400
  const flamePos = new Float32Array(flames * 3)
  const flameVel = new Float32Array(flames * 3)
  const flameColor = new Float32Array(flames * 3)
  const flameAge = new Float32Array(flames).fill(1)
  let nextFlame = 0
  const flameShape = new THREE.BufferGeometry()
  flameShape.setAttribute('position', new THREE.BufferAttribute(flamePos, 3))
  flameShape.setAttribute('color', new THREE.BufferAttribute(flameColor, 3))
  const dot = document.createElement('canvas')
  dot.width = dot.height = 64
  const pen = dot.getContext('2d')
  const glow = pen.createRadialGradient(32, 32, 0, 32, 32, 32)
  glow.addColorStop(0, '#fff')
  glow.addColorStop(1, 'rgba(255, 255, 255, 0)')
  pen.fillStyle = glow
  pen.fillRect(0, 0, 64, 64)
  const sparks = new THREE.Points(flameShape, new THREE.PointsMaterial({ size: 0.35 * h, map: new THREE.CanvasTexture(dot), vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }))
  sparks.frustumCulled = false
  scene.add(sparks)
  const tint = new THREE.Color(CONFIG.special?.color ?? '#ffffff')

  let health = 100
  let stamina = 100
  let tired = false
  let hurt = 0
  let stagger = 0
  let breath = 0
  let got = 0
  let kills = 0
  let over = false
  const { keys } = bindKeys(canvas)
  const restart = () => {
    character = createCharacter(options)
    health = 100
    stamina = 100
    tired = false
    hurt = 0
    stagger = 0
    breath = 0
    got = 0
    kills = 0
    over = false
    message.textContent = ''
    enemies.forEach(spawn)
    placeCoins()
  }
  canvas.addEventListener('keydown', e => {
    if (e.code === 'KeyR') {
      restart()
    } else if (e.code === 'KeyK' && CONFIG.special && !e.repeat && !over && stamina >= CONFIG.special.cost) {
      stamina -= CONFIG.special.cost
      breath = 0.6
    }
  })
  canvas.addEventListener('pointerdown', () => canvas.focus())
  message.textContent = ''
  canvas.focus()

  const clock = new THREE.Clock()
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.1)
    const view = Math.atan2(controls.target.x - camera.position.x, controls.target.z - camera.position.z)
    // Running spends stamina; once it runs out, the character walks until it is back to 30.
    const pose = character.step(dt, over ? noKeys() : { ...keys, run: keys.run && !tired }, view)
    stamina = Math.min(stamina + (pose.role === 'run' ? -30 : 20) * dt, 100)
    if (stamina <= 0) {
      stamina = 0
      tired = true
    } else if (stamina >= 30) {
      tired = false
    }
    // The camera follows along the ground.
    const dx = pose.x - pivot.position.x
    const dz = pose.z - pivot.position.z
    camera.position.x += dx
    camera.position.z += dz
    controls.target.x += dx
    controls.target.z += dz
    pivot.position.set(pose.x, pose.y, pose.z)
    pivot.rotation.set(pose.lean, pose.heading, 0, 'YXZ')

    // A hit plays the hurt clip, when there is one, over whatever the character was doing.
    stagger -= dt
    const show = stagger > 0 ? { clip: roles.hurt, once: true, timeScale: 1, start: false } : pose
    const next = show.clip === null ? null : actions[show.clip]
    if (next !== current) {
      current?.fadeOut(0.2)
      next?.reset().setLoop(show.once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity).fadeIn(0.2).play()
      current = next
    } else if (next && show.start && show.once) {
      next.reset().play()
    }
    if (next) {
      next.clampWhenFinished = true
      next.timeScale = show.timeScale
    }
    mixer.update(dt)

    breath -= dt
    if (breath > 0) {
      const ahead = [Math.sin(pose.heading), Math.cos(pose.heading)]
      for (let n = Math.ceil(dt * 600); n > 0; n -= 1) {
        const i = nextFlame
        nextFlame = (i + 1) % flames
        const a = pose.heading + (Math.random() - 0.5) * 0.7
        const v = 4.5 * h * (0.7 + 0.3 * Math.random())
        flamePos.set([pose.x + ahead[0] * 0.35 * h, pose.y + 0.65 * h, pose.z + ahead[1] * 0.35 * h], i * 3)
        flameVel.set([Math.sin(a) * v, (Math.random() - 0.4) * 0.3 * v, Math.cos(a) * v], i * 3)
        flameAge[i] = 0
      }
    }
    for (let i = 0; i < flames; i += 1) {
      flameAge[i] = Math.min(flameAge[i] + dt / 0.6, 1)
      const k = 1 - flameAge[i]
      for (let a = 0; a < 3; a += 1) {
        flamePos[i * 3 + a] += flameVel[i * 3 + a] * dt
      }
      flameColor[i * 3] = tint.r * k
      flameColor[i * 3 + 1] = tint.g * k
      flameColor[i * 3 + 2] = tint.b * k
    }
    flameShape.attributes.position.needsUpdate = true
    flameShape.attributes.color.needsUpdate = true

    for (const e of enemies) {
      if (e.down > 0) {
        e.down -= dt
        if (e.down <= 0) spawn(e)
        continue
      }
      if (e.dying > 0) {
        e.dying -= dt
        e.mesh.scale.setScalar(Math.max(e.dying / 0.25, 0.01))
        if (e.dying <= 0) {
          e.mesh.visible = false
          e.down = 2
        }
        continue
      }
      const ex = pose.x - e.x
      const ez = pose.z - e.z
      const d = Math.hypot(ex, ez) || 1
      if (!over && d > 0.2 * h + er) {
        e.x += (ex / d) * character.pace * 0.6 * dt
        e.z += (ez / d) * character.pace * 0.6 * dt
      }
      if (e.mixer) {
        e.mixer.update(over ? 0 : dt)
        e.mesh.position.set(e.x, 0, e.z)
        e.mesh.rotation.y = Math.atan2(ex, ez)
      } else {
        e.phase += dt * 6
        e.mesh.position.set(e.x, er + Math.abs(Math.sin(e.phase)) * 0.12 * h, e.z)
        e.mesh.scale.set(1, 1 - 0.15 * Math.abs(Math.cos(e.phase)), 1)
      }
      if ((pose.strike && inReach(pose, e.x, e.z, 0.7 * h + er, Math.PI / 2.5)) || (breath > 0 && inReach(pose, e.x, e.z, 2.5 * h + er, 0.4))) {
        e.dying = 0.25
        kills += 1
      } else if (!over && d < 0.25 * h + er && hurt <= 0) {
        health -= 10
        hurt = 1
        if (roles.hurt !== null) stagger = Math.min(clips[roles.hurt].duration, 0.8)
        e.x -= (ex / d) * 0.8 * h
        e.z -= (ez / d) * 0.8 * h
      }
    }
    hurt -= dt
    pivot.visible = hurt <= 0 || Math.floor(hurt * 10) % 2 === 0

    for (const coin of coins) {
      if (coin.visible) {
        coin.rotation.y += dt * 3
        if (!over && Math.hypot(coin.position.x - pose.x, coin.position.z - pose.z) < 0.45 * h) {
          coin.visible = false
          got += 1
        }
      }
    }
    if (!over && health <= 0) {
      over = true
      message.textContent = `Defeated with ${got} of ${coins.length} coins\nPress R to play again`
    } else if (!over && coins.length && got === coins.length) {
      over = true
      message.textContent = `You win: every coin, ${kills} enem${kills === 1 ? 'y' : 'ies'} defeated\nPress R to play again`
    }
    healthBar.style.width = `${Math.max(health, 0)}%`
    staminaBar.style.width = `${stamina}%`
    score.textContent = `Coins ${got}/${coins.length} · Defeated ${kills}`
    controls.update()
    renderer.render(scene, camera)
  })
}

main().catch(err => {
  message.textContent = `Could not start the game: ${err.message}\nPut the animated GLB in this folder as ${CONFIG.model} and serve the folder over http.`
})
