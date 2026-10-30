"""Tripo plugin backend: what the Desktop half needs from the machine Hermes runs on.

Mounted at ``/api/plugins/tripo/`` once ``tripo`` is in ``plugins.enabled``. The Desktop renderer cannot read
files or call Tripo itself, so this router does both for the requesting profile (Hermes scopes the home and the
secrets per request; nothing here binds a path or a key at import). No route creates a task, so none spends
credits.

Routes:
    GET  /status          key configured? + balance and frozen credits + the Settings > Plugins > Tripo values
                          (no key -> configured: false, never an error)
    GET  /models?limit=   recent finished Tripo models and images (the account's usage, newest first) merged with
                          the ones saved in the plugin's folder; without a key or offline, the local ones only
    GET  /task?task=      status, progress and preview of one task, for a ``::tripo-model{task=...}`` card, and
                          ``view_task``: the source task to show instead when a conversion only changed the format
    GET  /active?tasks=   progress of the named in-flight tasks (``id,id``, at most 8) in one batch read
    GET  /file?path=      one model (.glb/.gltf/.fbx/.obj/.stl/.usdz/.3mf), an OBJ's .mtl, or an image as a data
                          URL: an absolute path inside the plugin's folder or the user's home, at most 128 MB
    POST /save            {task, field?}: put a finished task's model (or the named output) in the plugin's folder;
                          the link is read fresh from the API and every hop must stay on Tripo's result host
    GET  /actions?task=   the card's Next menu: the follow-ups a finished task supports (Game Studio ones grouped), their
                          credits, a short note and the chat message each one sends
    GET  /formats?task=   the card's Download menu: the files Tripo made for the task, and conversions (chat messages)
    POST /provenance      {task_id, tool, args, session_id}: the tool call that made a task, kept for this profile's
                          own chats
    GET  /details?task=   what made a task (tool, model, prompt, source image or parent task, chat) for the gallery
    GET  /storage         bytes and files under the plugin's tripo-out/, and that folder
"""

from __future__ import annotations

import base64
import hashlib
import http.client
import json
import math
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter()

_API = "https://openapi.tripo3d.ai"
_KEY_ENV = "TRIPO_API_KEY"
_USER_AGENT = "hermes-tripo-plugin/0.1.0"
# Hermes keeps a portable plugin's data in plugin-data/agent-plugin-<slug>-<sha256(name)[:8]>. The MCP server runs
# there, so tripo_download's default tripo-out/<type>-<id8>/ folders are inside it.
_DATA_DIR = "agent-plugin-tripo-" + hashlib.sha256(b"tripo").hexdigest()[:8]
# Where a result link, and every redirect hop of it, may point: (scheme, host, port).
_RESULT_ORIGINS = frozenset({("https", "tripo-data.rg1.data.tripo3d.com", 443)})
_MAX_FILE_BYTES = 128 * 1024 * 1024
_MODEL_MIME = {".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".fbx": "application/octet-stream",
               ".obj": "model/obj", ".stl": "model/stl", ".usdz": "model/vnd.usdz+zip", ".3mf": "model/3mf"}
# What /file serves: models, an OBJ's material file, and images (previews, image tasks, OBJ textures).
_MIME = {**_MODEL_MIME, ".mtl": "text/plain", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
         ".webp": "image/webp"}
_IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".webp")
# What /save fetches for the viewer, best first (a .gltf may need files beside it, a .zip is not a model yet).
_VIEW_ORDER = (".glb", ".fbx", ".usdz", ".obj", ".3mf", ".stl")
# What the Download menu saves.
_SAVE_EXTS = (*_VIEW_ORDER, ".gltf", ".zip", *_IMAGE_EXTS)
# Always fullmatch: ``$`` also matches before a trailing newline.
_TASK_ID = re.compile(r"[0-9a-f][0-9a-f-]{15,63}")
# An output field as _output_urls names it: ``pbr_model``, ``views[0]``, ``a.b``.
_FIELD = re.compile(r"[A-Za-z0-9_.\[\]-]{1,120}")
_RUNNING = ("queued", "running")
_FAILED = ("failed", "cancelled", "banned", "expired")
_GENERATED = ("text_to_model", "image_to_model", "multiview_to_model")
# Results the model tools (tripo_texture, tripo_rig_check, tripo_convert ...) take by task id.
_MODELS = (*_GENERATED, "texture_model", "import_model", "highpoly_to_lowpoly")
_SHEETS = ("generate_multiview_image", "edit_multiview_image")
_IMAGES = ("text_to_image", "generate_image", *_SHEETS)
# Never listed: no model and no picture worth showing.
_UNLISTED = frozenset({"smartsegment_image", "animate_prerigcheck", "image_to_splat"})
_ACTIVE_MAX = 8
# Tripo answers a bad key with HTTP 401 or one of these codes.
_AUTH_CODES = (1000, 1001, 1002)
# Mirrors plugin.json ``config_schema``; Settings > Plugins writes plugins.entries.tripo.settings.
_SETTING_DEFAULTS = {"show_credits": True, "inline_viewer": True, "auto_rotate": True, "gallery_limit": 24}


class _TripoError(HTTPException):
    """A failed Tripo read; ``kind`` tells the status chip why: key_rejected, offline, not_found or api_error."""

    def __init__(self, status_code: int, detail: str, kind: str):
        super().__init__(status_code=status_code, detail=detail)
        self.kind = kind


