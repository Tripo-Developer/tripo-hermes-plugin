"""Tripo plugin backend: what the Desktop half needs from the machine Hermes runs on.

Mounted at ``/api/plugins/tripo/`` once ``tripo`` is in ``plugins.enabled``. The Desktop renderer cannot read
files or call Tripo itself, so this router does both for the requesting profile (Hermes scopes the home and the
secrets per request; nothing here binds a path or a key at import). No route creates a task, so none spends
credits.

Routes:
    GET  /status          key configured? + balance and frozen credits + the Settings > Plugins > Tripo values
                          (no key -> configured: false, never an error)
    GET  /models?limit=   recent finished Tripo models (the account's usage, newest first) merged with the models
                          saved in the plugin's folder; without a key or offline, the local ones only
    GET  /task?task=      status, progress and preview of one task, for a ``::tripo-model{task=...}`` card
    GET  /active?tasks=   progress of the named in-flight tasks (``id,id``, at most 8) in one batch read
    GET  /file?path=      one model (.glb/.gltf/.fbx) or image as a data URL: an absolute path inside the plugin's
                          folder or the user's home, at most 128 MB
    POST /save            {task}: put a finished task's model in the plugin's folder for the viewer; the link is
                          read fresh from the API and every hop must stay on Tripo's result host
"""

from __future__ import annotations

