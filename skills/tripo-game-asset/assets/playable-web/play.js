// Built from the Tripo Hermes plugin's src/play.ts (npm run build).
const ROLE_NAMES = [
  ["idle", /idle|stand|breath/i],
  ["walk", /walk|march|crawl|swim/i],
  ["run", /run|sprint|gallop/i],
  ["jump", /jump|leap/i],
  ["attack", /slash|attack|shoot|punch|kick|bite|strike/i],
  // Game code plays it when the character is hit; step() never picks it.
  ["hurt", /hurt|damage/i]
];
const CODES = {
  KeyW: "forward",
  ArrowUp: "forward",
  KeyS: "back",
  ArrowDown: "back",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
  ShiftLeft: "run",
  ShiftRight: "run",
  Space: "jump",
  KeyJ: "attack",
  KeyF: "attack"
};
const CONTROLS = "WASD or arrows move \xB7 Shift runs \xB7 Space jumps \xB7 J attacks";
const RUN_RATE = 1.6;
const TURN = 12;
const ACCEL = 12;
const JUMP = { height: 0.35, seconds: 0.6, longest: 1.1 };
const ATTACK = { lean: 0.3, lunge: 0.12, seconds: 0.45, longest: 0.9, lands: 0.4 };
const LEFT = /(^|[^a-z])l([^a-z]|$)|left/i;
const RIGHT = /(^|[^a-z])r([^a-z]|$)|right/i;
function clipRoles(names) {
  const roles = {};
  for (const [role, pattern] of ROLE_NAMES) {
    const index = names.findIndex((name) => pattern.test(name));
    roles[role] = index < 0 ? null : index;
  }
  if (names.length && Object.values(roles).every((index) => index === null)) {
    roles.walk = 0;
  }
  return roles;
}
function stripTravel(tracks) {
  let best = null;
  for (const t of tracks) {
    const n = t.times.length;
    const span = t.times[n - 1] - t.times[0];
    if (!t.name.endsWith(".position") || n < 2 || t.values.length !== n * 3 || !(span > 0)) {
      continue;
    }
    const travel = [0, 0, 0];
    for (let a = 0; a < 3; a += 1) {
      travel[a] = t.values[(n - 1) * 3 + a] - t.values[a];
    }
    for (let k = 0; k < n; k += 1) {
      const f = (t.times[k] - t.times[0]) / span;
      for (let a = 0; a < 3; a += 1) {
        t.values[k * 3 + a] -= f * travel[a];
      }
    }
    if (!best || Math.hypot(...travel) > Math.hypot(...best.travel)) {
      best = { track: t.name, travel };
    }
  }
  return best;
}
function firstHop(tracks, parent) {
  let body = null;
  for (const t of tracks) {
    const n = t.times.length;
    const m = t.name.endsWith(".position") && n > 1 && t.values.length === n * 3 ? parent(t.name) : null;
    if (!m) {
      continue;
    }
    const ys2 = Array.from({ length: n }, (_, k2) => m[1] * t.values[k2 * 3] + m[5] * t.values[k2 * 3 + 1] + m[9] * t.values[k2 * 3 + 2]);
    const rise = Math.max(...ys2) - ys2[0];
    if (!body || rise > body.rise) {
      body = { times: t.times, ys: ys2, rise };
    }
  }
  if (!body || !(body.rise > 0)) {
    return null;
  }
  const { times, ys } = body;
  const high = ys[0] + body.rise / 2;
  let k = ys.findIndex((y) => y > high);
  while (k < ys.length && ys[k] > high) {
    k += 1;
  }
  let low = k;
  for (; k < ys.length && ys[k] <= high; k += 1) {
    low = ys[k] < ys[low] ? k : low;
  }
  return k < ys.length ? times[low] : null;
}
function leftward(points) {
  const mean = (pattern) => {
    const side = points.filter((p) => pattern.test(p.name));
    return side.length ? [side.reduce((s, p) => s + p.x, 0) / side.length, side.reduce((s, p) => s + p.z, 0) / side.length] : null;
  };
  const l = mean(LEFT);
  const r = mean(RIGHT);
  return l && r ? [l[0] - r[0], l[1] - r[1]] : null;
}
function facingYaw(travel, left) {
  if (travel && Math.hypot(travel[0], travel[1]) > 1e-9) {
    return Math.atan2(travel[0], travel[1]);
  }
  if (left && Math.hypot(left[0], left[1]) > 1e-9) {
    return Math.atan2(-left[1], left[0]);
  }
  return Math.PI / 2;
}
function turnTo(from, to) {
  const d = (to - from) % (2 * Math.PI);
  return d > Math.PI ? d - 2 * Math.PI : d <= -Math.PI ? d + 2 * Math.PI : d;
}
function inReach(pose, x, z, range, arc = Math.PI / 3) {
  const d = Math.hypot(x - pose.x, z - pose.z);
  return d <= range && (d < 1e-9 || Math.abs(turnTo(pose.heading, Math.atan2(x - pose.x, z - pose.z))) <= arc);
}
function noKeys() {
  return { forward: false, back: false, left: false, right: false, run: false, jump: false, attack: false };
}
function bindKeys(el) {
  const keys = noKeys();
  const press = (down2) => (event) => {
    const e = event;
    const name = CODES[e.code];
    if (name && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      keys[name] = down2;
    }
  };
  const down = press(true);
  const up = press(false);
  const clear = () => Object.assign(keys, noKeys());
  el.addEventListener("keydown", down);
  el.addEventListener("keyup", up);
  el.addEventListener("blur", clear);
  return {
    keys,
    unbind() {
      el.removeEventListener("keydown", down);
      el.removeEventListener("keyup", up);
      el.removeEventListener("blur", clear);
      clear();
    }
  };
}
function createCharacter(options) {
  const { roles, durations } = options;
  const h = options.height > 0 ? options.height : 1;
  const travel = options.travel && Math.hypot(options.travel[0], options.travel[1]) > 0.05 * h ? options.travel : null;
  const facing = facingYaw(travel, options.left ?? null);
  const walked = travel && roles.walk !== null && durations[roles.walk] > 0 ? Math.hypot(travel[0], travel[1]) / durations[roles.walk] : 0;
  const pace = walked ? Math.min(Math.max(walked, 0.3 * h), 2 * h) : 0.7 * h;
  const sprint = pace * (roles.run !== null ? 2.4 : RUN_RATE);
  const still = options.still ?? null;
  const timing = (clip, seconds, longest) => {
    const length = clip === null ? 0 : durations[clip] || 0;
    const rate = length > longest ? length / longest : 1;
    return length > 0 ? { rate, length: length / rate } : { rate: 1, length: seconds };
  };
  const loop = (role) => {
    if (role === "run") {
      return roles.run !== null ? [roles.run, 1] : [roles.walk, RUN_RATE];
    }
    if (role === "walk") {
      return roles.walk !== null ? [roles.walk, 1] : [roles.run, 0.6];
    }
    return [roles.idle ?? still, 1];
  };
  let x = 0;
  let z = 0;
  let heading = facing;
  let speed = 0;
  let time = 0;
  let held = { jump: false, attack: false };
  let act = null;
  return {
    facing,
    pace,
    step(dt, keys, view) {
      dt = Math.min(Math.max(dt, 0), 0.1);
      time += dt;
      const ahead = Number(keys.forward) - Number(keys.back);
      const aside = Number(keys.right) - Number(keys.left);
      const mx = ahead * Math.sin(view) - aside * Math.cos(view);
      const mz = ahead * Math.cos(view) + aside * Math.sin(view);
      const moving = Math.hypot(mx, mz) > 1e-9;
      let start = false;
      if (!act && keys.jump && !held.jump) {
        act = { role: "jump", t: 0, landed: false, ...timing(roles.jump, JUMP.seconds, JUMP.longest) };
        start = true;
      } else if (!act && keys.attack && !held.attack) {
        act = { role: "attack", t: 0, landed: false, ...timing(roles.attack, ATTACK.seconds, ATTACK.longest) };
        start = true;
      }
      held = { jump: keys.jump, attack: keys.attack };
      const rooted = act?.role === "attack";
      speed += ((moving && !rooted ? keys.run ? sprint : pace : 0) - speed) * (1 - Math.exp(-ACCEL * dt));
      if (moving && !rooted) {
        const turn = turnTo(heading, Math.atan2(mx, mz));
        heading += Math.sign(turn) * Math.min(Math.abs(turn), TURN * dt);
      }
      x += Math.sin(heading) * speed * dt;
      z += Math.cos(heading) * speed * dt;
      if (options.bounds && Math.hypot(x, z) > options.bounds) {
        const k = options.bounds / Math.hypot(x, z);
        x *= k;
        z *= k;
      }
      let role = moving && !rooted ? keys.run ? "run" : "walk" : "idle";
      let [clip, timeScale] = loop(role);
      let once = false;
      let y = 0;
      let lean = 0;
      let lunge = 0;
      let strike = false;
      if (act) {
        act.t += dt;
        const f = Math.min(act.t / act.length, 1);
        role = act.role;
        const own = roles[act.role];
        if (own !== null) {
          clip = own;
          timeScale = act.rate;
          once = true;
        } else if (act.role === "jump") {
          y = 4 * JUMP.height * h * f * (1 - f);
        } else {
          lean = ATTACK.lean * Math.sin(Math.PI * f);
          lunge = ATTACK.lunge * h * Math.sin(Math.PI * f);
        }
        if (act.role === "attack" && !act.landed && f >= ATTACK.lands) {
          act.landed = true;
          strike = true;
        }
        if (act.t >= act.length) {
          act = null;
        }
      } else if (role === "idle" && roles.idle === null) {
        y = Math.sin(time * 2 * Math.PI / 3) * 6e-3 * h;
      } else if (clip === null) {
        y = Math.abs(Math.sin(time * Math.PI * (role === "run" ? 4 : 2.6))) * 0.03 * h;
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
      };
    }
  };
}
export {
  CONTROLS,
  RUN_RATE,
  bindKeys,
  clipRoles,
  createCharacter,
  facingYaw,
  firstHop,
  inReach,
  leftward,
  noKeys,
  stripTravel,
  turnTo
};