def _settings() -> dict:
    from hermes_cli.config import load_config_readonly
    plugins = (load_config_readonly() or {}).get("plugins") or {}
    entry = (plugins.get("entries") or {}).get("tripo") or {}
    saved = entry.get("settings") if isinstance(entry.get("settings"), dict) else {}
    out = dict(_SETTING_DEFAULTS)
    for key, default in _SETTING_DEFAULTS.items():
        # bool is an int subclass: match the default's exact type so True never passes as a count.
        if type(saved.get(key)) is type(default):
            out[key] = saved[key]
    out["gallery_limit"] = max(1, min(60, out["gallery_limit"]))
    return out


def _api_key() -> str | None:
    from agent.secret_scope import get_secret
    return get_secret(_KEY_ENV) or None


def _data_root() -> Path:
    from hermes_constants import get_hermes_home
    return get_hermes_home() / "plugin-data" / _DATA_DIR


class _RedirectRefused(urllib.error.URLError):
    """A redirect to somewhere the request may not go."""


class _GuardedRedirects(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only where ``allowed`` says: urllib otherwise follows any hop to any host, plain http
    included, and re-sends the request's headers there (the API key, for an API call)."""

    def __init__(self, allowed):
        super().__init__()
        self._allowed = allowed

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not self._allowed(newurl):
            fp.close()
            raise _RedirectRefused("redirect off the allowed host")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _open(req, timeout: float, allowed):
    """urlopen, but every redirect hop is checked with ``allowed`` (the one network seam)."""
    return urllib.request.build_opener(_GuardedRedirects(allowed)).open(req, timeout=timeout)


def _origin(url: object) -> tuple | None:
    try:
        parts = urllib.parse.urlsplit(str(url or ""))
        port = parts.port or {"https": 443, "http": 80}.get(parts.scheme)
    except ValueError:
        return None
    if parts.username is not None or parts.password is not None:
        return None
    return parts.scheme, parts.hostname, port


def _same_api_origin(url: str) -> bool:
    return _origin(url) == _origin(_API)


def _result_allowed(url: object) -> bool:
    return _origin(url) in _RESULT_ORIGINS


def _api_failure(status: int, code: object) -> _TripoError:
    if status == 401 or code in _AUTH_CODES:
        return _TripoError(502, "Tripo rejected the API key", "key_rejected")
    if status == 404:
        return _TripoError(404, "Tripo has no such task for this key", "not_found")
    return _TripoError(502, f"Tripo API error {code if code is not None else status}", "api_error")


def _envelope_code(exc: urllib.error.HTTPError) -> object:
    try:
        body = json.loads(exc.read(4096).decode("utf-8", "replace"))
    except (OSError, ValueError, AttributeError):
        return None
    return body.get("code") if isinstance(body, dict) else None


def _tripo(method: str, path: str, key: str, body: dict | None = None, timeout: float = 15.0):
    """``data`` of one Tripo API call (``{code: 0, data}`` envelope), or a _TripoError."""
    headers = {"Authorization": f"Bearer {key}", "User-Agent": _USER_AGENT}
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(_API + path, data=None if body is None else json.dumps(body).encode("utf-8"),
                                 headers=headers, method=method)
    try:
        with _open(req, timeout, _same_api_origin) as resp:
            envelope = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise _api_failure(exc.code, _envelope_code(exc)) from None
    except (OSError, http.client.HTTPException, ValueError):  # refused redirect, timeout, reset, bad body
        raise _TripoError(502, "Tripo API unreachable", "offline") from None
    if not isinstance(envelope, dict) or envelope.get("code") != 0:
        raise _api_failure(200, envelope.get("code") if isinstance(envelope, dict) else None)
    return envelope.get("data")


def _tasks(task_ids: list[str], key: str) -> dict[str, dict]:
    data = _tripo("POST", "/v3/tasks/list", key, {"task_ids": task_ids}) if task_ids else {}
    found = data.get("tasks") if isinstance(data, dict) else None
    return {k: v for k, v in found.items() if isinstance(v, dict)} if isinstance(found, dict) else {}


def _task_id(raw: object) -> str:
    if not isinstance(raw, str) or not _TASK_ID.fullmatch(raw):
        raise HTTPException(status_code=400, detail="not a Tripo task id")
    return raw


def _as_int(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError, OverflowError):
        return 0


def _credits(value: object) -> int | float | None:
    """A credit amount (Tripo's are decimals) as a whole number when it is one: 30, not 30.0."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        number = float(value)
    except ValueError:
        return None
    if not math.isfinite(number):
        return None
    return int(number) if number.is_integer() else round(number, 2)


def _output_urls(value: object, path: str = "") -> list[tuple[str, str]]:
    """(field, url) for every link in a task's output, nested ones included (as tripo_download walks it)."""
    if isinstance(value, str):
        return [(path, value)] if value.startswith(("https://", "http://")) else []
    if isinstance(value, list):
        return [hit for i, v in enumerate(value) for hit in _output_urls(v, f"{path}[{i}]")]
    if isinstance(value, dict):
        return [hit for k, v in value.items() for hit in _output_urls(v, f"{path}.{k}" if path else str(k))]
    return []


def _ext(url: str) -> str:
    return Path(urllib.parse.urlsplit(url).path).suffix.lower()


def _model_url(task: dict) -> tuple[str, str] | None:
    """The (field, url) /save fetches: by _VIEW_ORDER (a GLB first), the textured model before the others."""
    urls = [(f, u) for f, u in _output_urls(task.get("output")) if _ext(u) in _VIEW_ORDER]
    urls.sort(key=lambda fu: (_VIEW_ORDER.index(_ext(fu[1])), 0 if "pbr" in fu[0] else 1))
    return urls[0] if urls else None


def _preview_url(task: dict) -> str | None:
    images = [(f, u) for f, u in _output_urls(task.get("output")) if _ext(u) in _IMAGE_EXTS and "uv_render" not in f]
    images.sort(key=lambda fu: 0 if re.search(r"render|preview", fu[0]) else 1)
    return images[0][1] if images else None


def _prompt(task: dict) -> str | None:
    prompt = (task.get("input") or {}).get("prompt") if isinstance(task.get("input"), dict) else None
    return str(prompt)[:200] if isinstance(prompt, str) and prompt.strip() else None


def _view_file(names: list[str], folder: Path) -> Path | None:
    found = [folder / n for n in names if Path(n).suffix.lower() in _VIEW_ORDER and (folder / n).is_file()]
    found.sort(key=lambda p: (_VIEW_ORDER.index(p.suffix.lower()), 0 if "pbr" in p.name else 1))
    return found[0] if found else None


def _image_file(names: list[str], folder: Path) -> Path | None:
    """An image task's own picture (tripo_download also copies the first one to preview.png)."""
    found = [folder / n for n in names if Path(n).suffix.lower() in _IMAGE_EXTS and (folder / n).is_file()]
    found.sort(key=lambda p: p.name == "preview.png")
    return found[0] if found else None


def _local_models(images: bool = False) -> dict[str, dict]:
    """Task id -> the model saved for it under the plugin's tripo-out/ (tripo_download's or /save's task.json); with
    ``images``, an image task's saved picture too (``kind`` tells them apart)."""
    out: dict[str, dict] = {}
    root = _data_root() / "tripo-out"
    if not root.is_dir():
        return out
    for record in root.glob("*/task.json"):
        try:
            data = json.loads(record.read_text(encoding="utf-8"))
            names = [n for n in data.get("files") or [] if isinstance(n, str) and "/" not in n and "\\" not in n]
            model = _view_file(names, record.parent)
            found = model or (_image_file(names, record.parent) if images and data.get("type") in _IMAGES else None)
            mtime = found.stat().st_mtime if found else 0
        except (OSError, ValueError, AttributeError, TypeError):
            continue
        task_id = data.get("task_id")
        if found is None or not isinstance(task_id, str) or not _TASK_ID.fullmatch(task_id):
            continue
        preview = record.parent / "preview.png"
        out[task_id] = {"path": str(found), "kind": "model" if model else "image",
                        "preview_path": str(preview) if preview.is_file() else None,
                        "type": str(data.get("type") or ""), "created_at": data.get("created_at"), "mtime": mtime,
                        "input": data.get("input")}
    return out


def _view_source(task_type: str, task_input) -> str | None:
    """A conversion that only changed the file format: its source task, whose model (a GLB for Tripo's own models)
    the card shows instead. Any other setting (face count, scale, pivot...) can change the mesh, so it shows the
    converted file."""
    if task_type != "convert_model" or not isinstance(task_input, dict):
        return None
    source = task_input.get("original_model_id")
    changed = [k for k, v in task_input.items() if v is not None and k not in ("format", "original_model_id")]
    return source if isinstance(source, str) and _TASK_ID.fullmatch(source) and not changed else None


@router.get("/status")
def status():
    settings = _settings()
    key = _api_key()
    if not key:
        return {"configured": False, "key_env": _KEY_ENV, "settings": settings}
    try:
        balance = _tripo("GET", "/v3/account/balance", key)
    except _TripoError as exc:
        return {"configured": True, "settings": settings, "error": exc.detail, "error_code": exc.kind}
    balance = balance if isinstance(balance, dict) else {}
    return {"configured": True, "settings": settings, "balance": balance.get("balance"), "frozen": balance.get("frozen")}


def _gallery_row(task_id: str, task: dict, local: dict | None) -> dict:
    local = local or {}
    kind = str(task.get("type") or local.get("type") or "")
    image = kind in _IMAGES
    return {"task_id": task_id, "type": kind, "kind": "image" if image else "model",
            "prompt": _prompt(task), "created_at": task.get("created_at") or local.get("created_at"),
            "credits": _credits(task.get("credits_consumed")), "thumbnail": _preview_url(task),
            "has_model": not image and (_model_url(task) is not None or bool(local)), "path": local.get("path"),
            "preview_path": local.get("preview_path")}


@router.get("/models")
def models(limit: int = 0):
    limit = max(1, min(60, limit or _settings()["gallery_limit"]))
    local = _local_models(images=True)
    key = _api_key()
    rows, error = [], None
    if key:
        try:
            usage = _tripo("GET", "/v3/account/usage", key)
            ids = []
            for item in usage if isinstance(usage, list) else []:
                task_id = item.get("task_id") if isinstance(item, dict) else None
                if (isinstance(task_id, str) and _TASK_ID.fullmatch(task_id) and task_id not in ids
                        and item.get("type") not in _UNLISTED and item.get("status", "success") == "success"):
                    ids.append(task_id)
                if len(ids) == limit:
                    break
            details = _tasks(ids, key)
            for task_id in ids:
                row = _gallery_row(task_id, details.get(task_id) or {}, local.pop(task_id, None))
                if row["has_model"] or (row["kind"] == "image" and (row["thumbnail"] or row["path"])):
                    rows.append(row)
        except _TripoError as exc:
            error = exc.detail
    for task_id, saved in sorted(local.items(), key=lambda kv: kv[1]["mtime"], reverse=True):
        rows.append(_gallery_row(task_id, {}, saved))
    return {"configured": bool(key), "models": rows[:limit], "error": error}


@router.get("/task")
def task_state(task: str):
    """For a ``::tripo-model{task=...}`` card: polled while the task runs, then the model is fetched with /save."""
    task_id = _task_id(task)
    local = _local_models().get(task_id)
    key = _api_key()
    if not key:
        if local:
            return {"task": task_id, "status": "success", "progress": 100, "type": local["type"], "has_model": True,
                    "path": local["path"], "view_task": _view_source(local["type"], local["input"])}
        raise HTTPException(status_code=400, detail="no Tripo API key")
    row = _tripo("GET", f"/v3/tasks/{task_id}", key)
    row = row if isinstance(row, dict) else {}
    status = str(row.get("status") or "")
    return {"task": task_id, "status": status, "progress": _as_int(row.get("progress")),
            "type": str(row.get("type") or ""), "prompt": _prompt(row),
            "thumbnail": _preview_url(row) if status == "success" else None,
            "credits": _credits(row.get("credits_consumed")), "seconds_left": row.get("running_left_time"),
            "has_model": status == "success" and _model_url(row) is not None,
            "view_task": _view_source(str(row.get("type") or ""), row.get("input")) if status == "success" else None,
            "path": local["path"] if local else None,
            "error": (str(row.get("error_message") or "") or status) if status in _FAILED else None}


@router.get("/active")
def active(tasks: str = ""):
    """``tasks``: the named ids still queued or running (newest first), ``done``: the ones that reached any other
    status, ``missing``: the ones Tripo does not know (yet)."""
    wanted = list(dict.fromkeys(part.strip() for part in tasks.split(",") if part.strip()))
    for task_id in wanted:
        _task_id(task_id)
    if len(wanted) > _ACTIVE_MAX:
        raise HTTPException(status_code=400, detail=f"at most {_ACTIVE_MAX} tasks")
    key = _api_key()
    if not key:
        return {"configured": False, "tasks": [], "done": [], "missing": []}
    found = _tasks(wanted, key)
    running = [{"task_id": t, "type": str(found[t].get("type") or ""), "status": found[t].get("status"),
                "progress": _as_int(found[t].get("progress")), "prompt": (_prompt(found[t]) or "")[:120],
                "created_at": found[t].get("created_at"), "seconds_left": found[t].get("running_left_time")}
               for t in wanted if t in found and found[t].get("status") in _RUNNING]
    running.sort(key=lambda t: str(t["created_at"] or ""), reverse=True)
    return {"configured": True, "tasks": running,
            "done": [t for t in wanted if t in found and found[t].get("status") not in _RUNNING],
            "missing": [t for t in wanted if t not in found]}


def _allowed_roots() -> list[Path]:
    """Where /file reads: the plugin's folder and the user's home (models the agent saved into a project).
    Secrets are kept out by extension, not by location."""
    return [r.resolve() for r in (_data_root(), Path.home()) if r.exists()]


def _resolve_readable(raw: str) -> Path:
    if not raw or "\x00" in raw:
        raise HTTPException(status_code=400, detail="path required")
    target = Path(os.path.expanduser(raw))
    if not target.is_absolute():
        raise HTTPException(status_code=400, detail="path must be absolute")
    try:
        resolved = target.resolve(strict=True)
    except (OSError, RuntimeError):
        raise HTTPException(status_code=404, detail="file not found") from None
    if resolved.suffix.lower() not in _MIME:
        raise HTTPException(status_code=415, detail="only GLB, glTF, FBX, OBJ (+ .mtl), STL, USDZ and 3MF models and images")
    if not any(resolved.is_relative_to(root) for root in _allowed_roots()):
        raise HTTPException(status_code=403, detail="outside the allowed folders")
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail="file not found")
    if resolved.stat().st_size > _MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="file too large for the viewer (128 MB)")
    return resolved


