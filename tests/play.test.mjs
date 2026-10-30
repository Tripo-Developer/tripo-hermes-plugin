// node --test tests/play.test.mjs
// src/play.ts, Game Studio's character logic, driven with plain arrays and fake key events.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bindKeys, clipRoles, createCharacter, facingYaw, firstHop, inReach, leftward, noKeys, RUN_RATE, stripTravel, turnTo } from '../src/play.ts'

const near = (actual, expected, eps = 1e-6) => assert.ok(Math.abs(actual - expected) < eps, `${actual} ≉ ${expected}`)
const run = (character, seconds, keys, view = 0) => {
  let pose
  for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
    pose = character.step(1 / 60, keys, view)
  }
  return pose
}
const press = over => ({ ...noKeys(), ...over })

test('clips get roles by their preset names, and a clip no name explains walks', () => {
  assert.deepEqual(clipRoles(['idle', 'walk', 'run', 'jump', 'slash', 'hurt']), { idle: 0, walk: 1, run: 2, jump: 3, attack: 4, hurt: 5 })
  assert.deepEqual(clipRoles(['walk']), { idle: null, walk: 0, run: null, jump: null, attack: null, hurt: null })
  assert.equal(clipRoles(['quadruped:walk']).walk, 0)
  assert.equal(clipRoles(['preset:serpentine:march']).walk, 0)
  assert.deepEqual(clipRoles(['turn', 'walk']), { idle: null, walk: 1, run: null, jump: null, attack: null, hurt: null })
  assert.equal(clipRoles(['mixamo.com']).walk, 0)
  assert.deepEqual(clipRoles([]), { idle: null, walk: null, run: null, jump: null, attack: null, hurt: null })
})

test('a walk that travels plays on the spot: the net travel goes, the sway and bob stay', () => {
  // Tripo's walk moves Hip about 1.46 units over 2.33 s; BoneRoot stays put.
  const hip = { name: 'Hip.position', times: new Float32Array([0, 1, 2]), values: new Float32Array([0, 0, 0, 1.2, 0.1, 0.05, 2, 0, 0]) }
  const root = { name: 'BoneRoot.position', times: new Float32Array([0, 2]), values: new Float32Array([0, 0.5, 0, 0, 0.5, 0]) }
  const turn = { name: 'Hip.quaternion', times: new Float32Array([0, 2]), values: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]) }
  const out = stripTravel([root, hip, turn])
  assert.equal(out.track, 'Hip.position')
  assert.deepEqual(out.travel.map(v => +v.toFixed(6)), [2, 0, 0])
  assert.deepEqual([...hip.values].map(v => +v.toFixed(6)), [0, 0, 0, 0.2, 0.1, 0.05, 0, 0, 0])
  assert.deepEqual([...root.values], [0, 0.5, 0, 0, 0.5, 0])
  assert.equal(stripTravel([turn]), null)
})

test('a model faces the way its walk went, else a quarter turn from its left, else +X like Tripo’s', () => {
  near(facingYaw([1.46, 0.07], null), Math.atan2(1.46, 0.07))
  // Tripo's robot: L_Thigh at z -0.068, R_Thigh at z 0.064, so its left is -Z and it faces +X.
  const left = leftward([
    { name: 'L_Thigh', x: 0.01, z: -0.068 },
    { name: 'R_Thigh', x: 0.01, z: 0.064 },
    { name: 'Hip', x: 0.013, z: -0.003 }
  ])
  assert.deepEqual(left.map(v => +v.toFixed(3)), [0, -0.132])
  near(facingYaw(null, left), Math.PI / 2)
  near(facingYaw(null, leftward([{ name: 'thigh_l', x: 1, z: 0 }, { name: 'thigh_r', x: -1, z: 0 }])), 0)
  near(facingYaw(null, leftward([{ name: 'mixamorigLeftHand', x: 0, z: 1 }, { name: 'mixamorigRightHand', x: 0, z: -1 }])), -Math.PI / 2)
  assert.equal(leftward([{ name: 'Spine', x: 0, z: 0 }]), null)
  near(facingYaw(null, null), Math.PI / 2)
  near(turnTo(3, -3), 2 * Math.PI - 6)
})

test('W walks away from the camera at the walk clip’s own pace, turning the character to face its way', () => {
  const roles = clipRoles(['walk', 'still'])
  const character = createCharacter({ roles, durations: [2.333, 0], height: 1, travel: [1.46, 0], still: 1 })
  near(character.facing, Math.PI / 2)
  near(character.pace, 1.46 / 2.333)
  let pose = character.step(1 / 60, noKeys(), 0)
  assert.equal(pose.role, 'idle')
  assert.equal(pose.clip, 1) // no idle clip: hold the walk's first frame
  near(pose.heading, Math.PI / 2)

  pose = run(character, 2, press({ forward: true }), 0) // the camera looks along +Z
  assert.equal(pose.role, 'walk')
  assert.deepEqual([pose.clip, pose.timeScale, pose.once], [0, 1, false])
  near(pose.heading, 0, 1e-3)
  assert.ok(pose.z > 0.9 && Math.abs(pose.x) < 0.1, `${pose.x}, ${pose.z}`)

  pose = run(character, 0.5, press({ forward: true, run: true }), 0)
  assert.deepEqual([pose.role, pose.clip, pose.timeScale], ['run', 0, RUN_RATE])

  pose = run(character, 1, press({ right: true }), 0) // screen-right of a camera looking along +Z is -X
  near(pose.heading, -Math.PI / 2, 1e-3)
})

