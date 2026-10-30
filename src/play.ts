/**
 * Game Studio's playable character: which clip plays what, keyboard input, and one step of movement per frame.
 * Shared by the Desktop card's Play mode (stage.ts) and the playable web template, whose play.js is this file built
 * by `npm run build`. Plain numbers and DOM events, no three.js: callers hand in clip names and track arrays and
 * apply the returned pose to their model.
 */

export type Role = 'idle' | 'walk' | 'run' | 'jump' | 'attack' | 'hurt'
export type Roles = Record<Role, number | null>
export type XZ = readonly [number, number]

export interface Keys {
  forward: boolean
  back: boolean
  left: boolean
  right: boolean
  run: boolean
  jump: boolean
  attack: boolean
}

export interface Track {
  name: string
  times: ArrayLike<number>
  values: { readonly length: number; [index: number]: number }
}

export interface CharacterOptions {
  roles: Roles
  /** Each clip's length in seconds, by index. */
  durations: readonly number[]
  /** The model's height: speeds, the jump and the lunge scale with it. */
  height: number
  /** How far the walk clip carried the model (world XZ) before stripTravel took it out: its pace and its front. */
  travel?: XZ | null
  /** From the model's right side to its left (see leftward): its front when the walk did not travel. */
  left?: XZ | null
  /** A clip holding the walk's first frame, to idle in when the model has no idle clip. */
  still?: number | null
  /** Keep the character within this distance of where it started. */
  bounds?: number
}

export interface Pose {
  x: number
  y: number
  z: number
  /** The way the character faces, as a yaw (0: +Z). Turn a pivot by it; the model sits in it turned by -facing. */
  heading: number
  /** Forward lean in radians, about the pivot's X axis. */
  lean: number
  role: Role
  /** The clip to play (null: none), its speed, and whether it plays once and holds its last frame. */
  clip: number | null
  timeScale: number
  once: boolean
  /** A jump or an attack starts this frame: restart its clip. */
  start: boolean
  /** An attack lands this frame. */
  strike: boolean
}

export interface Character {
  /** The yaw the model faces in its own file (Tripo's characters usually face +X: π/2). */
  readonly facing: number
  /** Walking pace, in scene units per second. */
  readonly pace: number
  /** `view`: the yaw the camera looks along, so W walks away from it. */
  step: (dt: number, keys: Keys, view: number) => Pose
}

const ROLE_NAMES: readonly (readonly [Role, RegExp])[] = [
  ['idle', /idle|stand|breath/i],
  ['walk', /walk|march|crawl|swim/i],
  ['run', /run|sprint|gallop/i],
  ['jump', /jump|leap/i],
  ['attack', /slash|attack|shoot|punch|kick|bite|strike/i],
  // Game code plays it when the character is hit; step() never picks it.
  ['hurt', /hurt|damage/i]
]

const CODES: Readonly<Record<string, keyof Keys>> = {
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  ShiftLeft: 'run',
  ShiftRight: 'run',
  Space: 'jump',
  KeyJ: 'attack',
  KeyF: 'attack'
}

export const CONTROLS = 'WASD or arrows move · Shift runs · Space jumps · J attacks'

/** A run without a run clip plays the walk this much faster. */
export const RUN_RATE = 1.6
const TURN = 12
const ACCEL = 12
const JUMP = { height: 0.35, seconds: 0.6, longest: 1.1 }
const ATTACK = { lean: 0.3, lunge: 0.12, seconds: 0.45, longest: 0.9, lands: 0.4 }
const LEFT = /(^|[^a-z])l([^a-z]|$)|left/i
const RIGHT = /(^|[^a-z])r([^a-z]|$)|right/i

/** The clip each role plays, by name (Tripo names a clip after its preset: walk, quadruped:walk, serpentine:march);
 *  when no name says anything, the first clip walks. */
export function clipRoles(names: readonly string[]): Roles {
  const roles = {} as Roles
  for (const [role, pattern] of ROLE_NAMES) {
    const index = names.findIndex(name => pattern.test(name))
    roles[role] = index < 0 ? null : index
  }
  if (names.length && Object.values(roles).every(index => index === null)) {
    roles.walk = 0
  }
  return roles
}

/** Takes the net travel out of a clip's position tracks, in place: a walk that moves off plays on the spot with its
 *  sway and bob kept, and game code moves the character instead. Returns the track that travelled furthest. */
export function stripTravel(tracks: readonly Track[]): { track: string; travel: [number, number, number] } | null {
  let best: { track: string; travel: [number, number, number] } | null = null
  for (const t of tracks) {
    const n = t.times.length
    const span = t.times[n - 1] - t.times[0]
    if (!t.name.endsWith('.position') || n < 2 || t.values.length !== n * 3 || !(span > 0)) {
      continue
    }
    const travel: [number, number, number] = [0, 0, 0]
    for (let a = 0; a < 3; a += 1) {
      travel[a] = t.values[(n - 1) * 3 + a] - t.values[a]
    }
    for (let k = 0; k < n; k += 1) {
      const f = (t.times[k] - t.times[0]) / span
      for (let a = 0; a < 3; a += 1) {
        t.values[k * 3 + a] -= f * travel[a]
      }
    }
    if (!best || Math.hypot(...travel) > Math.hypot(...best.travel)) {
      best = { track: t.name, travel }
    }
  }
  return best
}