@router.get("/file")
def file(path: str):
    target = _resolve_readable(path)
    try:
        data = target.read_bytes()
    except OSError:  # removed or replaced since it was resolved
        raise HTTPException(status_code=404, detail="file not found") from None
    if len(data) > _MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail="file too large for the viewer (128 MB)")
    return {"name": target.name, "bytes": len(data), "mtime": int(target.stat().st_mtime * 1000),
            "dataUrl": f"data:{_MIME[target.suffix.lower()]};base64,{base64.b64encode(data).decode('ascii')}"}


def _result_chunks(url: str):
    """The bytes of a result link, streamed. No API key goes with it; refused over the size cap (declared or
    counted) and on any hop off Tripo's result host. Network failures become HTTP errors here, so an OSError the
    caller sees is its own disk."""
    if not _result_allowed(url):
        raise HTTPException(status_code=502, detail="unexpected result host")
    too_big = "model larger than the viewer's 128 MB"
    try:
        with _open(urllib.request.Request(url, headers={"User-Agent": _USER_AGENT}), 120, _result_allowed) as resp:
            declared = str(resp.headers.get("Content-Length") or "").strip()
            if declared.isdigit() and int(declared) > _MAX_FILE_BYTES:
                raise HTTPException(status_code=413, detail=too_big)
            copied = 0
            while chunk := resp.read(1 << 20):
                copied += len(chunk)
                if copied > _MAX_FILE_BYTES:
                    raise HTTPException(status_code=413, detail=too_big)
                yield chunk
    except _RedirectRefused:
        raise HTTPException(status_code=502, detail="the result link redirected off Tripo's result host") from None
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403, 404, 410):
            raise HTTPException(status_code=410, detail="the download link expired or is unavailable") from None
        raise HTTPException(status_code=502, detail=f"result download failed (HTTP {exc.code})") from None
    except (OSError, http.client.HTTPException):
        raise HTTPException(status_code=502, detail="result download unreachable") from None


