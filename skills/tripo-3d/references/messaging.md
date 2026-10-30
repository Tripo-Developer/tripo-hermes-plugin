# Chat apps (Telegram, Discord, Slack, WhatsApp, Signal, Matrix ...)

## Find HERMES_HOME

Run `hermes config path`. HERMES_HOME is the folder holding the `config.yaml` it prints; the CLI
already resolves the active profile, so never assume `~/.hermes`. Use that absolute path below
(on Windows a `C:\...` path, which `MEDIA:` accepts).

## Send the preview and the model

Download into Hermes' image cache: `tripo_download`
`{task_id: "<task_id>", output_dir: "<HERMES_HOME>/cache/images/tripo-<task_id>"}` (it asks for
approval like every non-read-only call). It returns absolute `preview` and `model_file` paths;
animation and format-conversion results have no `preview`, so send the model line alone.
Reply with those two paths copied verbatim, each on its own line (never shorten them to
`~/.hermes/...`; the model's file name depends on the task, e.g. `pbr_model.glb`):

```
Here's your treasure chest (task <task_id>, GLB).
MEDIA:<HERMES_HOME>/cache/images/tripo-<task_id>/preview.png
MEDIA:<HERMES_HOME>/cache/images/tripo-<task_id>/pbr_model.glb
```

The `.png` goes out as a photo and the model as a file attachment. `cache/images` is one of the
gateway's media delivery folders, so this works in strict media mode too; it is a cache, so
download right before you reply (`tripo_download` works again any time after the task succeeded).
Never `![preview](<url>)`: on a streaming gateway the image is dropped and the raw markdown stays in
the message. Never paste `output_urls` either: they expire in about 5 minutes.

Chat apps cap attachments: Telegram bots can send files up to 50 MB, Discord about 10 MB on servers
without boosts. Check the size first (`ls -l "<model_file>"`). When the model is larger, send only
the preview, state the size and the path on the Hermes machine, and offer a smaller export:
`tripo_convert` with `texture_size: 1024` or a `face_limit` (billed; ask first).

## Long jobs: don't hold the chat

Generation takes 1–4 minutes and later steps add more; a blocking wait keeps the chat silent for all
of it. On a chat app:

1. As soon as the create returns its `task_id`, reply in one line: "Started <what> (task <id>),
   about N min. I'll send it here when it's done." Do not call `tripo_task_wait` in this turn: it
   blocks for up to 55 s per call.
2. In the same turn, arm a wake sized to the job:
   `terminal(command="sleep 150 && echo tripo task <task_id>", background=true, notify_on_complete=true)`
   (text, image or multiview to 3D 150; texture, rig, animate, segment or mesh edit 120; convert,
   decimate, import, rig check or image steps 60; image to splat 240). `background=true` and
   `notify_on_complete=true` are both required: a sleep without them runs in the foreground and
   holds the chat. When the sleep exits, Hermes posts its completion into this chat as a new turn
   for you; the command line in that message carries the task id.
3. On that turn, check once with `tripo_task_status`. Finished: deliver it (download, preview,
   model, next steps), or, inside a confirmed multi-step plan, submit the next step and arm a new
   wake. Still running: arm one more sleep sized from its `progress`, but stop after about 15
   minutes of waiting in total and tell the user the task id and that it is still running on
   Tripo. Failed: say so with `failure_reason`; never re-create it on your own.
4. If the user writes in the meantime, answer them. For "is it done?" check with
   `tripo_task_status` (never `tripo_task_wait`) and deliver now if it finished; the wake that
   arrives later then gets a one-line "already sent above", not a second delivery. One wake per
   task: don't arm another while one is pending.
5. If the terminal tool is not available here, or its result says async notifications are
   unsupported (`notify_unsupported`: cron jobs, `hermes chat -q`), no wake will come: wait inline
   with `tripo_task_wait`, calling it again while the status is `queued` or `running`.

## Next steps

At the end of the workflow report the credits with `tripo_usage` (all task ids of the plan) and
list the next steps as a short numbered list with their credits, the same follow-ups the Desktop
card's Next menu offers for that result:

- a model (made from text, an image or views; retextured, imported or with fewer faces):
  Texture it · 10–30 credits (standard, detailed or extreme) when it has no texture, else
  Retexture · 10–30 credits (a new style); Remesh · 30 credits (triangles or quads),
  Resize · 10 credits, Check rigging · free, Rig it · 25 credits, Split into parts · 40 credits,
  Make it playable · 25–75 credits (rig and game clips); a text-to-3D model also
  Regenerate · the same credits again;
- a rigged model: Animate · 10 credits per clip, Make it playable · 10–50 credits;
- an animated model: Playable web prototype · free (a folder on the Hermes machine),
  Export to a game engine · up to 10 credits (Godot free, Unity or Unreal 5 or 10),
  Add clips · 10 credits per clip;
- an image or a multiview sheet: Make a 3D model · 30–110 credits (v3.1 30, P2 110, P1 50).

A reply with just a number picks that step and confirms a fixed price. When the price depends on
a choice (quality, clips, model, engine), ask it with the credits of each option first. Rig it runs
the free rig check first and stops when the model is not riggable. Make it playable, Playable web
prototype and Export to a game engine follow the Game Studio steps of the tripo-game-asset skill.