import base64
import hashlib
import http.client
import json
import os
import re
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
_MODEL_MIME = {".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".fbx": "application/octet-stream"}
_MIME = {**_MODEL_MIME, ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
# What /save fetches for the viewer, best first: single-file formats only (a .gltf may need files beside it).
_VIEW_ORDER = (".glb", ".fbx")
# Always fullmatch: ``$`` also matches before a trailing newline.
_TASK_ID = re.compile(r"[0-9a-f][0-9a-f-]{15,63}")
_RUNNING = ("queued", "running")
_FAILED = ("failed", "cancelled", "banned", "expired")
# Task types whose result is never a 3D model: kept out of the recent-generations list.
_NOT_MODELS = frozenset({"text_to_image", "generate_image", "generate_multiview_image", "edit_multiview_image",
                         "smartsegment_image", "animate_prerigcheck", "image_to_splat"})
_ACTIVE_MAX = 8
# Tripo answers a bad key with HTTP 401 or one of these codes.
_AUTH_CODES = (1000, 1001, 1002)
# Mirrors plugin.json ``config_schema``; Settings > Plugins writes plugins.entries.tripo.settings.
_SETTING_DEFAULTS = {"show_credits": True, "inline_viewer": True, "gallery_limit": 24}


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
    """The (field, url) /save fetches: a GLB before an FBX, the textured model before the others."""
    urls = [(f, u) for f, u in _output_urls(task.get("output")) if _ext(u) in _VIEW_ORDER]
    urls.sort(key=lambda fu: (_VIEW_ORDER.index(_ext(fu[1])), 0 if "pbr" in fu[0] else 1))
    return urls[0] if urls else None


def _preview_url(task: dict) -> str | None:
    images = [(f, u) for f, u in _output_urls(task.get("output"))
              if _ext(u) in (".png", ".jpg", ".jpeg", ".webp") and "uv_render" not in f]
    images.sort(key=lambda fu: 0 if re.search(r"render|preview", fu[0]) else 1)
    return images[0][1] if images else None


def _prompt(task: dict) -> str | None:
    prompt = (task.get("input") or {}).get("prompt") if isinstance(task.get("input"), dict) else None
    return str(prompt)[:200] if isinstance(prompt, str) and prompt.strip() else None


def _view_file(names: list[str], folder: Path) -> Path | None:
    found = [folder / n for n in names if Path(n).suffix.lower() in _VIEW_ORDER and (folder / n).is_file()]
    found.sort(key=lambda p: (_VIEW_ORDER.index(p.suffix.lower()), 0 if "pbr" in p.name else 1))
    return found[0] if found else None


def _local_models() -> dict[str, dict]:
    """Task id -> the model saved for it under the plugin's tripo-out/ (tripo_download's or /save's task.json)."""
    out: dict[str, dict] = {}
    root = _data_root() / "tripo-out"
    if not root.is_dir():
        return out
    for record in root.glob("*/task.json"):
        try:
            data = json.loads(record.read_text(encoding="utf-8"))
            names = [n for n in data.get("files") or [] if isinstance(n, str) and "/" not in n and "\\" not in n]
            model = _view_file(names, record.parent)
            mtime = model.stat().st_mtime if model else 0
        except (OSError, ValueError, AttributeError, TypeError):
            continue
        task_id = data.get("task_id")
        if model is None or not isinstance(task_id, str) or not _TASK_ID.fullmatch(task_id):
            continue
        preview = record.parent / "preview.png"
        out[task_id] = {"path": str(model), "preview_path": str(preview) if preview.is_file() else None,
                        "type": str(data.get("type") or ""), "created_at": data.get("created_at"), "mtime": mtime}
    return out


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
    return {"task_id": task_id, "type": str(task.get("type") or local.get("type") or ""),
            "prompt": _prompt(task), "created_at": task.get("created_at") or local.get("created_at"),
            "credits": task.get("credits_consumed"), "thumbnail": _preview_url(task),
            "has_model": _model_url(task) is not None or bool(local), "path": local.get("path"),
            "preview_path": local.get("preview_path")}


@router.get("/models")
def models(limit: int = 0):
    limit = max(1, min(60, limit or _settings()["gallery_limit"]))
    local = _local_models()
    key = _api_key()
    rows, error = [], None
    if key:
        try:
            usage = _tripo("GET", "/v3/account/usage", key)
            ids = []
            for item in usage if isinstance(usage, list) else []:
                task_id = item.get("task_id") if isinstance(item, dict) else None
                if (isinstance(task_id, str) and _TASK_ID.fullmatch(task_id) and task_id not in ids
                        and item.get("type") not in _NOT_MODELS and item.get("status", "success") == "success"):
                    ids.append(task_id)
                if len(ids) == limit:
                    break
            details = _tasks(ids, key)
            for task_id in ids:
                row = _gallery_row(task_id, details.get(task_id) or {}, local.pop(task_id, None))
                if row["has_model"]:
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
                    "path": local["path"]}
        raise HTTPException(status_code=400, detail="no Tripo API key")
    row = _tripo("GET", f"/v3/tasks/{task_id}", key)
    row = row if isinstance(row, dict) else {}
    status = str(row.get("status") or "")
    return {"task": task_id, "status": status, "progress": _as_int(row.get("progress")),
            "type": str(row.get("type") or ""), "prompt": _prompt(row),
            "thumbnail": _preview_url(row) if status == "success" else None,
            "credits": row.get("credits_consumed"), "seconds_left": row.get("running_left_time"),
            "has_model": status == "success" and _model_url(row) is not None,
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
        raise HTTPException(status_code=415, detail="only GLB, glTF and FBX models and images")
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


@router.post("/save")
def save(body: dict):
    """The model a ``::tripo-model`` card shows, in the plugin's tripo-out/ (Tripo made it already: no credits).
    A model tripo_download or an earlier save put there is reused without a download."""
    task_id = _task_id(body.get("task") if isinstance(body, dict) else None)
    local = _local_models().get(task_id)
    if local:
        return {"path": local["path"], "saved": False}
    key = _api_key()
    if not key:
        raise HTTPException(status_code=400, detail="no Tripo API key")
    row = _tripo("GET", f"/v3/tasks/{task_id}", key)  # links expire within minutes: always a fresh read
    row = row if isinstance(row, dict) else {}
    if row.get("status") != "success":
        raise HTTPException(status_code=409, detail="the task has not finished")
    picked = _model_url(row)
    if picked is None:
        raise HTTPException(status_code=404, detail="this task has no GLB or FBX model")
    field, url = picked
    if not _result_allowed(url):
        raise HTTPException(status_code=502, detail="unexpected result host")
    slug = re.sub(r"[^a-z0-9_-]", "_", str(row.get("type") or "task").lower())[:40] or "task"
    root = _data_root()
    folder = root / "tripo-out" / f"{slug}-{task_id[:8]}"
    if not folder.resolve().is_relative_to(root.resolve()):
        raise HTTPException(status_code=409, detail="the plugin's model folder links elsewhere")
    try:
        folder.mkdir(parents=True, exist_ok=True)
        name = re.sub(r"[^a-z0-9_-]", "_", field.lower().removesuffix("_url")).strip("_") or "model"
        dest = folder / f"{name}{_ext(url)}"
        _write_new(dest, _result_chunks(url))
        record = {"task_id": task_id, "type": row.get("type"), "status": "success", "created_at": row.get("created_at"),
                  "credits_consumed": row.get("credits_consumed"), "files": [dest.name]}
        _write_new(folder / "task.json", [json.dumps(record, indent=2).encode("utf-8")])
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"could not write the file ({exc.strerror or type(exc).__name__})") from None
    return {"path": str(dest), "saved": True, "bytes": dest.stat().st_size}
