---
name: tripo-3d
description: "Create 3D models with Tripo from a text prompt, one image or several views, then texture, rig, animate, retopologize, segment or convert them (GLB, FBX, OBJ, STL, USDZ, 3MF). Use when the user asks for a 3D model, prop, character, game asset, rigged or animated character, AR file, 3D print or an image made with Tripo, wants to process a model they already have (including an optimized Blender copy for game testing), or asks about their Tripo credits or earlier Tripo tasks."
version: 0.1.0
author: VAST
license: MIT
metadata:
  tags: "tripo, 3d, text-to-3d, image-to-3d, texturing, rigging, animation, 3d-printing, game-assets, mcp"
---

# Tripo 3D

Generates and edits 3D assets on Tripo's cloud through the `tripo` MCP server bundled in this
plugin (tripo-cli in `--toolset full` mode, running on this machine): text, image or multiview to
3D, helper images, texturing, rigging and animation, retopology, smart UV, segmentation, mesh
editing, Gaussian splats and format conversion. Most calls spend the user's Tripo credits.

Hermes does not show MCP server instructions to you, so this skill carries the server's own
rules: plan and confirm before spending, keep polling until a task finishes, deliver files, and
report the credits used.

## When to Use

- The user wants a 3D model, prop, character, game asset, AR file (USDZ) or 3D print, or asks
  Tripo for an image (`tripo_generate_image`).
- The user has a Tripo task id, a model file or a model URL to texture, rig, animate, convert,
  decimate, segment or repair.
- The user asks about their Tripo balance, spend or earlier generations.
- The user asks what Tripo can do: answer with a short overview from this skill and
  [tools](references/tools.md), which list exactly what this plugin's tools do. No web search and no
  loading of every tool schema for that; the Tripo website only when they ask beyond this plugin.
- NOT for editing a local mesh by hand (use Blender or a mesh tool) or for 2D images that are not
  part of a 3D job, unless the user asks Tripo for one.
- For game projects (face budgets, LODs, engine import), also read the `tripo-game-asset` skill.

## Prerequisites

- The `tripo` plugin installed and enabled, then a NEW Hermes session so the MCP tools load.
  The first start downloads Hermes' managed Node.js and the pinned tripo-cli; when the tools are
  missing, follow How to Run below.
