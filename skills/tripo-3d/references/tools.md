# Tripo tools reference

All 27 tools of the plugin's `tripo` server (tripo-cli in `--toolset full` mode). In Hermes they
are named `mcp__tripo__<tool>` and found with `tool_search`. Pass every parameter below as a tool
argument; `tool_describe` shows the exact schema. The server fixes linkage rules itself (pbr needs
texture, model-specific options, quad output is FBX) and reports what it changed in `notes`.

## Tools

"Prompts" means Hermes asks the user before the call (the server is untrusted and only read-only
tools skip the prompt).

| tool | does | credits | prompts |
|---|---|---|---|
| `tripo_plan` | labels a drafted step list billed/free for the user to confirm; resolves the model and list price of v3.1/P2 generation steps | free | no |
| `tripo_text_to_3d` | 3D model from a prompt | billed | yes |
| `tripo_image_to_3d` | 3D model from one image | billed | yes |
| `tripo_multiview_to_3d` | 3D model from 2–4 views or a multiview task | billed | yes |
| `tripo_image_to_splat` | Gaussian-splat scene from one image (not a mesh) | billed | yes |
| `tripo_generate_image` | text to image, image editing and fusion, templates | billed | yes |
| `tripo_image_to_multiview` | four-view sheet from one image | billed | yes |
| `tripo_edit_multiview` | edit views of a multiview sheet | billed | yes |
| `tripo_upload_image` | re-host an image URL on Tripo, returns a `file_token` | free | yes |
| `tripo_import_model` | an existing model file becomes a task with a preview | free | yes |
| `tripo_texture` | new textures for any model | billed | yes |
| `tripo_convert` | GLTF, USDZ, FBX, OBJ, STL, 3MF, optional retopology | billed | yes |
| `tripo_decimate` | lower face count, optional smart UV | billed | yes |
| `tripo_smart_uv` | standalone UV re-layout | billed | yes |
| `tripo_segment` | split a model into parts | billed | yes |
| `tripo_mesh_complete` | close the cut surfaces of a segment task | billed | yes |
| `tripo_mesh_edit` | regenerate one boxed region of a model | billed | yes |
| `tripo_smart_segment` | end-to-end parts pipeline for a GLB or an image | billed | yes |
| `tripo_rig_check` | can this model be rigged, and as what body type | free | yes |
| `tripo_rig` | add a skeleton | billed | yes |
| `tripo_animate` | preset animations on a rig task, per clip | billed | yes |
| `tripo_task_status` | state, progress and fresh URLs of one task | free | no |
| `tripo_task_wait` | wait up to 55 s for a task, returns the latest state | free | no |
| `tripo_task_list` | state of up to 100 tasks in one call | free | no |
| `tripo_balance` | credits left, frozen credits, plans page | free | no |
| `tripo_usage` | per-task credits, `total_credits` for given task ids | free | no |
| `tripo_download` | save a task's files locally, returns absolute paths | free | yes |

## Inputs

- Public image or model URLs, `file_token`s and task ids go straight into `input`.
- Local files: the absolute path (`~/` works). Images PNG/JPEG/WebP/BMP/TIFF ≤20 MB, models
  GLB/GLTF/FBX/OBJ/STL ≤150 MB; a `.gltf` must be self-contained (no external `.bin` or textures).
- Signed, short-lived, region-locked or slow image URLs: `tripo_upload_image` first.
- A successful task id is a valid `input` for every processing tool, and an image task id is a
  valid `input` for `tripo_image_to_3d`. Exceptions: `tripo_animate` needs a rig task,
  `tripo_mesh_complete` a segment task, `tripo_smart_segment` takes no task ids at all.

## Models

| `model` | use for | limits |
|---|---|---|
| **P2** | game, real-time, editable or quad assets | `face_limit` 48–50000 tri / 48–25000 quad; `quad`; no `smart_low_poly`, `generate_parts`, `geometry_quality`; costs more than v3.1 and P1 |
| **v3.1** | dense geometry, film, render, print, v3-only options | full parameter set |
| **P1** | lower cost, only when the user names it or picks it | `face_limit` 50–20000; no `quad`, `smart_low_poly`, `generate_parts`, `geometry_quality` |
| v3.0, v2.5 | reproducing old work only | v2.5 has no `geometry_quality`, `quad`, `smart_low_poly`, `generate_parts`, `auto_size`, `compress` (removed with a note) |

