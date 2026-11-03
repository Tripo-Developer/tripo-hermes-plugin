# Playable web prototype

A three.js arena for an animated Tripo character, built from this skill's `assets/playable-web/`
template, with no Tripo credits: the character walks, runs, jumps, attacks and uses a special move
while enemies chase it and coins wait to be collected; other Tripo models join in as props.
`play.js` is the same character logic as the Desktop card's Play mode; `game.js` is the game
around it.

## Build it

1. **The folder.** Ask the user where it goes (an absolute path, e.g. `~/Games/dragon-arena`).
   Never write into the skill's own folder.
2. **The template.** `skill_view` of this skill returns `skill_dir`. Copy the three files of its
   `assets/playable-web/` (`index.html`, `game.js`, `play.js`) into the folder with the terminal
   tool, e.g. `mkdir -p "<folder>" && cp "<skill_dir>"/assets/playable-web/* "<folder>"/`.
3. **The character.** `tripo_download` `{task_id: <animation task>, output_dir: "<folder>"}` saves
   the animated model there. Set `CONFIG.model` in `game.js` to the saved `model_file` name, or
   rename the file to `character.glb`. Clips made on the same rig by another animation task:
   download that task too and list its model file in `CONFIG.clips`. No animated character in
   this chat: set `CONFIG.model` to `null`, and a capsule stand-in plays.
4. **CONFIG**, at the top of `game.js`, from what the user asked for:
   - `height`: the character's height in metres (1.8 for a person, 4 for a dragon);
   - `special`: the move on K, its `name` and `color` (Fire breath for a dragon, a laser for a
     robot, frost for a mage), or `null` for none;
   - `enemies`: `count`, and another animated Tripo GLB as `model`, with its `height`, instead of
     slimes;
   - `coins` to collect to win, and the arena radius `arena` in metres;
   - `props`: other Tripo models in the game ([Props](#props));
   - `roles` when a clip's name does not say what it does, e.g. `{ attack: "Spin" }`.
5. **Serve it** on this machine only:
   `terminal(command="python3 -m http.server 8000 --bind 127.0.0.1", workdir="<folder>", background=true)`
   (`python` on Windows; another port when 8000 is taken). Check it in a separate call:
   `curl -sI http://127.0.0.1:8000/` answers `200`.
6. **Hand it over**: the link http://127.0.0.1:8000, the controls (WASD or arrows move, Shift
   runs, Space jumps, J attacks, K the special move, R restarts) and the folder. The page loads
   three.js from cdn.jsdelivr.net, so the browser needs the internet. The link only works on the
   Hermes machine: in a chat app send the folder path and, when it fits the upload caps, the zipped
   folder. The server stops with the session; the command above, run in the folder, starts it
   again.

## Props

A model without a rig (a chest, a sword, a crystal, a rock) goes in `CONFIG.props`, which takes
any number of entries:
`{ model: "crate.glb", role: "breakable", count: 4, height: 0.8 }`. `tripo_download` it into the
folder and rename the saved `model_file` after what it is right away, and the character's file
first if it still has its download name: every task saves `pbr_model.glb` or `model.glb`, so the
next download would overwrite it. `height` is in metres, a
weapon's its length; `count` copies go around the arena. Roles:

- `pickup`: bobs and spins; the character collects it by touching it, and every pickup counts
  toward the win with the coins (`coins: 0` for pickups alone).
- `weapon`: one, in the character's right hand (its bone by name: `Right_Hand`, `R_Hand`, `RightHand`,
  `mixamorig:RightHand`, `hand_r` ...), standing upright as in its first idle frame; strikes reach
  further by its length. When it sits badly in the hand, turn it with
  `grip: [x, y, z]`, degrees about the character's own axes (x tilts it forward). Without an attack
  clip it swings in the hand.
- `breakable`: a strike or the special move shatters it into shards, for a point; R restores it.
- `obstacle`: the character and the enemies walk around it.

No animated character yet: `CONFIG.model: null` puts a capsule stand-in in its place, so a set of
props plays on its own. On Desktop, the model card's viewer shows each role first (Prop preview in
its toolbar).

## Grow it

Edit `game.js` and keep `play.js` as it is. Common asks:

- More or tougher enemies: `CONFIG.enemies`, their speed (`character.pace * 0.6`) and the damage
  per hit (`health -= 10`); waves by raising the count as the score grows.
- A boss: another Tripo model as an enemy, taller, with hit points so it takes several strikes.
- New moves: copy the special move's block (its particles and the `inReach` cone) onto another key.
- Levels: a new arena size, more coins or a time limit, reset with `restart()`.
- Scenery: more Tripo models in `CONFIG.props` as obstacles; animated ones loaded with `prepare()`
  and placed around the arena.