def _write_new(dest: Path, chunks) -> None:
    """Publish ``chunks`` at ``dest`` through a freshly created staging file; nothing is left behind on failure."""
    part = dest.with_name(f".{dest.name}.{os.urandom(8).hex()}.part")
    try:
        # O_EXCL refuses any existing entry, a planted symlink included; os.replace swaps the name, not a target.
        fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o666)
        with open(fd, "wb") as out:
            for chunk in chunks:
                out.write(chunk)
        os.replace(part, dest)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"could not write the file ({exc.strerror or type(exc).__name__})") from None
    finally:
        part.unlink(missing_ok=True)


def _finished(task_id: str, key: str) -> dict:
    row = _tripo("GET", f"/v3/tasks/{task_id}", key)  # links expire within minutes: always a fresh read
    row = row if isinstance(row, dict) else {}
    if row.get("status") != "success":
        raise HTTPException(status_code=409, detail="the task has not finished")
    return row


def _task_folder(task_id: str, kind: str) -> Path:
    """tripo-out/<type>-<id8>/, where tripo_download saves the task by default."""
    slug = re.sub(r"[^a-z0-9_-]", "_", (kind or "task").lower())[:40] or "task"
    root = _data_root()
    folder = root / "tripo-out" / f"{slug}-{task_id[:8]}"
    if not folder.resolve().is_relative_to(root.resolve()):
        raise HTTPException(status_code=409, detail="the plugin's model folder links elsewhere")
    return folder


