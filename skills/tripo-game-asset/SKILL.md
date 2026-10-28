---
name: tripo-game-asset
description: "Recipes for game-ready 3D assets with Tripo, wired into the game project: low-poly props on a face budget, PBR hero assets, LOD chains, and rigged characters with locomotion clips for Unity, Unreal, Godot or Three.js. Use when the user is building a game or real-time 3D scene and needs props, characters, placeholder art, LODs or an animated rig, asks about face budgets, polycount, a game-ready model, or importing a generated model into Unity, Unreal or Godot, rather than a single one-off model."
version: 0.1.0
author: VAST
license: MIT
metadata:
  tags: "tripo, game-assets, unity, unreal, godot, threejs, lod, low-poly, rigging, animation"
---

# Game asset pipeline

Recipes on top of the `tripo-3d` skill. Read that skill first: it covers finding the tools
(`tool_search`, then `tool_call` with names like `mcp__tripo__tripo_text_to_3d`), approval
prompts, `tripo_plan` before spending, waiting for tasks, credits and the full parameter reference.
Every arrow below is a billed task followed by waiting until it finishes; the `input` of each step
is the previous step's task_id.

The point of these recipes is that assets land in the project's own folders: after the final step
call `tripo_download` with `output_dir` set to the absolute path of the project's art folder
(e.g. `<project>/Assets/Art/Chest` or `<project>/assets/models`) and report the saved
`model_file`. Without `output_dir` files land in the plugin's data folder, not the project.

## Pick a budget first

Set `model: "P2"` explicitly for game and real-time topology (image and multiview tools never pick
it on their own); P1 only when the user asks for lower cost; v3.1 for film, render or print.
Confirm the model, texture options and estimated cost with `tripo_plan`; re-confirm any paid model
change.

| target | generation call | export |
|---|---|---|
| mobile, WebGL, many instances | `model: "P2"`, `face_limit: 15000` | `tripo_convert` `{format: "FBX", texture_size: 2048}` |
| PC / console hero asset | `model: "P2"`, `pbr: true`, `texture_quality: "detailed"` | FBX only if the engine needs it; GLB is native |
| animated character | T-pose model → `tripo_rig_check` → `tripo_rig` → `tripo_animate` | `out_format: "fbx"` for Unity and Unreal |

Two budget choices the defaults do not make for you:

- **Quads at low poly**: P1 rejects `quad`; use `model: "P2", quad: true` (48–25000 quads, output
  is FBX) or v3.1 with `smart_low_poly: true, quad: true` (`face_limit` 500–10000).
- **v3.1 quality under a face cap**: set `model: "v3.1"` explicitly; a face budget alone in P2's
  range routes to P2.

Override the face budget when the project has a stricter one, e.g. `tripo_text_to_3d`
`{model: "P2", prompt: "a health potion bottle", face_limit: 3000}` → `tripo_convert`
`{format: "FBX", texture_size: 1024}`.

## Props

`tripo_text_to_3d` `{model: "P2", prompt: "an ornate treasure chest, fantasy style", pbr: true, texture_quality: "detailed"}`
→ `tripo_download` into the project (or → `tripo_convert` `{format: "FBX"}` first for Unity or
Unreal).

For a set of props, confirm the total cost first (`tripo_balance` for what is left), then generate
one at a time and check each preview before continuing: a bad result early is cheaper to catch
than at the end of a batch. `tripo_task_list` checks many task ids in one call.

## LOD chain from one source

Generate once, then one `tripo_decimate` per level, each with the ORIGINAL generation task as
`input`, not the previous LOD:

`tripo_text_to_3d` `{model: "P2", prompt: "a stone golem"}` (LOD0)
→ `tripo_decimate` `{input: <generation task>, face_limit: 5000}` (LOD1)
→ `tripo_decimate` `{input: <generation task>, face_limit: 1500}` (LOD2)
→ `tripo_convert` `{input: <each LOD task>, format: "FBX"}` if the engine needs FBX.

