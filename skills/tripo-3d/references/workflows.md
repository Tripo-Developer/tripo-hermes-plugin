# Tripo workflows

Pick the chain from what the user is building, put every step into `tripo_plan`, and get the
user's `clarify` pick (a model with its credits, or "Go ahead") before the first billed call. Each
arrow is a task followed by waiting until it finishes; the
`input` of each step is the previous step's task_id unless noted. GLB is the native output: a
`tripo_convert` step is only worth its credits when the target needs another format.

## By goal

- **Quick look or concept model**: from words only, a concept image first (`tripo_generate_image`;
  `tripo_text_to_3d` only when the user skips it), then `tripo_image_to_3d` with defaults once the
  user wants the model → `tripo_download`. Show the preview and offer the next steps instead of
  guessing them.
- **Game prop, mobile / WebGL / many instances**: explicit `model: "P2"` and a confirmed
  `face_limit` → `tripo_convert` `{format: "FBX", texture_size: 2048}` for Unity or Unreal;
  Three.js and Godot take the GLB as is. More in the `tripo-game-asset` skill.
- **Game hero asset, PC / console**: explicit `model: "P2"`,
  `texture_quality: "detailed"`, `pbr: false` → FBX only if the engine needs it.
- **Film, render, close-ups**: `model: "v3.1"` with `geometry_quality: "detailed"` and
  `texture_quality: "detailed"` (both cost extra).
- **3D print or figurine**: `texture: false, pbr: false` → `tripo_convert`
  `{format: "STL", flatten_bottom: true}`; `3MF` also works (single colour).
- **AR / iOS Quick Look**: `auto_size: true` (real-world metres) → `tripo_convert`
  `{format: "USDZ"}`; WebXR uses the GLB directly.
- **Animated character**: a T-pose source first (prompt for "T-pose, standing straight", or
  `tripo_generate_image` `{input: <character image>, template: "t_pose"}`) →
  `tripo_image_to_3d` / `tripo_text_to_3d` → `tripo_rig_check` (free; not riggable → stop) →
  `tripo_rig` on the ORIGINAL model task with `model: "v3.0"` (`"v2.5"` for an animal) and `rig_type` from the check →
  `tripo_animate` with the
  preset family the `tripo_rig` result names, `animate_in_place: true` when game code drives
  movement. To play it, make it a game character or hand it to an engine with a controller:
  Game Studio in the `tripo-game-asset` skill.
- **Quads or a face cap**: `quad: true` (P2 or v3.1) is delivered as FBX and can never export
  GLTF. P2 holds 48–25000 quads; v3.1 with `smart_low_poly: true, quad: true` 500–10000. Set
  `model: "v3.1"` explicitly when the user wants v3.1 quality under a budget.
- **LOD chain**: generate once → one `tripo_decimate` per level, each with the ORIGINAL
  generation task as `input` (not the previous LOD). `face_limit` is a target, not a ceiling.
- **Better views of one image**: `tripo_image_to_multiview` → optional `tripo_edit_multiview` →
  `tripo_multiview_to_3d` `{multiview_task_id: <sheet task>}`. A user with 2–4 orthographic views
  goes straight to `tripo_multiview_to_3d` (`front` plus the others).
- **Re-texture**: `tripo_texture` with one guidance: `prompt` (optional `style_image`), `image`,
  or `images` (four views). For a fresh generation of the same shape, keep `model_seed` and change
  `texture_seed`.
- **The user's existing mesh**: its absolute path or URL goes straight into the `input` of any
  processing tool. For several steps on one file, `tripo_import_model` first: the import task id
  (with a preview) then feeds every step without uploading again.
- **Fix one region**: `tripo_mesh_edit` with the model as `input` and a `bbox` around the region to
  redo; the rest of the mesh is kept.
- **Parts**: `generate_parts: true` at generation (v3.x, untextured; re-texture afterwards), or
  `tripo_segment` → `tripo_mesh_complete` on an existing model, or `tripo_smart_segment` for a GLB
  file or an image in one step.
- **Retopology with clean UVs**: `tripo_decimate` `{model: "v3.0", smart_uv: true}` (billed above
  the default v2.0; confirm) or a separate billed `tripo_smart_uv` for inputs up to 80,000
  equivalent triangles.
- **Not a mesh**: `tripo_image_to_splat` makes a Gaussian-splat scene for viewers; say so first.
- **Stylization** (lego, voxel, minecraft): no tool does this; say so instead of improvising.

## Batches

Confirm the total for the whole batch first (`tripo_balance` for what is left). Generate one asset
at a time and check each preview before the next: a bad early result is cheaper to catch than a
whole batch. `tripo_task_list` checks up to 100 task ids in one call. Report the batch total with
`tripo_usage` and every task_id.

## Follow-ups

- Reuse task ids: a convert, texture or rig on an earlier task needs no regeneration.
- `tripo_download` works any time after a task succeeded; it fetches fresh links itself. A task in
  state `expired` has lost its files and must be re-run (ask first: it is billed again).
- `tripo_usage` without `task_ids` lists recent spend; `tripo_balance` shows `balance`, `frozen`
  (held by running tasks) and `plans_url`, an informational page about plans.

## Example: rigged character for Unity

1. `tripo_plan` `{goal: "rigged knight for Unity from the user's T-pose image, with walk and idle", steps: [image_to_3d, rig_check, rig, animate, download]}` → confirm with `clarify`.
2. `tripo_image_to_3d` `{input: "/Users/me/knight-tpose.png", model: "P2", face_limit: 20000, pbr: false}` → wait.
3. `tripo_rig_check` `{input: <generation task>}` → wait; read `riggable` and `rig_type`.
4. `tripo_rig` `{input: <generation task>, model: "v3.0", rig_type: "biped", spec: "unity", out_format: "fbx"}` → wait.
5. `tripo_animate` `{task_id: <rig task>, animations: ["preset:walk", "preset:idle"], out_format: "fbx", animate_in_place: true}` → wait.
6. `tripo_download` `{task_id: <animate task>, output_dir: "<project>/Assets/Art/Knight"}`.
7. `tripo_usage` `{task_ids: [<all four task ids>]}` → report the total and the breakdown.