test('Space jumps once per press: a procedural arc without a jump clip, the clip played once with one', () => {
  const plain = createCharacter({ roles: clipRoles(['walk']), durations: [1], height: 2 })
  const first = plain.step(1 / 60, press({ jump: true }), 0)
  assert.equal(first.start, true)
  const mid = run(plain, 0.28, press({ jump: true }), 0)
  assert.equal(mid.role, 'jump')
  assert.ok(mid.y > 0.5, `${mid.y}`) // about 0.35 heights up at the top
  const landed = run(plain, 1, press({ jump: true }), 0)
  assert.equal(landed.role, 'idle') // holding Space does not jump again
  assert.ok(landed.y < 0.05)

  const clipped = createCharacter({ roles: clipRoles(['walk', 'jump']), durations: [1, 2.2], height: 1 })
  const jump = clipped.step(1 / 60, press({ jump: true }), 0)
  assert.deepEqual([jump.role, jump.clip, jump.once, jump.timeScale, jump.y], ['jump', 1, true, 2, 0])
})

test('a jump clip that hops more than once is cut where its first hop lands, by world height; one jump is kept whole', () => {
  // Tripo's preset:jump hops five times; here three, Hips under a Y-up Armature (column-major world matrices).
  const yUp = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const zUp = () => [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1] // rotated -90° about X: local +Z is up
  const times = new Float32Array([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1])
  const heights = [0.52, 0.6, 0.72, 0.6, 0.47, 0.6, 0.75, 0.6, 0.5, 0.67, 0.52]
  const hips = { name: 'Hips.position', times, values: new Float32Array(heights.flatMap(y => [0, y, 0])) }
  const spine = { name: 'Spine.position', times: new Float32Array([0, 1]), values: new Float32Array([0, 0.1, 0, 0, 0.1, 0]) }
  const turn = { name: 'Hips.quaternion', times: new Float32Array([0, 1]), values: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]) }
  near(firstHop([spine, turn, hips], yUp), 0.4)
  const zHips = { name: 'Hips.position', times, values: new Float32Array(heights.flatMap(y => [0, 0, y])) }
  near(firstHop([zHips], zUp), 0.4)
  assert.equal(firstHop([zHips], yUp), null)

  // Crouch, leap, land, stand up.
  const once = { name: 'Hips.position', times: new Float32Array([0, 0.2, 0.4, 0.6, 0.8]), values: new Float32Array([0.55, 0.45, 0.8, 0.45, 0.55].flatMap(y => [0, y, 0])) }
  assert.equal(firstHop([once], yUp), null)
  assert.equal(firstHop([turn], yUp), null)
  assert.equal(firstHop([hips], () => null), null)
})

test('an attack roots the character, lands once, and lunges when there is no attack clip', () => {
  const character = createCharacter({ roles: clipRoles(['walk']), durations: [1], height: 1 })
  let strikes = 0
  let lean = 0
  let moved = 0
  const start = character.step(1 / 60, noKeys(), 0)
  for (let i = 0; i < 26; i += 1) { // the lunge lasts 0.45 s
    const pose = character.step(1 / 60, press({ attack: true, forward: i > 0 }), 0)
    strikes += pose.strike ? 1 : 0
    lean = Math.max(lean, pose.lean)
    moved = Math.max(moved, Math.abs(pose.heading - start.heading))
  }
  assert.equal(strikes, 1)
  assert.ok(lean > 0.25)
  assert.equal(moved, 0) // W during the attack does not turn it
  assert.ok(inReach({ x: 0, z: 0, heading: 0 }, 0.1, 1, 1.5))
  assert.ok(!inReach({ x: 0, z: 0, heading: 0 }, 0, -1, 1.5))
  assert.ok(!inReach({ x: 0, z: 0, heading: 0 }, 0, 2, 1.5))
})

test('bounds keep the character near its start', () => {
  const character = createCharacter({ roles: clipRoles([]), durations: [], height: 1, bounds: 2 })
  const pose = run(character, 10, press({ forward: true, run: true }), 0)
  assert.ok(Math.hypot(pose.x, pose.z) <= 2 + 1e-9)
  assert.equal(pose.clip, null)
})

test('keys count only on the element they are bound to, never with a shortcut modifier', () => {
  const el = new EventTarget()
  const key = (type, code, extra = {}) => {
    const e = Object.assign(new Event(type, { cancelable: true }), { code, ...extra })
    el.dispatchEvent(e)
    return e
  }
  const { keys, unbind } = bindKeys(el)
  assert.equal(key('keydown', 'KeyW').defaultPrevented, true)
  key('keydown', 'Space')
  assert.deepEqual([keys.forward, keys.jump], [true, true])
  assert.equal(key('keydown', 'KeyD', { metaKey: true }).defaultPrevented, false)
  assert.equal(keys.right, false)
  assert.equal(key('keydown', 'KeyQ').defaultPrevented, false)
  key('keyup', 'KeyW')
  assert.equal(keys.forward, false)
  el.dispatchEvent(new Event('blur'))
  assert.equal(keys.jump, false)
  unbind()
  key('keydown', 'KeyW')
  assert.equal(keys.forward, false)
})