`tripo_decimate` bakes the textures onto the low-poly mesh by default (`bake: true`), so low LODs
keep the source's look. Its `face_limit` is a target, not a ceiling: a 1500-face request can come
back near 1900 triangles. Read the actual count from the result before handing an LOD to a project
with a hard budget, and say so when it overshoots. Generation's own `face_limit` does hold as an
upper bound.

## Characters with animation

1. **T-pose source.** Prompt for it (`"a knight in full armor, T-pose, standing straight"`) or turn
   a character image into one with `tripo_generate_image` `{input: <image>, template: "t_pose"}`:
   rigging quality depends heavily on it.
2. `tripo_text_to_3d` / `tripo_image_to_3d` with `model: "P2"` → the character model task.
3. `tripo_rig_check` `{input: <model task>}`: free. It gates the chain: not riggable → stop before
   spending on rigging. Read the recommended `rig_type` (`biped`, `quadruped`, `hexapod`,
   `octopod`, `avian`, `serpentine`, `aquatic`).
4. `tripo_rig` `{input: <model task>, rig_type: <from the check>, spec: "unity", out_format: "fbx"}`:
   rig the ORIGINAL model task, not the check task. `spec` is for bipeds only (drop it for
   creatures) and names the bones: `unity` (Unity Humanoid), `unreal` (UE Mannequin), `mixamo`,
   `actorcore`, `vrm` or the default `tripo`.
   Leave `model` unset: bipeds get the v3.0 rig, the six creature types the v2.5 rig, and the
   result names the preset family to use next. Ask for `model: "v1.0"` up front only when the user
   wants dances, greetings or sports clips.
5. `tripo_animate` `{task_id: <rig task>, animations: ["preset:walk", "preset:idle"], out_format: "fbx", animate_in_place: true}`:
   at most five clips, billed per clip. v3.0 and v2.5 rigs take `preset:idle` `preset:walk`
   `preset:run` `preset:jump` `preset:fall` `preset:turn` `preset:climb` `preset:dive`
   `preset:slash` `preset:shoot` `preset:hurt` and the body-type clips (`preset:quadruped:walk`,
   `preset:hexapod:walk`, `preset:octopod:walk`, `preset:serpentine:march`,
   `preset:aquatic:march`); v1.0 rigs take only `preset:biped:*` clips. `animate_in_place: true`
   when game code drives movement rather than root motion.

To animate a mesh the project already has: `tripo_import_model` `{input: "<absolute path to the .glb/.fbx>"}`
→ continue from step 3 with the import task.

## Format notes

- **Three.js / web**: GLB as generated; `auto_size: true` at generation for real-world scale.
- **Godot**: GLB as generated.
- **Unity / Unreal**: FBX via `tripo_convert` `{format: "FBX"}` (`fbx_preset: "mixamo"` for a
  Mixamo-style export of rigged models), or rig and animate with `out_format: "fbx"` directly.
- Quads (`quad: true`) force FBX: glTF cannot store them, so `tripo_convert` to `GLTF` with quads
  is rejected.
- `texture_size` is set on the convert step, not at generation: `tripo_convert`
  `{format: "FBX", texture_size: 2048}`.
- Orientation: leave `export_orientation` unset until the final `tripo_convert`.

## Wiring into the project

After a successful chain, download the final task into the project's art folder and use that path
for the import. Do the integration work the user actually asked for (add the loader call, register
the prefab, update the asset manifest) rather than stopping at "the file is generated". Check the
preview first so a wrong asset does not get wired in.

Retopology: `tripo_decimate` with explicit `model: "v3.0", smart_uv: true` combines retopology and
UVs (billed above the default v2.0). The standalone `tripo_smart_uv` is a separate billed UV task
for inputs up to 80,000 equivalent triangles; confirm the choice and the cost. Prices:
`tripo-3d` skill, `references/tools.md`.