Website names map to these rows: H3.1 → `v3.1`, P1.0 → `P1`, P2.0 → `P2`. When `model` is omitted
the server routes as described in the skill and names its choice in `notes`; image and multiview
tools need an explicit `model: "P2"` for game use. Confirm the model before spending.

## Generation parameters

For `tripo_text_to_3d`, `tripo_image_to_3d` and `tripo_multiview_to_3d`.

| param | default | notes |
|---|---|---|
| `prompt`, `negative_prompt` | – | text tool only; ≤1024 / ≤255 chars |
| `face_limit` | adaptive | upper bound on faces; P2 and P1 ranges above |
| `texture`, `pbr` | `true`, `false` | `pbr: true` only when the user explicitly asks for PBR; it forces `texture: true`; both `false` = bare geometry, no texture credits |
| `texture_quality` | `standard` | `detailed` (HD), `extreme` (8K), `fast` (v3.5 textures only) |
| `texture_version` | from `model` | `v3.5` newest (unlocks `delight`, `fast`), `v3.0` default, `v2.5` |
| `delight` | `true` | v3.5 textures: remove baked-in lighting from the reference |
| `geometry_quality` | `standard` | `detailed` = finer geometry, up to 2M faces; v3.x only |
| `quad` | `false` | quad mesh, delivered as FBX; v3.x and P2 |
| `smart_low_poly` | `false` | hand-modelled-style low poly; `face_limit` 500–20000 tri / 500–10000 quad; v3.x only |
| `generate_parts` | `false` | editable parts; needs `texture` and `pbr` off (re-texture later); not with `smart_low_poly` (rejected); v3.x only |
| `auto_size` | `false` | real-world metres (AR, engines) |
| `compress` | – | `geometry` = meshopt-compressed output; v3.x only |
| `model_seed`, `texture_seed`, `image_seed` | random | same seed, same result; keep `model_seed` and vary `texture_seed` to re-texture one shape |
| `enable_image_autofix` | `false` | image tool: repair a blurry or cropped photo first (slower) |
| `orientation` | `default` | image and multiview: `align_image` faces the model like the input |
| `texture_alignment` | `original_image` | image and multiview: `geometry` matches the mesh instead |
| `export_uv` | `true` | `false` skips the UV unwrap |
| `export_orientation` | `+x` | forward axis; leave unset when later steps follow and orient on the final `tripo_convert` |
| `dry_run` | `false` | return the resolved `model`, `cost_estimate` (list price, v3.1/P2 only), request payload and notes without creating a task |

Multiview: `front` plus at least one of `left`, `back`, `right`, or `multiview_task_id` from a
finished `tripo_image_to_multiview` / `tripo_edit_multiview` task.

## Processing steps