- A Tripo API key from an international Tripo account, created at developers.tripo3d.ai/en/keys.
  It goes into Hermes Desktop **Settings → Plugins → Tripo**, or `hermes config set TRIPO_API_KEY tsk_...`
  (stored in the profile's `.env`). Hermes hands MCP servers only a filtered environment, so a key
  exported in a shell alone is not seen. Never ask for the key in chat; tell the user where to put it.
- Accounts on the China site cannot use this plugin.

## How to Run

The tools usually sit behind Hermes' tool search, not in the visible tool list. Find them with
`tool_search` (for example `tripo text to 3d`, `tripo download`, `tripo rig`), load the schema
with `tool_describe`, then invoke the exact returned name with `tool_call`. Hermes names them
`mcp__tripo__<tool>`, e.g. `mcp__tripo__tripo_text_to_3d`; never guess a name. When the tools
are already in your tool list, call `mcp__tripo__<tool>` directly. This document uses the short
names (`tripo_text_to_3d`).

Never run `npx tripo-cli`, `hermes mcp add tripo` or any other setup step yourself: the plugin
already registers the server, and a second `mcp_servers.tripo` entry in `config.yaml` replaces the
plugin's pinned one.

If `tool_search` finds no `mcp__tripo__` tool, stop and tell the user the Tripo tools did not load
in this session. The plugin must be enabled for the agent (`hermes plugins enable tripo`, or its
Agent switch in Desktop's Capabilities → Plugins); then the user restarts the gateway (Desktop:
Cmd+K or Ctrl+K → "Restart gateway"; CLI: `hermes gateway restart`) and starts a new session. A
running gateway can miss the plugin being switched off and on again, so a new session alone may
not help. Never enable, add or switch to another Tripo server (such as Tripo's hosted MCP) as a
workaround: it cannot read local files, download into the plugin's folder or feed the 3D card.
`hermes mcp list` and `hermes mcp test` show only `config.yaml` entries, never plugin servers, so
their "not found" for `tripo` is expected.

The server is marked untrusted, so Hermes asks the user before every call that is not read-only.
Six tools are read-only and never prompt: `tripo_plan`, `tripo_task_status`, `tripo_task_wait`,
`tripo_task_list`, `tripo_balance`, `tripo_usage`. Everything else prompts, including the free
`tripo_upload_image`, `tripo_import_model`, `tripo_rig_check` and `tripo_download` (they upload
or write files). On Hermes builds after v0.22.5 the prompt's "for this session" answer keeps that
one tool allowed for the rest of the chat and "Always" for every chat of the profile; on v0.22.5
and older both approve only that call. This plugin declares no per-chat spend limit.

When a call comes back "The user did not approve", stop: the user declined, or the run is
unattended (cron, `hermes chat -q`, a gateway with no approver) and cannot approve. Do not retry,
inspect config or look for a workaround, and never suggest changing the server's trust or editing
config as the fix. Tell the user the exact call you would make and what it costs, and that an
interactive session (Desktop, the CLI, or a chat gateway with approval buttons) can approve it.

Only when the USER asks to stop the prompts, tell them their options (the plugin README's "Full
creative control" section) and let them choose; never change any of it yourself: `/yolo` for this
chat, `hermes --yolo`, `approvals.mode: off` for the profile, or "Always" once per tool. Also tell
them these settings cover unattended runs too: with `approvals.mode: off`, `--yolo` or an "Always"
answer, cron jobs and `chat -q` make paid calls without asking, and with no spend limit declared
there is no cap on what such a run spends.

## Quick Reference

Every tool and parameter with prices: [tools](references/tools.md). Scenario chains (print, AR,
animated character, retexture, LODs, existing meshes): [workflows](references/workflows.md).
Chat apps: [messaging](references/messaging.md). Read the workflow for the user's goal before the
first paid call.

| Goal | Chain |
|---|---|
| Model from text | concept image first: `tripo_generate_image` → show it → once the user wants the model, `tripo_image_to_3d` with the image task_id → wait → download |
| Model from a photo | `tripo_image_to_3d` (URL, file_token or absolute local path) → wait → download |
| Model from 2–4 views | `tripo_multiview_to_3d` (`front` + at least one more) → wait → download |
| Straight from text (the user skips the image) | `tripo_text_to_3d` → `tripo_task_wait` → `tripo_download` |
| Rigged + animated character | T-pose model → `tripo_rig_check` (free) → `tripo_rig` → `tripo_animate` |
| Another file type | `tripo_convert` with `format` → wait → download |
| Optimized copy for game testing | `.glb` download → local Blender copy: [blender](references/blender.md) (no credits) |
| Existing local mesh | `tripo_import_model` with the absolute path → wait → any processing tool |
| Balance / spend | `tripo_balance`, `tripo_usage` (read-only) |

## Procedure

1. **Plan, then confirm.** Before the first call of any workflow that creates tasks, call
   `tripo_plan` with every intended step (tool, purpose, key params). It is read-only and free.
   - A model asked for in words only (no image, task id or model file) starts with a concept
     image. Plan the image step, then ask with `clarify`: three image models first and, as the
     last choice, skipping the image for 3D straight from text with the model [Models](#models)
     picks, for example "seedream_v4 · about 5 credits", "banana2 · about 10 credits",
     "banana_pro · about 15 credits", "Skip the image: 3D from text, v3.1 textured · about 20
     credits". A skip pick runs `tripo_text_to_3d` with that model. After an image pick, run it,
     show the image (step 8) and end the reply by offering a 3D model from it with the image-to-3D
     choices and their credits. Plan and run `tripo_image_to_3d` with the image task_id only when
     the user wants it; a reply naming an offered choice is the pick.
   - When a step has a choice that sets the price (the image model, the 3D `model` unless the
     `default_model` setting names it ([Models](#models)), texture quality, which clips), ask
     with the `clarify` tool: one choice per option naming it and its approximate credits from
     [tools](references/tools.md) § Prices, at most four, the one [Models](#models) picks first
     (the UI marks the first "Recommended" and adds "Other"). For a model from an image: "v3.1,
     textured · about 30 credits", "P1 · about 50 credits", "P2 · about 110 credits".
   - Otherwise ask with `clarify` too: sum up the returned plan in the question (each billed step,
     the generation `model` and texture options, approximate credits; say "about", the real charge
     is `credits_consumed`) with the choices "Go ahead · about N credits" and "Not now".
   - The user's pick is the confirmation: make the billed call right away in the same turn and
     never ask again in text; Hermes then shows its approval prompt.
   - Without a `clarify` tool, show the plan as a numbered list with the choices and their credits
     and STOP for the reply; a reply with just a number is that choice.

   Re-plan and re-confirm when the goal changes or a failed step needs a different route.
   Read-only questions (balance, usage, status) need no plan. Hermes' approval prompt is the
   second gate, not the first, and it shows no price.
2. **Inputs.** Pass public URLs, `file_token`s and task ids directly. A local file goes in as its
   absolute path (`/Users/me/cat.png`, `~/models/chair.glb`); the server uploads it first. Files
   the user attached in chat have a local path in the message: use it. Signed, short-lived or
   region-locked image URLs go through `tripo_upload_image` first (it returns a `file_token`).
   A successful task id is a valid `input` for every processing tool: never re-upload what Tripo
   already has.
3. **Submit once.** Every create returns `{task_id, status: "queued", next, notes}` immediately.
   Relay `notes`: they say which model was chosen automatically and which parameters were removed
   or adjusted. When unsure about a generation request, run it with `dry_run: true` first (no task,
   no credits) and read `payload` and `notes`. Keep every task_id for the final credit report.
4. **Wait for the task.** Generation takes 1–4 minutes; a task_id is never a result.
   - **Hermes Desktop: don't wait for a model when nothing else needs it.** Right after the
     create, say what started, its task_id and its approximate credits, and end the reply with
     `::tripo-model{task="<task_id>" title="<short name>"}` on its own line; steps 6–7 don't apply
     to it. The card shows the progress, then the finished model with its credits and its Next and
     Download menus (Download saves into the plugin's folder, free). Wait only when the next step
     needs the finished task (a chained step, a download into a folder the user named or the
     project).
   - Chat apps (Telegram, Discord, Slack ...): never block the chat; follow
     [messaging](references/messaging.md) § Long jobs.
   - Elsewhere: call `tripo_task_wait` with the task_id (it waits up to 55 s, default 50) and call it
     again while the status is `queued` or `running`. Never give a final answer before the status is
     terminal, and never write your own sleep loop.
   - `failed` / `banned`: relay `failure_reason` and `error_code`; credits are refunded
     automatically. Never re-roll a disappointing result on your own: show it and ask.
5. **Never re-create on doubt.** An error marked "submission uncertain" (network failure while
   creating) means the task may exist with credits frozen. Check `tripo_balance` (`frozen`) and
   `tripo_usage`, tell the user, and resubmit only with their yes.
6. **Download** with `tripo_download` (free, asks for approval): it fetches fresh links itself and
   saves the model, `preview.png` and `task.json`, returning absolute paths. Pass an absolute
   `output_dir` when the user names a folder or the project needs the file; without it files land
   under `tripo-out/` in the plugin's data directory, not the current project. For chat apps use
   the folder in [messaging](references/messaging.md).
7. **Report**: what was made, `model_file` and every other saved path, the format and the task_id
   (follow-ups reuse it instead of regenerating). When the workflow finishes, call `tripo_usage`
   with the task_ids of every step and report `total_credits` plus the per-task breakdown (step,
   tool, task_id, credits); failed and cancelled tasks are not charged.
7b. **Offer the optional Blender copy** (local, no Tripo credits) after a `.glb` download, before
   step 8. First run `hermes config get plugins.entries.tripo.settings.blender_handoff` ("not
   set" or unreadable means `ask`). Unless it is `never`, find Blender: first
   `hermes config get plugins.entries.tripo.settings.blender_path`, then PATH and the per-OS
   folders in [blender](references/blender.md) § 2. If Blender is found and the setting is `ask`,
   offer it once per chat, word for word, at the end of the reply above any `::tripo-model` or
   `MEDIA:` line: "Blender is installed: want an optimized copy for game testing (packed
   textures, optional triangle budget) plus a .blend? Runs locally, no Tripo credits." Persist an
   always/never answer with `hermes config set`. Never decimate without the user's triangle
   budget. Rigs and clips: [blender-animation-handoff](references/blender-animation-handoff.md).
8. **Deliver for the surface you are on** (your system prompt names it): see below.

## Models

An explicit `model` always wins. Before planning a 3D generation, run
`hermes config get plugins.entries.tripo.settings.default_model` ("not set", `ask` or unreadable:
ask as in Procedure step 1). `v3.1` or `P2` is then the `model` of every 3D generation without the
model question, unless the user names another model or asks for something only another model
offers; the plan still names it and its credits for the user's yes.
When `model` is omitted, the server picks one and says why in
`notes`: P2 for game, real-time, editable, low-poly or quad requests and for a face budget P2
supports (48–50000 triangles, 48–25000 quads); v3.1 for dense geometry, v3-only options
(`geometry_quality`, `smart_low_poly`, `generate_parts`), budgets above P2's range and anything
unspecified. Image and multiview tools have no prompt to read, so set `model: "P2"` yourself when
the user's goal is a game or real-time asset. P1 is a lower-cost choice only when asked for;
v3.0 and v2.5 only to reproduce old work. Visual quality or texture quality never picks a geometry
model. Confirm the model before spending (the `clarify` choice in Procedure step 1, this pick
first) and re-confirm any paid model change. Images get the same question unless the user names a
model: `seedream_v4` first for text, `seedream_v5` first for editing. Details and limits:
[tools](references/tools.md) § Models.

## Delivery by platform

Always state the task_id, the format and each saved path. URLs from `output_urls` expire in about
5 minutes: never paste them as the result.

- **Hermes Desktop:** a model goes in an interactive 3D card, a paragraph that is only
  `::tripo-model{task="<task_id>"}` right after the create (step 4: it shows the progress and loads
  the model when the user opens it) or, after a download,
  `::tripo-model{path="<absolute model_file>" task="<task_id>"}` (one per model, each on its own
  line). Other clients show the line as text, so also write a downloaded path in prose. An image result
  (`tripo_generate_image`, a multiview sheet) is not a model: download it and put the image on a
  line that is only `MEDIA:<absolute path>` (`preview` in the download result; a multiview sheet
  has one file per view in `files`). Desktop shows it in the chat with a download button. Say the
  credits it cost and the image size.
  The card's **Next** menu sends a message about that task. A fixed-price follow-up ends with
  "This button message is my confirmation of the N-credit cost.": that sentence is the user's
  confirmation of the cost, but still ask any choice the message asks for. A message without it
  (a model, quality or clip choice sets the price) gets the `clarify` choice of Procedure step 1.
- **Chat apps (Telegram, Discord, Slack, WhatsApp, Signal, Matrix ...):** never emit the
  `::tripo-model` line or a markdown image (`![..](url)`, never). Attach files with lines that are
  only `MEDIA:<absolute path>`, from a download into Hermes' cache folder:
  [messaging](references/messaging.md). End with the next steps as a short numbered list with
  their credits, the same follow-ups as the Desktop Next menu (messaging § Next steps).
- **CLI / TUI:** plain text, no `MEDIA:` (printed literally): the absolute path in backticks, never
  as a clickable link.
- **Unattended runs** (cron, `hermes chat -q`, API runs without an approver): paid calls cannot be
  approved. Stop and say which call and cost you would run.

## Pitfalls

- Rig the ORIGINAL model task, not the `tripo_rig_check` task. Not riggable → stop before spending.
- `tripo_animate` presets follow the rig model named in the `tripo_rig` result: `preset:walk`
  style for v3.0 and v2.5 rigs, the body-type clip for creatures, `preset:biped:*` only for v1.0.
- `quad: true` output is FBX; `tripo_convert` to GLTF with quads is rejected.
- Leave `export_orientation` unset when the model will be textured, rigged or converted later;
  orient it on the final `tripo_convert` instead.
- `tripo_smart_segment` takes a file_token, URL or local path, never a task_id; `tripo_mesh_complete`
  needs a successful `tripo_segment` task.
- `tripo_decimate`'s `face_limit` is a target, not a ceiling; report the actual result.
- `smart_uv: true` on `tripo_decimate` needs `model: "v3.0"` (billed above v2.0): ask first.
- `tripo_image_to_splat` makes a Gaussian-splat scene, not an editable mesh: say so first.
- Errors naming `TRIPO_API_KEY` or authentication mean the key is missing or wrong in the plugin
  settings; the user must fix it and start a new session.

## Verification

- `tripo_balance` answers with a balance: the server is connected and the key is valid.
- After a download, the reported `model_file` exists and its size is non-zero.