def _file_name(field: str, url: str) -> str:
    """tripo_download's name for an output (the CLI's fileNameFor), so a save finds a file it already saved."""
    base = re.sub(r"_+", "_", re.sub(r"[^A-Za-z0-9_.-]", "_", field.removesuffix("_url"))).strip("_")
    return f"{base or 'model'}{_ext(url)}"


def _record_file(folder: Path, row: dict, task_id: str, name: str) -> None:
    """List ``name`` in the folder's task.json (tripo_download's record, else a new one): the gallery reads it."""
    try:
        record = json.loads((folder / "task.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        record = None
    if not isinstance(record, dict) or record.get("task_id") != task_id:
        record = {"task_id": task_id, "type": row.get("type"), "status": "success", "created_at": row.get("created_at"),
                  "credits_consumed": row.get("credits_consumed"), "files": []}
    files = [n for n in record.get("files") or [] if isinstance(n, str)]
    if name in files:
        return
    record["files"] = [*files, name]
    _write_new(folder / "task.json", [json.dumps(record, indent=2).encode("utf-8")])


@router.post("/save")
def save(body: dict):
    """A finished task's file in the plugin's tripo-out/ (Tripo made it already: no credits): the model a
    ``::tripo-model`` card shows, or with ``field`` the output the Download menu names. A model tripo_download or an
    earlier save put there is reused without a download, and so is a named output already in the task's folder."""
    body = body if isinstance(body, dict) else {}
    task_id = _task_id(body.get("task"))
    wanted = body.get("field")
    if wanted is not None and not (isinstance(wanted, str) and _FIELD.fullmatch(wanted)):
        raise HTTPException(status_code=400, detail="not an output of a Tripo task")
    local = None if wanted else _local_models().get(task_id)
    if local:
        return {"path": local["path"], "saved": False}
    key = _api_key()
    if not key:
        raise HTTPException(status_code=400, detail="no Tripo API key")
    row = _finished(task_id, key)
    if wanted:
        picked = next(((f, u) for f, u in _output_urls(row.get("output")) if f == wanted and _ext(u) in _SAVE_EXTS), None)
        if picked is None:
            raise HTTPException(status_code=404, detail="this task has no such file")
    else:
        picked = _model_url(row)
        if picked is None:
            raise HTTPException(status_code=404, detail="this task has no model the viewer opens")
    field, url = picked
    if not _result_allowed(url):
        raise HTTPException(status_code=502, detail="unexpected result host")
    folder = _task_folder(task_id, str(row.get("type") or ""))
    dest = folder / _file_name(field, url)
    saved = not (wanted and dest.is_file())
    try:
        folder.mkdir(parents=True, exist_ok=True)
        if saved:
            _write_new(dest, _result_chunks(url))
        _record_file(folder, row, task_id, dest.name)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"could not write the file ({exc.strerror or type(exc).__name__})") from None
    return {"path": str(dest), "saved": saved, "bytes": dest.stat().st_size}


# The card's Next menu. Each row SENDS A CHAT MESSAGE: the agent runs the tool behind Hermes' approval prompt, so no
# route here spends credits. Credits are the list prices of skills/tripo-3d/references/tools.md § Prices; the chat-app
# list in references/messaging.md § Next steps names the same steps (tests/test_plugin_api.py keeps them equal).
_CONFIRM = "This button message is my confirmation of the {cost}-credit cost."
_TO_3D = "First ask me the model with clarify, one choice per model with its credits: v3.1 textured 30, P2 110, P1 50."
_TIERS = "the texture quality with clarify, one choice per tier with its credits: standard 10, detailed 20, extreme 30."
_STUDIO = "Follow the tripo-game-asset skill's Game Studio steps."
_ACTIONS = (
    # id, label, credits (a choice: its cheapest option; None: the task's own credits), price as the docs write it,
    # whether a choice sets the price (asked with clarify, so no confirmation sentence), task types, message
    ("texture", "Texture it", 10, "10–30 credits", True, _MODELS,
     f'texture it with tripo_texture (input "{{task}}", pbr false unless I ask for PBR). Ask me for a style only if I '
     f"haven't given one, and first ask me {_TIERS}"),
    ("retexture", "Retexture", 10, "10–30 credits", True, _MODELS,
     f'retexture it in a new style with tripo_texture (input "{{task}}", pbr false unless I ask for PBR). First ask me '
     f"the style in words (or a style image) and {_TIERS}"),
    ("decimate", "Remesh", 30, "30 credits", False, _MODELS,
     'remesh it with tripo_decimate (input "{task}", model v2.0, 30 credits). Suggest a target for what it is (player '
     "character about 15000 triangles, NPC 5000 to 15000, weapon about 3000, small prop about 1500; mobile about "
     "half), then ask me the target (500 to 20000 triangles or 500 to 10000 quads) and triangles or quads."),
    ("resize", "Resize", 10, "10 credits", False, _MODELS,
     'resize it with tripo_convert (input "{task}", format "GLTF", 10 credits as a convert with options). Ask me '
     "the size I want for its longest side in metres and pass that as scale_factor (a model Tripo generated "
     "measures one unit on its longest side)."),
    ("rig_check", "Check rigging", 0, "free", False, _MODELS,
     'check whether it can be rigged with tripo_rig_check (input "{task}", free) and tell me the result.'),
    ("rig", "Rig it", 25, "25 credits", False, _MODELS,
     'rig it with tripo_rig (input "{task}", 25 credits). Run tripo_rig_check (free) first and pass the rig_type it '
     "reports, with model v3.0 for a biped or v2.5 for an animal; if it is not riggable, stop and tell me. For a biped, ask me whose bone names to use (spec): unity "
     "(Unity Humanoid), unreal (UE Mannequin), mixamo, vrm or tripo."),
    ("segment", "Split into parts", 40, "40 credits", False, _MODELS,
     'split it into parts with tripo_segment (input "{task}", model v1.0, 40 credits).'),
    ("regenerate", "Regenerate", None, "the same credits again", False, ("text_to_model",),
     "regenerate it: a NEW tripo_text_to_3d task with the same prompt, model and options as this one (read them with "
     "tripo_task_status), {cost} credits."),
    ("animate", "Animate", 10, "10 credits per clip", True, ("animate_rig",),
     'animate this rig with tripo_animate (task_id "{task}", 10 credits per clip, at most 5). First ask me which clips '
     "with clarify, from the preset family the rig result names, and quote the total."),
    ("make3d", "Make a 3D model", 30, "30–110 credits", True, ("text_to_image", "generate_image"),
     f'make a 3D model from this image with tripo_image_to_3d (input "{{task}}"). {_TO_3D}'),
    ("make3d", "Make a 3D model", 30, "30–110 credits", True, _SHEETS,
     f'make a 3D model from these views with tripo_multiview_to_3d (multiview_task_id "{{task}}"). {_TO_3D}'),
    ("playable", "Make it playable", 25, "25–75 credits", True, _MODELS,
     f'make it a playable game character. {_STUDIO} Run tripo_rig_check (input "{{task}}", free) first and stop if it '
     "is not riggable. Then ask me with clarify which clips, each choice with its total (tripo_rig 25 plus 10 per "
     "tripo_animate clip): a biped idle, walk, run, jump and slash 75, or idle and walk 45; a quadruped, hexapod, "
     "octopod, serpentine or aquatic rig its one body-type clip 35; avian or others the rig alone 25."),
    ("playable", "Make it playable", 10, "10–50 credits", True, ("animate_rig",),
     f'make this rig a playable game character. {_STUDIO} Ask me with clarify which clips to animate with tripo_animate '
     '(task_id "{task}", 10 credits per clip, at most 5), from what its rig type supports, each choice with its total.'),
    ("prototype", "Playable web prototype", 0, "free", False, ("animate_retarget",),
     f"build a playable web prototype from it (no Tripo credits). {_STUDIO} Ask me for the folder first."),
    ("engine", "Export to a game engine", 0, "up to 10 credits", True, ("animate_retarget",),
     f"put it in my game project with a character controller. {_STUDIO} First ask me the engine with clarify: Godot "
     '(the GLB as it is, free), Unity or Unreal (tripo_convert input "{task}" to FBX, 5 credits, 10 with options).'),
    ("more_clips", "Add clips", 10, "10 credits per clip", True, ("animate_retarget",),
     'add clips with tripo_animate on its rig (task_id "{rig}", 10 credits per clip, at most 5). First ask me which '
     "clips with clarify, from what the rig type supports, counting the clips this one has so they land in one file, "
     "and quote the total."),
)
# Rows the card lists under a Game Studio heading, and the line the card shows under a row's label.
_GAME_ACTIONS = frozenset({"playable", "prototype", "engine", "more_clips"})
_NOTES = {"decimate": "Triangles or quads, textures baked on",
          "rig": "Humanoids and 6 creature types · Unity, Unreal, Mixamo or VRM bones",
          "segment": "Separate parts for modular kits",
          "playable": "Rig and clips, then play it in this card",
          "prototype": "A three.js game in your folder: move, attack, enemies",
          "engine": "Godot, Unity or Unreal, with a character controller"}
# The Download menu's conversions: each one is a new billed task, so its row sends a chat message too.
_CONVERT_FORMATS = ("FBX", "OBJ", "USDZ", "STL", "3MF")
_CONVERT_CREDITS = 5
_OUTPUT_LABEL = {"pbr_model": "textured model", "model": "model", "base_model": "untextured model",
                 "rendered_image": "preview image", "generated_image": "image"}


@router.get("/actions")
def actions(task: str):
    task_id = _task_id(task)
    key = _api_key()
    if not key:
        raise HTTPException(status_code=400, detail="no Tripo API key")
    row = _finished(task_id, key)
    kind = str(row.get("type") or "")
    spent = _credits(row.get("credits_consumed"))
    try:
        account = _tripo("GET", "/v3/account/balance", key)
        balance = _credits(account.get("balance")) if isinstance(account, dict) else None
    except _TripoError:
        balance = None
    what = " ".join((_prompt(row) or "").split())[:80]
    subject = f"Tripo task {task_id}" + (f' ("{what}")' if what else "")
    request = row.get("input") if isinstance(row.get("input"), dict) else {}
    untextured = request.get("texture") is False
    rig = request.get("original_model_id")  # an animation's rig task
    rig = rig if isinstance(rig, str) and _TASK_ID.fullmatch(rig) else None
    out = []
    for aid, label, credits, price, choice, kinds, message in _ACTIONS:
        cost = spent if aid == "regenerate" else credits
        if kind not in kinds or cost is None:
            continue  # never offer a step that cannot say what it spends
        if aid == ("retexture" if untextured else "texture") or (aid == "more_clips" and rig is None):
            continue  # a white model gets Texture it, a textured one Retexture
        text = f"{subject}: {message.format(task=task_id, cost=cost, rig=rig)}"
        out.append({"id": aid, "label": label, "cost": cost, "price": price, "choice": choice,
                    "affordable": balance is None or cost <= balance, "note": _NOTES.get(aid),
                    "group": "game" if aid in _GAME_ACTIONS else None,
                    "message": f"{text} {_CONFIRM.format(cost=cost)}" if cost and not choice else text})
    return {"task": task_id, "type": kind, "spent": spent, "balance": balance, "actions": out}


@router.get("/formats")
def formats(task: str):
    task_id = _task_id(task)
    key = _api_key()
    if not key:
        raise HTTPException(status_code=400, detail="no Tripo API key")
    row = _finished(task_id, key)
    kind = str(row.get("type") or "")
    folder = _task_folder(task_id, kind)
    urls = [(f, u) for f, u in _output_urls(row.get("output")) if _ext(u) in _SAVE_EXTS]
    files = []
    for field, url in urls:
        name = _file_name(field, url)
        what = _OUTPUT_LABEL.get(field.removesuffix("_url"), field.replace("_", " "))
        files.append({"field": field, "name": name, "label": f"{_ext(url)[1:].upper()} · {what}",
                      "saved": str(folder / name) if (folder / name).is_file() else None})
    have = {_ext(u)[1:].upper() for _f, u in urls}
    conversions = [{"format": fmt, "cost": _CONVERT_CREDITS,
                    "message": f'Tripo task {task_id}: convert it to {fmt} with tripo_convert (input "{task_id}", '
                               f'format "{fmt}", {_CONVERT_CREDITS} credits), then download the result. '
                               + _CONFIRM.format(cost=_CONVERT_CREDITS)}
                   for fmt in _CONVERT_FORMATS if kind in _MODELS and fmt not in have]
    return {"task": task_id, "type": kind, "files": files, "conversions": conversions}


# What made each task. Tripo's record keeps a text prompt and the request, but not which chat asked for it, so Desktop
# records the creating tool call from its tool.complete event; the gallery shows it as "Made from".
_PROV_NAME = "provenance.json"
_PROV_CAP = 2000
_PROV_SETTINGS = ("model", "texture_quality", "face_limit", "quad", "rig_type", "spec", "animations", "format", "size",
                  "quality", "template")
_TOOL = re.compile(r"tripo_[a-z0-9_]{1,40}")
_SESSION_ID = re.compile(r"[A-Za-z0-9_.:-]{1,128}")
_PROV_LOCK = threading.Lock()  # one tool_call's completions arrive together


def _prov_path() -> Path:
    return _data_root() / _PROV_NAME


def _load_prov() -> dict[str, dict]:
    try:
        rows = json.loads(_prov_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return {k: v for k, v in rows.items() if isinstance(v, dict) and _TASK_ID.fullmatch(k)} if isinstance(rows, dict) else {}


def _parent_of(args: object) -> str | None:
    """The task this one was made from, from its tool arguments or Tripo's copy of the request (the keys the CLI
    reads for its own parent_task_id)."""
    if not isinstance(args, dict):
        return None
    inputs = args.get("inputs")
    first = inputs[0] if isinstance(inputs, list) and inputs and isinstance(inputs[0], dict) else {}
    for value in (args.get("original_model_task_id"), args.get("multiview_task_id"), args.get("task_id"),
                  args.get("input"), first.get("task_id")):
        if isinstance(value, str) and _TASK_ID.fullmatch(value):
            return value
    return None


def _image_ref(args: dict) -> str | None:
    """The source image worth showing again: a local path, or a URL without its query (signed tokens)."""
    value = args.get("input")
    if not isinstance(value, str):
        return None
    if value.startswith(("https://", "http://")):
        parts = urllib.parse.urlsplit(value)
        value = urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    elif not os.path.isabs(value):
        return None  # a file_token or a task id
    return value[:1024] if _ext(value) in _IMAGE_EXTS else None


def _own_session(session_id: str) -> bool:
    """True when this profile's state.db holds the chat (read-only)."""
    import sqlite3
    from contextlib import closing

    from hermes_constants import get_hermes_home
    db = get_hermes_home() / "state.db"
    if not db.is_file():
        return False
    try:
        with closing(sqlite3.connect(f"{db.as_uri()}?mode=ro", uri=True, timeout=5)) as conn:
            return conn.execute("SELECT 1 FROM sessions WHERE id = ? LIMIT 1", (session_id,)).fetchone() is not None
    except sqlite3.Error:
        return False


@router.post("/provenance")
def provenance(body: dict):
    """Desktop sends a background profile's events to whichever backend is in front, so a record is kept only by the
    profile whose state.db holds the chat that made it; 409 for any other."""
    body = body if isinstance(body, dict) else {}
    task_id, tool, session_id = body.get("task_id"), body.get("tool"), body.get("session_id")
    if not (isinstance(task_id, str) and _TASK_ID.fullmatch(task_id) and isinstance(tool, str) and _TOOL.fullmatch(tool)):
        raise HTTPException(status_code=400, detail="task_id and a tripo_* tool required")
    if not (isinstance(session_id, str) and _SESSION_ID.fullmatch(session_id)) or not _own_session(session_id):
        raise HTTPException(status_code=409, detail="that chat is not on this profile")
    args = body.get("args") if isinstance(body.get("args"), dict) else {}
    row: dict = {"tool": tool, "session_id": session_id, "recorded_at": int(time.time() * 1000)}
    if isinstance(args.get("prompt"), str) and args["prompt"].strip():
        row["prompt"] = args["prompt"].strip()[:800]
    if parent := _parent_of(args):
        row["parent"] = parent
    if image := _image_ref(args):
        row["image"] = image
    settings = {k: (v[:200] if isinstance(v, str) else v[:10] if isinstance(v, list) else v) for k, v in args.items()
                if k in _PROV_SETTINGS and (isinstance(v, (str, int, float, bool))
                                            or (isinstance(v, list) and all(isinstance(i, str) for i in v)))}
    if settings:
        row["settings"] = settings
    with _PROV_LOCK:
        rows = _load_prov()
        rows[task_id] = row
        if len(rows) > _PROV_CAP:
            rows = dict(sorted(rows.items(), key=lambda kv: _as_int(kv[1].get("recorded_at")))[-_PROV_CAP:])
        _data_root().mkdir(parents=True, exist_ok=True)
        _write_new(_prov_path(), [json.dumps(rows, indent=1).encode("utf-8")])
    return {"ok": True}


@router.get("/details")
def details(task: str):
    """The recorded call, else Tripo's own record (its prompt and request), for one task. The recorded fields still
    show when Tripo cannot be read; ``remote_error`` says why its own are missing."""
    task_id = _task_id(task)
    rec = _load_prov().get(task_id, {})
    local = _local_models(images=True).get(task_id) or {}
    row, remote_error = {}, None
    key = _api_key()
    if key:
        try:
            found = _tripo("GET", f"/v3/tasks/{task_id}", key)
            row = found if isinstance(found, dict) else {}
        except _TripoError as exc:
            remote_error = None if exc.kind == "not_found" else exc.detail
    request = row.get("input") if isinstance(row.get("input"), dict) else {}
    settings = dict(rec.get("settings") or {})
    model = settings.pop("model", None) or (request.get("model") if isinstance(request.get("model"), str) else None)
    image = rec.get("image")
    viewable = False
    if isinstance(image, str) and not image.startswith(("http://", "https://")):
        try:
            viewable = bool(_resolve_readable(image))
        except HTTPException:
            pass  # moved, or outside the folders /file reads
    kind = str(row.get("type") or local.get("type") or "")
    return {"task": task_id, "type": kind, "kind": "image" if kind in _IMAGES else "model", "tool": rec.get("tool"),
            "model": model, "prompt": rec.get("prompt") or _prompt(row), "image": image, "image_viewable": viewable,
            "parent": rec.get("parent") or _parent_of(request), "settings": settings,
            "credits": _credits(row.get("credits_consumed")),
            "created_at": row.get("created_at") or local.get("created_at") or rec.get("recorded_at"),
            "path": local.get("path"), "session_id": rec.get("session_id"), "recorded": bool(rec),
            "remote_error": remote_error}


@router.get("/storage")
def storage():
    root = _data_root() / "tripo-out"
    sizes = []
    for path in root.rglob("*") if root.is_dir() else ():
        try:
            if path.is_file() and not path.is_symlink() and not path.name.endswith(".part"):
                sizes.append(path.stat().st_size)
        except OSError:
            continue
    return {"bytes": sum(sizes), "files": len(sizes), "directory": str(root if root.is_dir() else _data_root())}
