# Tripo

Make 3D models from Hermes with [Tripo](https://developers.tripo3d.ai/en): text, image or
multiview to 3D, helper images (T-pose, multiview sheets, edits), texturing, rigging and
animation, retopology and smart UVs, segmentation and mesh editing, Gaussian splats, and format
conversion (GLB, FBX, OBJ, STL, USDZ, 3MF).

This is a portable [Agent Plugins v1](https://agent-plugins.org) package. One install ships:

- `mcp.json`: Tripo's official command-line tool [tripo-cli](https://www.npmjs.com/package/tripo-cli)
  (MIT) as a local MCP server, launched as `npx -y tripo-cli@0.9.0 mcp --toolset full` over stdio
  for every new session while the plugin is enabled. It serves the same tools as Tripo's hosted MCP
  server, plus local file paths and `tripo_download`. No `mcp_servers` edit in config.yaml.
- `skills/tripo-3d/` and `skills/tripo-game-asset/`: workflow skills. They carry the server's own
  rules (plan and confirm before spending, keep polling until a task finishes, never re-create an
  uncertain task, report the credits used), because Hermes does not pass MCP server instructions
  to the model, plus scenario recipes and a tool reference.
- A Hermes Desktop half (`desktop/plugin.js`, `dashboard/`): inline 3D cards, recent generations
  and a credit chip.

## Install

```bash
hermes plugins install tripo        # once the plugin is in the Nous plugin catalog
hermes plugins enable tripo
```

Until then, `hermes plugins install <git URL of this repository>` installs it the same way.

Then add your Tripo API key. In Hermes Desktop: **Settings → Plugins → Tripo** (or the gear on the
plugin's row in Capabilities → Plugins), paste it into *Tripo API key*, Save. The running Tripo
server restarts with the new key on its own. Without Desktop, either of these does the same:

```bash
hermes config set TRIPO_API_KEY tsk_...        # writes the profile's .env
# or put TRIPO_API_KEY=tsk_... in ~/.hermes/.env (~/.hermes/profiles/<name>/.env)
```

Create the key at [developers.tripo3d.ai/en/keys](https://developers.tripo3d.ai/en/keys) with an
international Tripo account; keys from Tripo's China site do not work here. Then ask, for example,
"Make a low-poly treasure chest for Godot" or "Turn ~/photos/mug.jpg into a 3D model and export
an STL for printing".

Requirements: nothing beyond Hermes. Hermes runs `npx` with its own managed Node.js and npm, which
it downloads on first use; on platforms it ships no build for, Node.js 20+ with `npx` on PATH is
needed. The first start also downloads the pinned package into npm's cache. If that first start
times out on a slow connection, start a new session once the downloads are done.

Already added Tripo's hosted MCP server to config.yaml (`mcp_servers.tripo`, for example from
Hermes' MCP catalog)? That entry has the same name and replaces this plugin's server, so local file
paths, downloads and the Desktop cards stop working, and its own `trust` applies instead of the
plugin's `trust: untrusted` (without one, every tool runs without asking). Remove it with
`hermes mcp remove tripo`, or keep it and skip this plugin.

## Spending credits: approval

Most Tripo tools spend credits (from 5 for a plain conversion to over 100 for a P2 generation; the
skill's `references/tools.md` lists the prices). The plugin marks the server `trust: untrusted`, so Hermes asks before every call that is
not read-only: creates, and also the free uploads, imports, rig checks and downloads, because they
send or write files. Six read-only tools run without a prompt: `tripo_plan`, `tripo_task_status`,
`tripo_task_wait`, `tripo_task_list`, `tripo_balance`, `tripo_usage`. Before any paid call the skill
has the agent draft the steps with `tripo_plan`, state the approximate credits and wait for your
yes; at the end it reports the real charges from `tripo_usage`. Unattended runs (cron,
`hermes chat -q`, a gateway with no approver) cannot approve, so with the default settings paid
calls are refused there. The settings under
[Full creative control](#full-creative-control-no-prompts) change that.

What the prompt's answers cover depends on your Hermes build:

| Answer | Hermes builds after v0.22.5 | v0.22.5 and older |
|---|---|---|
| Allow once | this call | this call |
| Allow for this session | that tool, for the rest of this chat | this call only |
| Always | that tool, in every chat of this profile (saved to `command_allowlist` as `mcp:tripo/<tool>`, e.g. `mcp:tripo/tripo_text_to_3d`; delete the line to revoke it) | this call only |

Each answer covers one tool: allowing `tripo_text_to_3d` does not allow `tripo_rig`.

This version declares no per-tool costs and no per-chat spend limit (`costs` and `spend_limit` in
`plugin.json`), so the prompt shows no price and nothing caps what a chat spends: the agent's plan
is where you see the estimate.

### Full creative control (no prompts)

The server always stays `trust: untrusted`: don't replace it with a `mcp_servers.tripo` entry in
`config.yaml`, because an entry without `trust` is fully trusted and runs every tool without asking.
To stop the prompts, use Hermes' own approval settings instead. On Hermes builds after v0.22.5, YOLO
mode skips them: `/yolo` for the current chat, `hermes --yolo` for that process, or
`approvals.mode: off` in `config.yaml` for the whole profile (`HERMES_YOLO_MODE=1` works too). Or
answer **Always** once per tool you want to run freely.

These settings apply to unattended runs too (cron jobs, `hermes chat -q`, a gateway with no
approver), not only to chats you watch. With `approvals.mode: off`, a process started with `--yolo`,
or an **Always** answer, such a run makes paid calls without asking, and with no spend limit
declared there is no cap on what it spends.

Prompts come back after `/yolo` is turned off, or after you delete the `command_allowlist` lines.

## Long jobs and chat apps

A generation takes 1–4 minutes. `tripo_task_wait` waits at most 55 s per call and the agent calls
it again until the task finishes, so no call comes near Hermes' 300 s MCP timeout and the plugin
declares no `timeout` of its own.

In Telegram, Discord, Slack and other chat apps the skill has the agent reply "started, about N
min" and end its turn, with a background timer that brings it back to check and deliver, so the chat
is not blocked meanwhile. Results arrive as attachments (`MEDIA:` lines): the preview as a photo
and the model file as a document. Telegram bots can send files up to 50 MB, Discord about 10 MB on
servers without boosts; a larger model comes as the preview plus its path on the Hermes machine,
with an offer of a smaller export.

## Where files go

`tripo_download` saves to the absolute `output_dir` the agent passes: your project folder when you
name one, `<HERMES_HOME>/cache/images/tripo-<task id>/` for chat attachments. Without it, files go
to `tripo-out/` in the plugin's data folder
(`~/.hermes/plugin-data/agent-plugin-tripo-<hash>/tripo-out/`), not your project. Each download
holds the model, `preview.png` and `task.json`, and replaces files of the same name in that folder.

## Settings

One page in Desktop: **Settings → Plugins → Tripo**. Every option is a plain config key too, so the
CLI and other surfaces reach the same values:

| Setting | Default | CLI |
|---|---|---|
| Tripo API key (`api_key`) | — | `hermes config set TRIPO_API_KEY tsk_...` (stored in `.env`, never `config.yaml`) |
| Credit balance in the status bar (`show_credits`) | on | `hermes config set plugins.entries.tripo.settings.show_credits false` |
| Inline 3D cards in chat (`inline_viewer`) | on | `hermes config set plugins.entries.tripo.settings.inline_viewer false` (directive lines then show as text) |
| Recent generations shown (`gallery_limit`) | 24 | `hermes config set plugins.entries.tripo.settings.gallery_limit 10` (1–60) |

Desktop applies a saved change immediately; nothing needs a restart.

## Hermes Desktop

Turn on the plugin's **Desktop** switch in Capabilities → Plugins (Desktop halves are opt-in) and
you get, rendered with stock three.js:

- **Inline 3D cards.** After a download the agent ends its reply with
  `::tripo-model{path="/abs/model.glb" task="<task_id>"}`; Desktop shows it as a card you can orbit,
  zoom and switch to wireframe. Other clients show the line as text. Right after starting a job the
  agent can post just `::tripo-model{task="<task_id>"}` and reply at once: the card shows Tripo's
  progress, then the preview, and saves the model into the plugin's folder (free) when you click
  View in 3D.
- **Recent generations** (⌘K → "Tripo: recent generations", or click the credit chip): your recent
  Tripo tasks next to the models already on this machine, with a viewer.
- **Credit chip** in the status bar, refreshed after every Tripo tool call; while a Tripo task runs
  it shows the task's progress instead.
- On Desktop builds with plugin media renderers, a model file a Tripo tool saved and the reply
  attaches with a `MEDIA:` line opens in the same viewer instead of a plain file row.

The renderer never reads files or holds the key. `dashboard/plugin_api.py` (mounted at
`/api/plugins/tripo/` once the plugin is enabled) answers the viewer: the balance and recent tasks
from Tripo's API, model and image bytes from the plugin's data folder or your home folder only
(GLB, glTF, FBX and preview images up to 128 MB, symlinks resolved first), and downloads of task
results from Tripo's result storage only.

## Tools

27 tools (about 11K tokens of schemas), loaded on demand through Hermes' tool search, so they cost
nothing in the prompt until used. Hermes exposes them as `mcp__tripo__<tool>`:

Generation: `tripo_text_to_3d`, `tripo_image_to_3d`, `tripo_multiview_to_3d`,
`tripo_image_to_splat`.
Images: `tripo_generate_image`, `tripo_image_to_multiview`, `tripo_edit_multiview`,
`tripo_upload_image`.
Processing: `tripo_import_model`, `tripo_texture`, `tripo_convert`, `tripo_decimate`,
`tripo_smart_uv`, `tripo_segment`, `tripo_mesh_complete`, `tripo_mesh_edit`,
`tripo_smart_segment`.
Characters: `tripo_rig_check`, `tripo_rig`, `tripo_animate`.
Tasks and account: `tripo_plan`, `tripo_task_status`, `tripo_task_wait`, `tripo_task_list`,
`tripo_balance`, `tripo_usage`, `tripo_download`.

## Privacy

- The server sends prompts, the images and models you reference by path or URL, and task requests
  to Tripo's API (`openapi.tripo3d.ai`) under your key. `tripo_upload_image` fetches the image URL on
  this machine first (public addresses only, up to 20 MB) and uploads the bytes to Tripo.
- Analytics are off: the plugin sets `TRIPO_ANALYTICS_ENABLED=0`, so tripo-cli sends no usage
  events and makes no account lookup for them. `TRIPO_REGION=ov` pins the international API.
- Hermes passes MCP servers a filtered environment; this server gets only `TRIPO_API_KEY` from your
  profile, plus the plugin's fixed `TRIPO_HOME`, `TRIPO_REGION` and `TRIPO_ANALYTICS_ENABLED`.
- tripo-cli appends each submitted task (task id, type and the request parameters, prompt included)
  to `history.jsonl` in `tripo-home/` inside the plugin's data folder. It does not read or write
  `~/.tripo`, so a tripo-cli you use in a terminal keeps its own key and history.
- The first start downloads `tripo-cli@0.9.0` from the npm registry.
- In chat apps the skill uses Hermes' terminal tool: `hermes config path` to find the media folder,
  `ls -l` to check a file's size before attaching it, and a background `sleep … && echo` timer that
  wakes the chat when a job should be done.
- The Desktop half's backend reads your balance and recent tasks from the same API with your key,
  and downloads a finished model from Tripo's result storage (no key sent) only when you open it.
  Desktop loads task previews straight from Tripo's short-lived result links.

## Why local and not the hosted server

Tripo also runs a hosted MCP server (OAuth sign-in, no local install). This plugin runs the same
tool set locally because local file inputs (absolute paths), downloads to disk, chat attachments
and the Desktop cards all need the server on the machine that holds the files.

## Version pinning

`mcp.json` pins `tripo-cli@0.9.0`. Bumping it is a commit here (with `tests/fixtures/tools-list.json`
regenerated from the new version; `node scripts/validate.mjs` checks they match) followed by a
reviewed SHA bump in the
[hermes-agent plugin catalog](https://github.com/NousResearch/hermes-agent/tree/main/plugin-catalog).
`@latest` is deliberately not used.

## Development

```bash
node scripts/validate.mjs                                    # package rules, zero dependencies
PYTHONPATH=/path/to/hermes-agent python -m pytest tests -q   # contracts against real Hermes code
npm ci && npm run typecheck && npm test && npm run build     # Desktop half; commit desktop/plugin.js
```

`docs/testing.md` covers local runs against an isolated `HERMES_HOME` and the acceptance scenarios.

## Attribution

The MCP server (tripo-cli), the workflow rules the skills carry and the packaging are by VAST, the
company behind Tripo, MIT. The Desktop viewer adapts parts of the Meshy plugin's viewer from
[Hermes Official Plugins](https://github.com/NousResearch/hermes-official-plugins) (MIT, Copyright
(c) 2025 Nous Research); `LICENSE` carries that notice. `desktop/plugin.js` bundles three.js (MIT, its
notice kept in the bundle) and the meshoptimizer decoder that ships with it (MIT, notice in `LICENSE`),
which embeds its WebAssembly decoder as a string.