/** Where a jump clip's first hop lands when the clip hops more than once (Tripo's preset:jump hops five times in 2.2 s),
 *  for callers to cut it there so that one press jumps once; null for a single jump. The body is the position track
 *  that rises furthest in world height, `parent` giving the world matrix (column-major, as three's
 *  `matrixWorld.elements`) of the node above a track's node. A hop rises past halfway from the clip's first height to
 *  its highest, and lands at the lowest point before the next. */
export function firstHop(tracks: readonly Track[], parent: (track: string) => ArrayLike<number> | null | undefined): number | null {
  let body: { times: ArrayLike<number>; ys: number[]; rise: number } | null = null
  for (const t of tracks) {
    const n = t.times.length
    const m = t.name.endsWith('.position') && n > 1 && t.values.length === n * 3 ? parent(t.name) : null
    if (!m) {
      continue
    }
    const ys = Array.from({ length: n }, (_, k) => m[1] * t.values[k * 3] + m[5] * t.values[k * 3 + 1] + m[9] * t.values[k * 3 + 2])
    const rise = Math.max(...ys) - ys[0]
    if (!body || rise > body.rise) {
      body = { times: t.times, ys, rise }
    }
  }
  if (!body || !(body.rise > 0)) {
    return null
  }
  const { times, ys } = body
  const high = ys[0] + body.rise / 2
  let k = ys.findIndex(y => y > high)
  while (k < ys.length && ys[k] > high) {
    k += 1
  }
  let low = k
  for (; k < ys.length && ys[k] <= high; k += 1) {
    low = ys[k] < ys[low] ? k : low
  }
  return k < ys.length ? times[low] : null
}

/** From the model's right side to its left, by bone names (L_Thigh, thigh_l, LeftUpLeg, hand.L ...). */
export function leftward(points: readonly { name: string; x: number; z: number }[]): XZ | null {
  const mean = (pattern: RegExp) => {
    const side = points.filter(p => pattern.test(p.name))
    return side.length ? [side.reduce((s, p) => s + p.x, 0) / side.length, side.reduce((s, p) => s + p.z, 0) / side.length] : null
  }
  const l = mean(LEFT)
  const r = mean(RIGHT)
  return l && r ? [l[0] - r[0], l[1] - r[1]] : null
}

/** The yaw a model faces (0: +Z, glTF's front): the way its walk carried it, else a quarter turn from its left,
 *  else +X, where Tripo's characters face. */
export function facingYaw(travel: XZ | null, left: XZ | null): number {
  if (travel && Math.hypot(travel[0], travel[1]) > 1e-9) {
    return Math.atan2(travel[0], travel[1])
  }
  if (left && Math.hypot(left[0], left[1]) > 1e-9) {
    return Math.atan2(-left[1], left[0])
  }
  return Math.PI / 2
}

/** The signed turn from yaw `from` to yaw `to`, in (-π, π]. */
export function turnTo(from: number, to: number): number {
  const d = (to - from) % (2 * Math.PI)
  return d > Math.PI ? d - 2 * Math.PI : d <= -Math.PI ? d + 2 * Math.PI : d
}

/** Whether a point is within `range` of the pose and inside ±`arc` of its heading. */
export function inReach(pose: Pick<Pose, 'x' | 'z' | 'heading'>, x: number, z: number, range: number, arc = Math.PI / 3): boolean {
  const d = Math.hypot(x - pose.x, z - pose.z)
  return d <= range && (d < 1e-9 || Math.abs(turnTo(pose.heading, Math.atan2(x - pose.x, z - pose.z))) <= arc)
}

export function noKeys(): Keys {
  return { forward: false, back: false, left: false, right: false, run: false, jump: false, attack: false }
}

/** Keys held while `el` has focus (make it focusable): typing anywhere else never moves the character, and the page
 *  around it neither scrolls nor sees the keys it takes. */
export function bindKeys(el: EventTarget): { keys: Keys; unbind: () => void } {
  const keys = noKeys()
  const press = (down: boolean) => (event: Event) => {
    const e = event as KeyboardEvent
    const name = CODES[e.code]
    if (name && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      e.stopPropagation()
      keys[name] = down
    }
  }
  const down = press(true)
  const up = press(false)
  const clear = () => Object.assign(keys, noKeys())
  el.addEventListener('keydown', down)
  el.addEventListener('keyup', up)
  el.addEventListener('blur', clear)
  return {
    keys,
    unbind() {
      el.removeEventListener('keydown', down)
      el.removeEventListener('keyup', up)
      el.removeEventListener('blur', clear)
      clear()
    }
  }
}

