# Preview video for chat apps

Tripo returns a model file and a still preview image, never a video, and a chat app cannot turn a
3D model. So on a chat app render a short MP4 on the Hermes machine and send it as an attachment:
a static model becomes a 360° turntable, an animated one plays a clip (a dance, else a walk, else
its first) with a slow orbit.

## When to use

- An animated result on a chat app, by default: an animation task has no preview image, and the
  model file alone shows no motion.
- A static model when the user asks to see it turn ("show me it from every side"); otherwise its
  preview image is enough.
- Not on Hermes Desktop: the model's card plays it already, and lets the user play it.

## Render

Download the model first, as in [messaging](messaging.md) (Send the preview and the model):
`tripo_download` saves its `model_file` under `<HERMES_HOME>/cache/images/tripo-<task_id>`. The
script reads only `.glb`: a result made with `out_format: "fbx"` gets no video.

```bash
node <skill_dir>/scripts/render_preview.mjs "<model_file>" --label "Knight"
```

`<skill_dir>` is the `skill_dir` value skill_view returned for this skill, verbatim (never guess a
path under `~/.hermes`: another profile or install may hold an older copy). Options: `--clip NAME`
(the clip's name or part of it; `--list-clips` lists them), `--seconds N` (a turntable is 6 s; a
clip loops whole cycles to at least 4 s, at most 8 s), `--fps N` (default 30, 10 to 60), `--size N`
(square, default 720), `--max-mb N` (default 8), `--out /abs/file.mp4`, `--no-label`.

It prints one JSON line. On success: `{"ok": true, "out": "<absolute .mp4>", "mb": ..., "seconds":
..., "clip": ..., "render_s": ...}`. By default the video goes to
`<HERMES_HOME>/cache/videos/tripo/`, named after the download's folder, the model and the clip.
That is one of the gateway's media delivery folders, so the video goes out in strict media mode
too; keep the default unless the user names a place.

Rendering runs on the CPU (software WebGL in headless Chromium): a 720-pixel video of a rigged
character or a 1.5-million-triangle model takes 2 to 3 minutes. Give the terminal call a 600 s
timeout. The MP4 is H.264 without audio, encoded again at a lower bitrate when it would pass
`--max-mb`, never shortened. The page loads only what the GLB embeds: a texture the GLB links to
by URL renders white and is listed under `blocked_urls`. After the first run (see below) the
script downloads nothing.

## Deliver

One short sentence, then the video on its own line, with the exact `out` path from the JSON:

```
Here's your knight dancing (4.3 s loop).
MEDIA:<HERMES_HOME>/cache/videos/tripo/tripo-<task_id>-model-clip3-dance_01.mp4
```

Put the path only on the `MEDIA:` line: repeating it in the text can send the video twice. Check
the file against the chat app's upload caps in [messaging](messaging.md) first; at the default
`--max-mb` it fits them.

## If rendering is unavailable

The script ends with `{"ok": false, "error": ...}` when something is missing:

- Chromium or Chrome: the one Hermes' browser tool installs is found on its own (under
  `HERMES_RUNTIME_DIR`, or `tools/chromium-*` in HERMES_HOME), as is an installed Chrome, Chromium
  or Edge; else pass `--chrome /path`.
- ffmpeg: Hermes' own (`tools/ffmpeg-*` in HERMES_HOME), ffmpeg on PATH, or `FFMPEG_PATH`. Without
  it the script writes PNG frames instead and says so.
- three.js: the plugin's `node_modules` in a dev checkout, else `three@0.180.0` downloaded once
  from the npm registry (integrity-checked) into `<HERMES_HOME>/cache/tripo-preview/`. Needs Node
  22 or newer.

Then send what [messaging](messaging.md) describes instead (the preview image when the task has
one, and the model file), and tell the user what is missing and how to add it from the list
above. Do not retry the render in a loop.
