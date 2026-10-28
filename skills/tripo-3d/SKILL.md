---
name: tripo-3d
description: "Create 3D models with Tripo from a text prompt, one image or several views, then texture, rig, animate, retopologize, segment or convert them (GLB, FBX, OBJ, STL, USDZ, 3MF). Use when the user asks for a 3D model, prop, character, game asset, rigged or animated character, AR file or 3D print, wants to process a model they already have, or asks about their Tripo credits or earlier Tripo tasks."
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

- The user wants a 3D model, prop, character, game asset, AR file (USDZ) or 3D print.
- The user has a Tripo task id, a model file or a model URL to texture, rig, animate, convert,
  decimate, segment or repair.
- The user asks about their Tripo balance, spend or earlier generations.
- NOT for editing a local mesh by hand (use Blender or a mesh tool) or for 2D images that are not
  part of a 3D job.
- For game projects (face budgets, LODs, engine import), also read the `tripo-game-asset` skill.

## Prerequisites

- The `tripo` plugin installed and enabled, then a NEW Hermes session so the MCP tools load.
  The first start downloads Hermes' managed Node.js and the pinned tripo-cli; when the tools are
  missing right after installing, a new session usually fixes it.
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
| Model from text | `tripo_text_to_3d` → `tripo_task_wait` → `tripo_download` |
| Model from a photo | `tripo_image_to_3d` (URL, file_token or absolute local path) → wait → download |
| Model from 2–4 views | `tripo_multiview_to_3d` (`front` + at least one more) → wait → download |
| Concept image first | `tripo_generate_image` → user approves → `tripo_image_to_3d` with the image task_id |
| Rigged + animated character | T-pose model → `tripo_rig_check` (free) → `tripo_rig` → `tripo_animate` |
| Another file type | `tripo_convert` with `format` → wait → download |
| Existing local mesh | `tripo_import_model` with the absolute path → wait → any processing tool |
| Balance / spend | `tripo_balance`, `tripo_usage` (read-only) |

## Procedure

1. **Plan, then confirm.** Before the first call of any workflow that creates tasks, call
   `tripo_plan` with every intended step (tool, purpose, key params). It is read-only and free.
   Show the returned plan as a numbered list: for each step the tool, what it does, whether it is
   billed, and the approximate credits from [tools](references/tools.md) § Prices (say "about";
   the real charge is `credits_consumed`). Name the generation `model` and texture options. Then
   STOP and wait for the user's explicit yes. Re-plan and re-confirm when the goal changes or a
   failed step needs a different route. Read-only questions (balance, usage, status) need no plan.
   Hermes' approval prompt is the second gate, not the first, and it shows no price.
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
   - Hermes Desktop: if nothing else needs the result now, end the reply with
     `::tripo-model{task="<task_id>" title="<short name>"}` on its own line. The card shows the
     progress and the finished model. Wait only when the next step needs the finished task.
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
8. **Deliver for the surface you are on** (your system prompt names it): see below.

## Models

An explicit `model` always wins. When `model` is omitted, the server picks one and says why in
`notes`: P2 for game, real-time, editable, low-poly or quad requests and for a face budget P2
supports (48–50000 triangles, 48–25000 quads); v3.1 for dense geometry, v3-only options
(`geometry_quality`, `smart_low_poly`, `generate_parts`), budgets above P2's range and anything
unspecified. Image and multiview tools have no prompt to read, so set `model: "P2"` yourself when
the user's goal is a game or real-time asset. P1 is a lower-cost choice only when asked for;
v3.0 and v2.5 only to reproduce old work. Visual quality or texture quality never picks a geometry
model. Confirm the model before spending and re-confirm any paid model change. Details and limits:
[tools](references/tools.md) § Models.

## Delivery by platform

Always state the task_id, the format and each saved path. URLs from `output_urls` expire in about
5 minutes: never paste them as the result.

- **Hermes Desktop:** after a download, end the reply with a paragraph that is only
  `::tripo-model{path="<absolute model_file>" task="<task_id>"}` (one per model, each on its own
  line). Desktop renders an interactive 3D card. Other clients show the line as text, so also
  write the path in prose. For a task that is not downloaded yet, `::tripo-model{task="<task_id>"}`
  shows its progress and loads the model when the user opens it.
- **Chat apps (Telegram, Discord, Slack, WhatsApp, Signal, Matrix ...):** never emit the
  `::tripo-model` line or a markdown image (`![..](url)`, never). Attach files with lines that are
  only `MEDIA:<absolute path>`, from a download into Hermes' cache folder:
  [messaging](references/messaging.md). End with the next steps as a short numbered list.
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
