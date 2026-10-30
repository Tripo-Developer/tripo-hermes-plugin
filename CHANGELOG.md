# Changelog

## 0.1.0

First version.

- Runs Tripo's official tripo-cli as a local stdio MCP server (`npx -y tripo-cli@0.9.0 mcp --toolset full`)
  with the hosted Tripo MCP tool set plus local file paths and `tripo_download`; international
  accounts only (`TRIPO_REGION=ov`), analytics off, the API key from the plugin's secret setting.
- The server is untrusted: every call that is not read-only asks for approval. No per-tool costs or
  spend limit are declared yet.
- Skills `tripo-3d` (with tool, workflow and chat-app references) and `tripo-game-asset`, carrying
  the server's rules: plan and confirm before spending, poll until done, report the credits used,
  and deliver files per surface (Desktop cards, `MEDIA:` attachments, plain paths). Choices, image
  models included, come with their credits through the `clarify` tool (the recommended one first);
  generated images show in Desktop chats with `MEDIA:` lines; a card button's message counts as the
  confirmation of its stated cost; chat apps get numbered next steps with credits. On Desktop a
  model's card goes out right after the create instead of after waiting and downloading. When the
  Tripo tools did not load, the agent stops and asks for a gateway restart instead of turning to
  another Tripo server. Asking Tripo for an image is in scope on its own, not only as part of a 3D
  job. A model asked for in words starts with a choice of image models for a concept image, plus a
  last choice that skips the image and goes straight to 3D; after an image, 3D follows only when the
  user wants it. Every confirmation is a `clarify` choice, and the pick runs the call right away, so
  Hermes' approval prompt follows instead of a second question in text. Asked what Tripo can do, the
  agent answers from the skill's tool list instead of searching the web.
- PBR is opt-in: tripo-cli 0.9.0 leaves `pbr` off when it is omitted, and the skills send
  `pbr: false` on every generation and `tripo_texture` call unless the user explicitly asks for PBR;
  the PC/console hero recipe follows it. The tool snapshot carries the new `pbr` descriptions.
- Adding PBR to a model that is already generated re-textures its task with `tripo_texture`
  (`pbr: true`) instead of regenerating it, so only the texture step is billed.
- Within the P series the default is P2: the model choice lists v3.1, P2, then P1, and P1 is used
  only when the user names it or picks it as the lower-cost option.
- Hermes Desktop half, following the Meshy plugin's flow: next steps from the card, a gallery with
  what made each task, and the chat it came from. A credit chip shows a running task's progress.
- `::tripo-model` 3D cards: task progress with Tripo's stage (modelling, texturing, rigging…) beside
  it, the credits a task cost in the header, and once it is done Next (the follow-ups Tripo offers,
  with their credits), Download (the files Tripo made, saved free into the plugin's folder;
  conversions) and Open (the task in the gallery). Next and Convert send a chat message to the
  card's own chat, so the agent runs them behind the usual approval prompt; the menus never spend.
- Next covers Meshy's follow-ups: Texture it for an untextured model and Retexture (a new style) for
  a textured one; Remesh (was Lower the face count) to a game face budget in triangles or quads;
  Resize (`tripo_convert` with a `scale_factor` for the size in metres); Rig it asks a biped's bone
  names (Unity, Unreal, Mixamo, VRM or Tripo's). Some rows carry a one-line note.
- Game Studio, in the `tripo-game-asset` skill and the Desktop half: Make it playable checks, rigs
  and animates a model in place in one confirmed chain (25–75 credits); an animated model's card has
  a Play button and the viewer a Play mode (WASD or arrows, Shift runs, Space jumps, J attacks, Esc
  exits), with an idle, run, jump and attack made up in code when the model has no clip for them;
  Playable web prototype copies a three.js arena (enemies, coins, stamina, a special move) from the
  skill's assets into a folder the user names and serves it on `127.0.0.1`; Export to a game engine
  writes a character controller for Godot or Unity and sets up Unreal's Third Person template; Add
  clips animates the same rig again. The Play mode and the web template share `src/play.ts`, built
  into the template's `play.js`.
- The skills' animation presets match tripo-cli 0.9.0's rig result: a creature rig takes only its
  body-type clip, and avian and other rigs none.
- Viewer: GLB and FBX, plus OBJ (with the `.mtl` and textures beside it), STL, USDZ (text USD
  layers) and 3MF, with Z-up files stood upright; the file's size, a grid toggle, play once or loop
  for animations, and Show in folder (on a remote Hermes host, a notice with the path instead). An
  FBX or OBJ is merged back into an indexed mesh after loading, so it sends the GPU about as much as
  the same model's GLB instead of about six times the vertices. A card for a conversion that only
  changed the file format shows the source model, and says so. When WebGL is off or the GPU drops
  the preview, the viewer says that a Hermes restart turns 3D previews back on. A model's shaders
  link in the background before its first frame, so that frame does not wait on a slow link, a wait
  that on macOS has stalled Hermes' GPU process and frozen the screen.
- The Tripo 3D gallery: images as well as models, a prompt search, All / Images / Models filters,
  the task ID with Copy ID, Made from (prompt, source image or parent task, model, settings,
  credits) with Open chat back to the chat that made the task, how much the plugin has saved with
  Show folder, and a note that Tripo's download links expire after about 2 hours.
- Backend (`dashboard/plugin_api.py`): `/status` (key, balance and settings), `/models` (finished
  models and images, with the saved copies), `/task` (one card's task, with the credits it used and
  `view_task`, a format-only conversion's source), `/active` (running tasks' progress), `/file`
  (GLB, glTF, FBX, OBJ with its `.mtl`, STL, USDZ, 3MF, images), `/actions` (follow-ups and their
  prices, from a fixed table; nothing is started), `/formats` (a task's files and conversions),
  `/save` of a chosen file, `/provenance` and `/details` (what made a task, recorded only for chats
  of the profile that holds them) and `/storage` (what the plugin saved).
- Settings: `auto_rotate` (spin the model in the gallery viewer, on by default), `default_model`
  (`ask`, `v3.1` or `P2`: with a model set the agent skips the model question but still shows the
  price and waits for a yes), `blender_handoff` (`ask`, `always` or `never`) and `blender_path`.
- Optional Blender copy for game testing, adapted from the Meshy plugin: after a `.glb` download, a
  local Blender 4.2 or newer writes a new `.blend` plus GLB or FBX with packed textures, fewer
  triangles only with a budget the user gives, optional LODs and smaller textures, reopens each file
  in a fresh Blender to check it, and never touches the download or an open scene. No Tripo credits.
- Prices are the official list prices (developers.tripo3d.ai/pricing, checked
  2026-10-30): `chat_image_2.5_sunburst` costs 10 like the other chat_image models,
  `quality` high/xhigh/max costs 20–50, and convert's 10-credit tier names its options.
  `tripo_plan` and dry_run give a list price only for v3.1/P2 generation steps.
- Tool reference synced with tripo-cli 0.9.0: v2.5 limits; `generate_parts` is
  rejected together with `smart_low_poly`; segment's v2-only options; `quality` and
  `background` scope and per-model image `size`; generation add-ons other than texture
  quality apply to v3.1 only; standalone smart UV costs 20; P1 strips `quad`.
- `export_uv` is not limited to the P series (official API docs).
- Rigging passes `model` explicitly by body type, `"v3.0"` for bipeds and `"v2.5"` (the
  official animal rig) for animals (skill, workflows and the dashboard's Rig it prompt): the official API default is still `v1.0-20240301`,
  which rigs bipeds only.