export function createCharacter(options: CharacterOptions): Character {
  const { roles, durations } = options
  const h = options.height > 0 ? options.height : 1
  const travel = options.travel && Math.hypot(options.travel[0], options.travel[1]) > 0.05 * h ? options.travel : null
  const facing = facingYaw(travel, options.left ?? null)
  const walked = travel && roles.walk !== null && durations[roles.walk] > 0 ? Math.hypot(travel[0], travel[1]) / durations[roles.walk] : 0
  const pace = walked ? Math.min(Math.max(walked, 0.3 * h), 2 * h) : 0.7 * h
  const sprint = pace * (roles.run !== null ? 2.4 : RUN_RATE)
  const still = options.still ?? null

  // A clip's play rate and length as a jump or an attack: long clips play faster so a move stays snappy.
  const timing = (clip: number | null, seconds: number, longest: number) => {
    const length = clip === null ? 0 : durations[clip] || 0
    const rate = length > longest ? length / longest : 1
    return length > 0 ? { rate, length: length / rate } : { rate: 1, length: seconds }
  }
  const loop = (role: Role): [number | null, number] => {
    if (role === 'run') {
      return roles.run !== null ? [roles.run, 1] : [roles.walk, RUN_RATE]
    }
    if (role === 'walk') {
      return roles.walk !== null ? [roles.walk, 1] : [roles.run, 0.6]
    }
    return [roles.idle ?? still, 1]
  }

  let x = 0
  let z = 0
  let heading = facing
  let speed = 0
  let time = 0
  let held = { jump: false, attack: false }
  let act: { role: 'jump' | 'attack'; t: number; rate: number; length: number; landed: boolean } | null = null

  return {
    facing,
    pace,
    step(dt, keys, view) {
      dt = Math.min(Math.max(dt, 0), 0.1)
      time += dt
      const ahead = Number(keys.forward) - Number(keys.back)
      const aside = Number(keys.right) - Number(keys.left)
      // Screen-right of a camera looking along yaw `view` is (-cos, sin).
      const mx = ahead * Math.sin(view) - aside * Math.cos(view)
      const mz = ahead * Math.cos(view) + aside * Math.sin(view)
      const moving = Math.hypot(mx, mz) > 1e-9

      let start = false
      if (!act && keys.jump && !held.jump) {
        act = { role: 'jump', t: 0, landed: false, ...timing(roles.jump, JUMP.seconds, JUMP.longest) }
        start = true
      } else if (!act && keys.attack && !held.attack) {
        act = { role: 'attack', t: 0, landed: false, ...timing(roles.attack, ATTACK.seconds, ATTACK.longest) }
        start = true
      }
      held = { jump: keys.jump, attack: keys.attack }
      const rooted = act?.role === 'attack'

      speed += ((moving && !rooted ? (keys.run ? sprint : pace) : 0) - speed) * (1 - Math.exp(-ACCEL * dt))
      if (moving && !rooted) {
        const turn = turnTo(heading, Math.atan2(mx, mz))
        heading += Math.sign(turn) * Math.min(Math.abs(turn), TURN * dt)
      }
      x += Math.sin(heading) * speed * dt
      z += Math.cos(heading) * speed * dt
      if (options.bounds && Math.hypot(x, z) > options.bounds) {
        const k = options.bounds / Math.hypot(x, z)
        x *= k
        z *= k
      }

      let role: Role = moving && !rooted ? (keys.run ? 'run' : 'walk') : 'idle'
      let [clip, timeScale] = loop(role)
      let once = false
      let y = 0
      let lean = 0
      let lunge = 0
      let strike = false
      if (act) {
        act.t += dt
        const f = Math.min(act.t / act.length, 1)
        role = act.role
        const own = roles[act.role]
        if (own !== null) {
          clip = own
          timeScale = act.rate
          once = true
        } else if (act.role === 'jump') {
          y = 4 * JUMP.height * h * f * (1 - f)
        } else {
          lean = ATTACK.lean * Math.sin(Math.PI * f)
          lunge = ATTACK.lunge * h * Math.sin(Math.PI * f)
        }
        if (act.role === 'attack' && !act.landed && f >= ATTACK.lands) {
          act.landed = true
          strike = true
        }
        if (act.t >= act.length) {
          act = null
        }
      } else if (role === 'idle' && roles.idle === null) {
        y = Math.sin((time * 2 * Math.PI) / 3) * 0.006 * h // breathe while holding a still frame
      } else if (clip === null) {
        y = Math.abs(Math.sin(time * Math.PI * (role === 'run' ? 4 : 2.6))) * 0.03 * h // hop along without a clip
      }
      return {
        x: x + Math.sin(heading) * lunge,
        y,
        z: z + Math.cos(heading) * lunge,
        heading,
        lean,
        role,
        clip,
        timeScale,
        once,
        start,
        strike
      }
    }
  }
}