| tool | arguments and constraints |
|---|---|
| `tripo_texture` | `texture_quality`, `pbr` (`false` unless the user explicitly asks for PBR), `texture_seed`, `texture_alignment`, `bake`, `delight`, `part_names` (segmented models), `compress`; `model` `v3.0` (default), `v3.5` (newest), `v2.5`. Guidance: one of `prompt` (with optional `style_image`), `image`, or `images` (front, left, back, right) |
| `tripo_convert` | `format` GLTF/USDZ/FBX/OBJ/STL/3MF (3MF = single-colour print). Mesh: `face_limit`, `quad`, `force_symmetry`, `flatten_bottom` + `flatten_bottom_threshold`. Texture: `texture_size` (4096), `texture_format`, `bake`, `pack_uv`, `export_vertex_colors`. Export: `pivot_to_center_bottom`, `scale_factor`, `auto_size`, `with_animation`, `animate_in_place`, `part_names`, `export_orientation`, `fbx_preset` blender/3dsmax/mixamo. Quads cannot export GLTF |
| `tripo_import_model` | an existing model (local path, URL or file_token) becomes a task with a preview |
| `tripo_rig_check` | free; result says `riggable` and the recommended `rig_type` |
| `tripo_rig` | `rig_type` from the check (biped, quadruped, hexapod, octopod, avian, serpentine, aquatic, others); `spec` tripo or mixamo, and on v3.0 also actorcore, unity (Unity Humanoid), unreal (UE Mannequin), vrm; `out_format` glb/fbx; `model`: pass `v3.0` for biped and others, `v2.5` (the official animal rig) for quadruped, hexapod, octopod, avian, serpentine and aquatic (the tool sends v3.0 for every body type when omitted, and the API's own default, `v1.0-20240301`, rigs bipeds only); v1.0 only on request |
| `tripo_animate` | `task_id` of a rig task; `animations` (≤5, billed per clip); `out_format`; `animate_in_place` (game code drives movement); `export_with_geometry` |
| `tripo_decimate` | `face_limit` target 500–20000 tri / 500–10000 quad (a target, not a ceiling); `quad`; `bake` (true); `part_names`; `model` v2.0 (default), v3.0 (with `smart_uv`, billed higher), v1.0 (up to 2M faces, needs `face_limit`, no `bake`) |
| `tripo_smart_uv` | separate billed UV re-layout for inputs ≤80,000 equivalent triangles (one quad counts two); `bake`, `export_orientation`, `compress`. Its `uv_render_url` is a UV preview, not the model |
| `tripo_segment` | `model` `v1.0-20250506` (geometry-based, default) or `v2.0-20260430` (semantic) with `segmentation_granularity`, `split_by_connectivity`, `ref_image`; any of these without `model` selects v2.0, and with an explicit v1.0 they are rejected |
| `tripo_mesh_complete` | `task_id` of a segment task; `completion_mode` `ai_completion` or the cheaper `quick_cap`; `part_names` |
| `tripo_mesh_edit` | P2 pipeline; `bbox` `[[x1,y1,z1],[x2,y2,z2]]` around the region to redo; `face_limit` (≥100); `ref_image`; `compress`. The rest of the mesh is kept |
| `tripo_smart_segment` | `seg_type` `model` (GLB only) or `image`; `granularity` coarse/medium/fine; `hint` naming the parts; `transform` |

Animation presets follow the rig model the `tripo_rig` result names. v3.0 and v2.5 biped rigs:
`preset:idle` `preset:walk` `preset:run` `preset:jump` `preset:fall` `preset:turn`
`preset:climb` `preset:dive` `preset:slash` `preset:shoot` `preset:hurt`. Creature rigs take only
their body-type clip: `preset:quadruped:walk` `preset:hexapod:walk` `preset:octopod:walk`
`preset:serpentine:march` `preset:aquatic:march`; avian and others rigs have none. v1.0 rigs
(humanoid only) take only the 90+ `preset:biped:*` clips: `idle` `walk` `run` `jump` `sit` `swim`,
`dance_01`…`dance_06`, `greet_01`…, `wave_goodbye_01`, `clap`, `bow`, `box_01`…, `golf` and more.
Ask for v1.0 up front when the user wants dances, greetings or sports clips.

## 2D steps before 3D

- `tripo_generate_image`: text to image without `input`; editing or fusion with `input` or
  `inputs` (refer to them as image[1], image[2] in the prompt; up to 4 seedream, 10 banana,
  16 chat_image). Templates: `t_pose` (before rigging), `3d_enhance` (clean a photo),
  `asset_extraction` (text mode), `character_completion`, `variants`, `figure`. Negative prompts go
  inside `prompt` after `--no`.
- Image models: `seedream_v4` (text default, not for editing), `seedream_v5` (editing default),
  `banana`, `banana_pro`, `banana2`, `chat_image_2`, `chat_image_2.5_flare` (faster),
  `chat_image_2.5_sunburst` (keeps untouched regions). `chat_image_1` is retired and
  `chat_image_1.5` retires on 2026-12-01. `quality` applies to `chat_image_2` and the 2.5 models,
  `background` to the 2.5 models only; `aspect_ratio` to banana models; `watermark` to seedream.
- `size` (default 2048x2048; billed by tier) depends on the model: `banana` fixed sizes only
  (1024x1024, 832x1248, 1248x832, 864x1184, 1184x864, 896x1152, 1152x896, 768x1344, 1344x768,
  1536x672); `banana_pro` 1K/2K/4K or WxH; `banana2` 0.5K/1K/2K/4K; `seedream_v4` 2K/4K and
  `seedream_v5` 2K/3K (or WxH within 1:16–16:1); `chat_image_1.5` 1024x1024, 1024x1536, 1536x1024
  or auto; `chat_image_2` and 2.5 auto or WxH (sides ≤3840 and multiples of 16, long side ≤3×
  short, 655360–8294400 pixels). `output_format` png/jpeg.
- `tripo_image_to_multiview` makes a four-view sheet; `tripo_edit_multiview` takes it plus 1–4
  `{view, prompt}` edits; either feeds `tripo_multiview_to_3d` via `multiview_task_id`.
- `tripo_image_to_splat` returns a Gaussian-splat file for viewers: no texture, rig or convert
  afterwards. Input ≥256×256 px with a clear, centred subject.

## Results

- Task states: `queued` → `running` (`progress` 0–100) → `success`, `failed`, `banned` (content
  policy) or `cancelled`. `expired` means the files are gone and the task must be re-run.
- `tripo_task_status` / `tripo_task_wait` return `model_url` and `output_urls` that expire after about
  2 hours; `steps: true` on `tripo_task_status` adds the per-stage breakdown.
- `tripo_download` saves every output plus `preview.png` and `task.json`, and returns `output_dir`,
  `files`, `model_file` (GLB, FBX, ZIP …) and `preview` as absolute paths. Default folder:
  `tripo-out/<type>-<id prefix>` in the plugin's data directory.
- Credits are frozen at submission and released on failure, ban or cancellation. `balance` and
  `credits_consumed` are decimals.

## Prices

Official list prices from the Tripo pricing page (developers.tripo3d.ai/pricing), checked on
2026-10-30, so a cost can be quoted before a run. Prices
change; the authoritative number is `credits_consumed` on the result and `tripo_usage` afterwards.

| operation | credits |
|---|---|
| text-to-3D, v3.1 | 10 bare / 20 textured |
| image- or multiview-to-3D, v3.1 | 20 bare / 30 textured |
| text-to-3D, P1 | 30 bare / 40 textured |
| image- or multiview-to-3D, P1 | 40 bare / 50 textured |
| any generation, P2 | 100 bare / 110 textured |
| add-ons per generation | `texture_quality` detailed +10, extreme +20; v3.1 only: `geometry_quality` detailed +20; `quad` +5; `smart_low_poly` +10; `generate_parts` +20 |
| texture step | 10 standard / 20 detailed / 30 extreme |
| convert | 5, or 10 with a non-default `quad`, `face_limit`, `flatten_bottom`, `flatten_bottom_threshold`, `texture_size`, `texture_format`, `pivot_to_center_bottom` or `scale_factor` |
| decimate | 30 (v2.0), 35 tri / 40 quad (v3.0, smart UV included), 10 (v1.0) |
| smart UV (standalone) | 20 |
| segment / mesh complete | 40 / 50 (`quick_cap` 30) |
| smart segment | 55 model / 85 image |
| rig check / rig / animate | free / 25 / 10 per clip |
| text-to-image, image editing (default size) | `seedream_v4`, `seedream_v5`, `banana` 5; `banana2`, `chat_image_2`, `chat_image_2.5_flare`, `chat_image_2.5_sunburst` 10; `banana_pro` 15; at 4K `banana2` and chat_image cost 15, `banana_pro` 20 (seedream stays 5); chat_image `quality` `high` / `xhigh` / `max` 20–50 by size tier |
| image-to-multiview / edit-multiview / image-to-splat | 10 / 5 per edited view / 30 |
