"""The Desktop backend (dashboard/plugin_api.py): what it reads, fetches and writes.

Real router code against a temp Hermes home and a temp user home. Tripo's API and result host are a loopback fake;
refusal tests arm a network tripwire instead, so every refusal must happen before the router reaches the network.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sqlite3
import threading
import urllib.request
from contextlib import closing
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from fastapi import HTTPException

_SRC = Path(__file__).resolve().parents[1] / "dashboard" / "plugin_api.py"
_SKILL = _SRC.parents[1] / "skills" / "tripo-3d"
_A = "a1b2c3d4-0000-4000-8000-00000000000a"
_B = "b1b2c3d4-0000-4000-8000-00000000000b"
_C = "c1b2c3d4-0000-4000-8000-00000000000c"
_IMG = "d1b2c3d4-0000-4000-8000-00000000000d"
_FAILED = "e1b2c3d4-0000-4000-8000-00000000000e"
_GLB = b"glTF\x02\x00\x00\x00fake-binary"


class _FakeTripo:
    """``routes[(method, path)] = (status, body, headers)``; every request is recorded in ``seen``."""

    def __init__(self):
        self.routes, self.seen = {}, []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def _serve(self):
                length = int(self.headers.get("Content-Length") or 0)
                fake.seen.append({"method": self.command, "path": self.path, "headers": dict(self.headers),
                                  "body": self.rfile.read(length) if length else b""})
                status, body, headers = fake.routes.get((self.command, self.path.split("?")[0]), (404, b"{}", {}))
                self.send_response(status)
                for name, value in headers.items():
                    if value is not None:
                        self.send_header(name, value)
                if "Content-Length" not in headers:
                    self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            do_GET = do_POST = _serve

            def log_message(self, *_args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def api(self, method, path, data=None, status=200, code=0):
        self.routes[(method, path)] = (status, json.dumps({"code": code, "data": data}).encode(), {})

    def asset(self, path, body, status=200, headers=None):
        self.routes[("GET", path)] = (status, body, headers or {})

    def paths(self):
        return [r["path"].split("?")[0] for r in self.seen]


@pytest.fixture
def api(tmp_path, monkeypatch):
    home, hermes = tmp_path / "home", tmp_path / "hermes"
    for d in (home, hermes, tmp_path / "outside"):
        d.mkdir()
    monkeypatch.setenv("HERMES_HOME", str(hermes))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.setenv("TRIPO_API_KEY", "tsk_fake")
    spec = importlib.util.spec_from_file_location("tripo_plugin_api_under_test", _SRC)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    mod.data = mod._data_root()
    mod.data.mkdir(parents=True)
    mod.tmp = tmp_path
    return mod


@pytest.fixture
def fake(api, monkeypatch):
    server = _FakeTripo()
    monkeypatch.setattr(api, "_API", server.base)
    monkeypatch.setattr(api, "_RESULT_ORIGINS", frozenset({("http", "127.0.0.1", server.port)}))
    yield server
    server.server.shutdown()
    server.server.server_close()


@pytest.fixture
def tripwire(monkeypatch):
    def trip(*_args, **_kwargs):
        raise AssertionError("network call reached before input validation")

    monkeypatch.setattr(urllib.request, "urlopen", trip)
    monkeypatch.setattr(urllib.request, "build_opener", trip)


def _status(fn, *args, **kwargs) -> int:
    with pytest.raises(HTTPException) as err:
        fn(*args, **kwargs)
    return err.value.status_code


def _task(fake, task_id, status="success", type_="text_to_model", output=None):
    if output is None:
        output = {"pbr_model": f"{fake.base}/assets/{task_id}/pbr_model.glb?sig=1",
                  "base_model": f"{fake.base}/assets/{task_id}/base_model.glb?sig=1",
                  "rendered_image": f"{fake.base}/assets/{task_id}/preview.webp?sig=1"}
    return {"task_id": task_id, "type": type_, "status": status, "progress": 100 if status == "success" else 40,
            "input": {"prompt": f"prompt of {task_id[:2]}"}, "credits_consumed": 20,
            "created_at": "2026-10-28T10:00:00Z", "running_left_time": 30 if status == "running" else None,
            "error_message": "content policy" if status == "failed" else None,
            "output": output if status == "success" else {}}


def _saved(api, task_id, name="pbr_model.glb", preview=False):
    folder = api.data / "tripo-out" / f"text_to_model-{task_id[:8]}"
    folder.mkdir(parents=True)
    (folder / name).write_bytes(_GLB)
    files = [name, *(["preview.png"] if preview else [])]
    if preview:
        (folder / "preview.png").write_bytes(b"\x89PNG")
    (folder / "task.json").write_text(json.dumps({"task_id": task_id, "type": "text_to_model", "files": files}))
    return folder / name


def test_the_data_folder_is_the_one_hermes_gives_the_plugin(api):
    from hermes_cli.plugins_state import PluginState

    assert api._data_root() == PluginState("tripo").data_dir  # ctx.state's folder: PLUGIN_DATA for the key "tripo"


def test_status_without_a_key_needs_no_network(api, tripwire, monkeypatch):
    monkeypatch.delenv("TRIPO_API_KEY")
    assert api.status() == {"configured": False, "key_env": "TRIPO_API_KEY",
                            "settings": {"show_credits": True, "inline_viewer": True, "auto_rotate": True,
                                         "gallery_limit": 24}}


def test_settings_come_from_the_profile_config_with_their_types_checked(api, tripwire, monkeypatch):
    monkeypatch.delenv("TRIPO_API_KEY")
    (api.tmp / "hermes" / "config.yaml").write_text(
        "plugins:\n  entries:\n    tripo:\n      settings:\n"
        "        show_credits: false\n        inline_viewer: \"no\"\n        auto_rotate: false\n        gallery_limit: 500\n")
    assert api.status()["settings"] == {"show_credits": False, "inline_viewer": True, "auto_rotate": False,
                                        "gallery_limit": 60}


def test_status_reads_the_balance_with_the_profiles_key(api, fake):
    fake.api("GET", "/v3/account/balance", {"balance": 460, "frozen": 20})
    out = api.status()
    assert (out["configured"], out["balance"], out["frozen"]) == (True, 460, 20)
    assert fake.seen[0]["headers"]["Authorization"] == "Bearer tsk_fake"


@pytest.mark.parametrize(("status", "code", "kind"), [(401, 1002, "key_rejected"), (200, 1002, "key_rejected"),
                                                      (500, 2000, "api_error")])
def test_status_says_why_there_is_no_balance(api, fake, status, code, kind):
    fake.api("GET", "/v3/account/balance", status=status, code=code)
    out = api.status()
    assert out["configured"] is True and out["error_code"] == kind and "balance" not in out


def test_status_reports_an_unreachable_api_as_offline(api, fake, monkeypatch):
    monkeypatch.setattr(api, "_API", "http://127.0.0.1:9")
    assert api.status()["error_code"] == "offline"


def _saved_image(api, task_id):
    folder = api.data / "tripo-out" / f"text_to_image-{task_id[:8]}"
    folder.mkdir(parents=True)
    for name in ("generated_image.jpg", "preview.png"):
        (folder / name).write_bytes(b"\xff\xd8jpeg")
    (folder / "task.json").write_text(json.dumps({"task_id": task_id, "type": "text_to_image",
                                                  "files": ["generated_image.jpg", "preview.png", "task.json"]}))
    return folder / "generated_image.jpg"


def test_models_lists_finished_models_and_images_newest_first_with_their_local_copies(api, fake):
    local_a = _saved(api, _A, preview=True)
    local_c = _saved(api, _C)
    fake.api("GET", "/v3/account/usage", [
        {"task_id": _IMG, "type": "text_to_image", "status": "success"},
        {"task_id": _A, "type": "text_to_model", "status": "success"},
        {"task_id": _FAILED, "type": "text_to_model", "status": "failed"},
        {"task_id": _B, "type": "image_to_model", "status": "success"},
    ])
    image = _task(fake, _IMG, type_="text_to_image", output={"generated_image": f"{fake.base}/assets/i.jpg?sig=1"})
    fake.api("POST", "/v3/tasks/list", {"tasks": {_IMG: image, _A: _task(fake, _A),
                                                  _B: _task(fake, _B, type_="image_to_model")}, "missed": []})
    rows = api.models(limit=10)["models"]
    assert [r["task_id"] for r in rows] == [_IMG, _A, _B, _C]
    assert json.loads(fake.seen[1]["body"]) == {"task_ids": [_IMG, _A, _B]}
    img, a, b, c = rows
    assert (img["kind"], img["has_model"], img["thumbnail"]) == ("image", False, f"{fake.base}/assets/i.jpg?sig=1")
    assert (a["kind"], a["path"], a["preview_path"], a["prompt"], a["credits"]) == (
        "model", str(local_a), str(local_a.parent / "preview.png"), "prompt of a1", 20)
    assert b["path"] is None and b["thumbnail"].endswith("/preview.webp?sig=1") and b["has_model"]
    assert c["path"] == str(local_c) and c["thumbnail"] is None
    assert [r["task_id"] for r in api.models(limit=1)["models"]] == [_IMG]


def test_models_without_a_key_or_offline_still_lists_the_local_models(api, fake, monkeypatch):
    _saved(api, _C)
    picture = _saved_image(api, _IMG)
    monkeypatch.setattr(api, "_API", "http://127.0.0.1:9")
    offline = api.models(limit=5)
    assert offline["error"] == "Tripo API unreachable"
    assert sorted((r["task_id"], r["kind"]) for r in offline["models"]) == [(_C, "model"), (_IMG, "image")]
    assert next(r for r in offline["models"] if r["kind"] == "image")["path"] == str(picture)
    monkeypatch.delenv("TRIPO_API_KEY")
    assert api.models(limit=5) == {"configured": False, "models": offline["models"], "error": None}


def test_task_reports_progress_then_the_model_then_a_failure(api, fake):
    fake.api("GET", f"/v3/tasks/{_A}", _task(fake, _A, status="running"))
    running = api.task_state(_A)
    assert (running["status"], running["progress"], running["has_model"], running["thumbnail"]) == ("running", 40, False, None)
    fake.api("GET", f"/v3/tasks/{_A}", _task(fake, _A))
    done = api.task_state(_A)
    assert done["has_model"] and done["thumbnail"].endswith("preview.webp?sig=1") and done["error"] is None
    fake.api("GET", f"/v3/tasks/{_A}", _task(fake, _A, status="failed"))
    assert api.task_state(_A)["error"] == "content policy"
    fake.api("GET", f"/v3/tasks/{_A}", status=404, code=2001)
    assert _status(api.task_state, _A) == 404


def test_a_conversion_that_only_changed_the_format_shows_its_source_model(api, fake, monkeypatch):
    convert = _task(fake, _B, type_="convert_model", output={"model": f"{fake.base}/assets/{_B}/model.fbx?sig=1"})
    convert["input"] = {"format": "FBX", "original_model_id": _A}
    fake.api("GET", f"/v3/tasks/{_B}", convert)
    assert (api.task_state(_B)["has_model"], api.task_state(_B)["view_task"]) == (True, _A)
    # A setting that can change the mesh shows the converted file itself (an STL now opens too).
    convert["input"] = {"format": "STL", "original_model_id": _A, "face_limit": 5000}
    convert["output"] = {"model": f"{fake.base}/assets/{_B}/model.stl?sig=1"}
    fake.api("GET", f"/v3/tasks/{_B}", convert)
    assert (api.task_state(_B)["has_model"], api.task_state(_B)["view_task"]) == (True, None)
    fake.api("GET", f"/v3/tasks/{_A}", _task(fake, _A))
    assert api.task_state(_A)["view_task"] is None
    # Without a key, the saved conversion's own record decides.
    folder = api.data / "tripo-out" / f"convert_model-{_B[:8]}"
    folder.mkdir(parents=True)
    (folder / "model.fbx").write_bytes(b"Kaydara FBX Binary")
    (folder / "task.json").write_text(json.dumps({"task_id": _B, "type": "convert_model", "files": ["model.fbx"],
                                                  "input": {"format": "FBX", "original_model_id": _A}}))
    monkeypatch.delenv("TRIPO_API_KEY")
    assert api.task_state(_B)["view_task"] == _A


def test_active_reads_only_the_named_tasks_in_one_call(api, fake):
    fake.api("POST", "/v3/tasks/list", {"tasks": {_A: _task(fake, _A, status="running"), _B: _task(fake, _B)},
                                        "missed": [_C]})
    out = api.active(f"{_A},{_B}, {_C},{_A}")
    assert [t["task_id"] for t in out["tasks"]] == [_A] and out["tasks"][0]["progress"] == 40
    assert (out["done"], out["missing"]) == ([_B], [_C])
    assert len(fake.seen) == 1 and json.loads(fake.seen[0]["body"]) == {"task_ids": [_A, _B, _C]}
    assert api.active("")["tasks"] == [] and len(fake.seen) == 1


def test_inputs_are_refused_before_any_network_call(api, tripwire):
    for bad in ("../../etc", "..\\..\\Windows", "", _A + "/../x", _A.upper(), _A + "\n"):
        for route in (api.task_state, api.actions, api.formats, api.details):
            assert _status(route, bad) == 400
        assert _status(api.save, {"task": bad}) == 400
    for bad in ("../../etc", _A + "/../x", _A.upper(), f"{_A},../x"):
        assert _status(api.active, bad) == 400
    for field in ("../x", "a/b", "a\\b", "", "x" * 121, 42, ["pbr_model"]):
        assert _status(api.save, {"task": _A, "field": field}) == 400
    assert _status(api.save, {"task": 42}) == 400
    assert _status(api.save, []) == 400
    nine = ",".join(f"{i}1b2c3d4-0000-4000-8000-00000000000a" for i in range(9))
    assert _status(api.active, nine) == 400
    assert not (api.data / "tripo-out").exists()


def test_file_reads_only_models_and_images_inside_the_allowed_folders(api, tripwire, monkeypatch):
    model = _saved(api, _A)
    out = api.file(str(model))
    assert out["name"] == "pbr_model.glb" and out["dataUrl"].startswith("data:model/gltf-binary;base64,")
    in_home = api.tmp / "home" / "project" / "knight.fbx"
    in_home.parent.mkdir()
    in_home.write_bytes(b"Kaydara FBX Binary")
    assert api.file(str(in_home))["name"] == "knight.fbx"
    obj = in_home.parent / "knight.obj"
    obj.write_text("mtllib knight.mtl\nv 0 0 0\n")
    (obj.parent / "knight.mtl").write_text("newmtl a\nmap_Kd knight.png\n")
    assert api.file(str(obj))["dataUrl"].startswith("data:model/obj;base64,")
    assert api.file(str(obj.parent / "knight.mtl"))["dataUrl"].startswith("data:text/plain;base64,")
    (obj.parent / "knight.blend").write_bytes(b"BLENDER")
    assert _status(api.file, str(obj.parent / "knight.blend")) == 415

    secret = api.tmp / "home" / ".env"
    secret.write_text("TRIPO_API_KEY=x")
    outside = api.tmp / "outside" / "stolen.glb"
    outside.write_bytes(_GLB)
    assert _status(api.file, "pbr_model.glb") == 400
    assert _status(api.file, str(secret)) == 415
    assert _status(api.file, str(api.tmp / "home" / "missing.glb")) == 404
    assert _status(api.file, str(outside)) == 403
    monkeypatch.setattr(api, "_MAX_FILE_BYTES", 4)
    assert _status(api.file, str(model)) == 413

    link = api.tmp / "home" / "innocent.glb"
    try:
        os.symlink(outside, link)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks need privileges on this Windows runner")
    monkeypatch.setattr(api, "_MAX_FILE_BYTES", 128 * 1024 * 1024)
    assert _status(api.file, str(link)) == 403  # the resolved target decides, not the link's location


def test_save_puts_the_model_in_the_plugin_folder_once_and_sends_no_key_to_the_result_host(api, fake):
    fake.api("GET", f"/v3/tasks/{_A}", _task(fake, _A))
    fake.asset(f"/assets/{_A}/pbr_model.glb", _GLB)
    out = api.save({"task": _A})
    dest = api.data / "tripo-out" / f"text_to_model-{_A[:8]}" / "pbr_model.glb"
    assert out == {"path": str(dest), "saved": True, "bytes": len(_GLB)} and dest.read_bytes() == _GLB
    download = next(r for r in fake.seen if r["path"].startswith("/assets/"))
    assert "Authorization" not in download["headers"]

    requests = len(fake.seen)
    assert api.save({"task": _A}) == {"path": str(dest), "saved": False}
    assert api.task_state(_A)["path"] == str(dest)
    assert len(fake.seen) == requests + 1  # the second save read nothing; the status read is the one call
    assert api.file(str(dest))["bytes"] == len(_GLB)


def test_save_refuses_unfinished_tasks_and_tasks_without_a_viewable_model(api, fake):
    fake.api("GET", f"/v3/tasks/{_A}", _task(fake, _A, status="running"))
    assert _status(api.save, {"task": _A}) == 409
    fake.api("GET", f"/v3/tasks/{_B}", _task(fake, _B, output={"model": f"{fake.base}/assets/m.zip"}))
    assert _status(api.save, {"task": _B}) == 404
    assert not (api.data / "tripo-out").exists()


def test_result_links_must_point_at_tripos_result_host(api):
    host = "tripo-data.rg1.data.tripo3d.com"
    assert api._result_allowed(f"https://{host}/tcli_x/m.glb?Policy=p&Signature=s&Key-Pair-Id=k")
    assert api._result_allowed(f"https://{host}:443/m.glb")
    for url in (f"http://{host}/m.glb", f"https://{host}.evil.com/m.glb", f"https://{host}@evil.com/m.glb",
                f"https://user@{host}/m.glb", f"https://evil.com/{host}/m.glb", f"https://x{host}/m.glb",
                f"https://{host}:8443/m.glb", f"https://{host}:99999/m.glb", "https://openapi.tripo3d.ai/m.glb",
                "file:///etc/passwd", "", None):
        assert not api._result_allowed(url), url


def test_save_refuses_a_result_link_off_the_result_host(api, tripwire, monkeypatch):
    row = {"task_id": _A, "type": "text_to_model", "status": "success",
           "output": {"pbr_model": "https://evil.example/m.glb"}}
    monkeypatch.setattr(api, "_tripo", lambda *_args, **_kwargs: row)
    assert _status(api.save, {"task": _A}) == 502
    assert not (api.data / "tripo-out").exists()


def test_save_stops_at_a_redirect_off_the_result_host(api, fake):
    fake.api("GET", f"/v3/tasks/{_A}", _task(fake, _A))
    fake.asset(f"/assets/{_A}/pbr_model.glb", b"", status=302,
               headers={"Location": f"http://localhost:{fake.port}/assets/stolen.glb"})
    with pytest.raises(HTTPException) as err:
        api.save({"task": _A})
    assert err.value.status_code == 502 and "redirected" in err.value.detail
    assert "/assets/stolen.glb" not in fake.paths()
    assert not list((api.data / "tripo-out").rglob("*.glb"))


def test_api_calls_never_follow_a_redirect_off_the_api(api, fake):
    fake.routes[("GET", "/v3/account/balance")] = (302, b"", {"Location": f"http://localhost:{fake.port}/steal"})
    assert api.status()["error_code"] == "offline"
    assert "/steal" not in fake.paths()


@pytest.mark.parametrize("declared", [True, False])
def test_save_caps_the_download_and_leaves_nothing_behind(api, fake, monkeypatch, declared):
    monkeypatch.setattr(api, "_MAX_FILE_BYTES", 16)
    fake.api("GET", f"/v3/tasks/{_A}", _task(fake, _A))
    fake.asset(f"/assets/{_A}/pbr_model.glb", b"x" * 64, headers={} if declared else {"Content-Length": None})
    assert _status(api.save, {"task": _A}) == 413
    assert not [p for p in (api.data / "tripo-out").rglob("*") if p.is_file()]


def test_an_expired_link_is_not_reported_as_a_bad_key(api, fake):
    fake.api("GET", f"/v3/tasks/{_A}", _task(fake, _A))
    fake.asset(f"/assets/{_A}/pbr_model.glb", b"denied", status=403)
    with pytest.raises(HTTPException) as err:
        api.save({"task": _A})
    assert err.value.status_code == 410 and "key" not in err.value.detail.lower()


def test_save_never_writes_through_a_linked_model_folder(api, fake):
    try:
        os.symlink(api.tmp / "outside", api.data / "tripo-out", target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("symlinks need privileges on this Windows runner")
    fake.api("GET", f"/v3/tasks/{_A}", _task(fake, _A))
    fake.asset(f"/assets/{_A}/pbr_model.glb", _GLB)
    assert _status(api.save, {"task": _A}) == 409
    assert not list((api.tmp / "outside").iterdir())


def test_save_with_a_field_saves_that_output_once_beside_the_model(api, fake):
    model = _saved(api, _A)
    fake.api("GET", f"/v3/tasks/{_A}", _task(fake, _A))
    fake.asset(f"/assets/{_A}/preview.webp", b"RIFFwebp")
    out = api.save({"task": _A, "field": "rendered_image"})
    dest = model.parent / "rendered_image.webp"
    assert out == {"path": str(dest), "saved": True, "bytes": 8} and dest.read_bytes() == b"RIFFwebp"
    record = json.loads((model.parent / "task.json").read_text())
    assert (record["type"], record["files"]) == ("text_to_model", ["pbr_model.glb", "rendered_image.webp"])

    downloads = len([p for p in fake.paths() if p.startswith("/assets/")])
    assert api.save({"task": _A, "field": "rendered_image"})["saved"] is False
    assert api.save({"task": _A, "field": "pbr_model"}) == {"path": str(model), "saved": False, "bytes": len(_GLB)}
    assert len([p for p in fake.paths() if p.startswith("/assets/")]) == downloads
    assert _status(api.save, {"task": _A, "field": "missing"}) == 404


def test_actions_offer_each_task_types_follow_ups_with_their_credits(api, fake):
    fake.api("GET", "/v3/account/balance", {"balance": 30, "frozen": 0})
    fake.api("GET", f"/v3/tasks/{_A}", _task(fake, _A))
    out = api.actions(_A)
    assert (out["type"], out["spent"], out["balance"]) == ("text_to_model", 20, 30)
    rows = {r["id"]: r for r in out["actions"]}
    assert list(rows) == ["texture", "decimate", "rig_check", "rig", "segment", "regenerate"]
    assert rows["rig"]["message"].startswith(f'Tripo task {_A} ("prompt of a1"): rig it with tripo_rig (input "{_A}"')
    assert rows["rig"]["message"].endswith("This button message is my confirmation of the 25-credit cost.")
    assert rows["regenerate"]["cost"] == 20 and rows["regenerate"]["message"].endswith("of the 20-credit cost.")
    assert "clarify" in rows["texture"]["message"] and "confirmation" not in rows["texture"]["message"]
    assert rows["rig_check"]["cost"] == 0 and "confirmation" not in rows["rig_check"]["message"]
    assert [a for a, r in rows.items() if not r["affordable"]] == ["segment"]

    for task_id, type_, tool in ((_IMG, "generate_image", "tripo_image_to_3d"),
                                 (_B, "generate_multiview_image", "tripo_multiview_to_3d")):
        output = {"generated_image": f"{fake.base}/assets/i.jpg"}
        fake.api("GET", f"/v3/tasks/{task_id}", _task(fake, task_id, type_=type_, output=output))
        (row,) = api.actions(task_id)["actions"]
        assert (row["id"], row["choice"]) == ("make3d", True) and tool in row["message"] and "P2 110" in row["message"]
    fake.api("GET", f"/v3/tasks/{_C}", _task(fake, _C, type_="animate_rig"))
    assert [r["id"] for r in api.actions(_C)["actions"]] == ["animate"]

    fake.api("GET", "/v3/account/balance", status=500, code=2000)
    assert api.actions(_A)["balance"] is None and all(r["affordable"] for r in api.actions(_A)["actions"])
    fake.api("GET", f"/v3/tasks/{_A}", _task(fake, _A, status="running"))
    assert _status(api.actions, _A) == 409


def test_the_next_menu_and_the_chat_app_list_offer_the_same_steps_at_the_same_prices(api):
    listed = " ".join((_SKILL / "references" / "messaging.md").read_text(encoding="utf-8").split())
    for _id, label, _cost, price, _choice, _kinds, _message in api._ACTIONS:
        assert f"{label} · {price}" in listed, label
    skill = " ".join((_SKILL / "SKILL.md").read_text(encoding="utf-8").split())
    assert api._CONFIRM.format(cost="N") in skill


def test_formats_lists_the_files_tripo_made_and_offers_conversions_as_chat_messages(api, fake):
    fake.api("GET", f"/v3/tasks/{_A}", _task(fake, _A))
    out = api.formats(_A)
    assert [(f["field"], f["name"], f["label"], f["saved"]) for f in out["files"]] == [
        ("pbr_model", "pbr_model.glb", "GLB · textured model", None),
        ("base_model", "base_model.glb", "GLB · untextured model", None),
        ("rendered_image", "rendered_image.webp", "WEBP · preview image", None)]
    assert [(c["format"], c["cost"]) for c in out["conversions"]] == [(f, 5) for f in ("FBX", "OBJ", "USDZ", "STL", "3MF")]
    assert out["conversions"][0]["message"].endswith("This button message is my confirmation of the 5-credit cost.")
    model = _saved(api, _A)
    assert api.formats(_A)["files"][0]["saved"] == str(model)

    quad = {"model": f"{fake.base}/assets/{_B}/model.fbx"}
    fake.api("GET", f"/v3/tasks/{_B}", _task(fake, _B, type_="image_to_model", output=quad))
    assert "FBX" not in [c["format"] for c in api.formats(_B)["conversions"]]
    fake.api("GET", f"/v3/tasks/{_IMG}", _task(fake, _IMG, type_="generate_image",
                                               output={"generated_image": f"{fake.base}/assets/i.jpg"}))
    image = api.formats(_IMG)
    assert [f["label"] for f in image["files"]] == ["JPG · image"] and image["conversions"] == []


def _chat(api, session_id="s-1"):
    with closing(sqlite3.connect(api.tmp / "hermes" / "state.db")) as db:
        db.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY)")
        db.execute("INSERT INTO sessions (id) VALUES (?)", (session_id,))
        db.commit()


def test_provenance_is_kept_only_for_this_profiles_own_chats(api, tripwire, monkeypatch):
    body = {"task_id": _B, "tool": "tripo_image_to_3d", "session_id": "s-1",
            "args": {"input": "https://cdn.example/dragon.png?token=signed", "model": "v3.1", "face_limit": 5000,
                     "api_key": "nope", "prompt": "  red dragon  "}}
    assert _status(api.provenance, body) == 409  # no state.db yet
    _chat(api)
    assert api.provenance(body) == {"ok": True}
    assert _status(api.provenance, {**body, "session_id": "s-2"}) == 409
    assert _status(api.provenance, {**body, "session_id": "s-1' OR '1'='1"}) == 409
    assert _status(api.provenance, {**body, "tool": "meshy_rig"}) == 400
    assert _status(api.provenance, {**body, "task_id": "../x"}) == 400
    rec = json.loads((api.data / "provenance.json").read_text())[_B]
    assert (rec["image"], rec["prompt"], rec["settings"]) == (
        "https://cdn.example/dragon.png", "red dragon", {"model": "v3.1", "face_limit": 5000})
    assert "nope" not in json.dumps(rec) and "signed" not in json.dumps(rec)

    picture = api.tmp / "home" / "ref.png"
    picture.write_bytes(b"\x89PNG")
    api.provenance({"task_id": _C, "tool": "tripo_image_to_3d", "session_id": "s-1", "args": {"input": str(picture)}})
    monkeypatch.delenv("TRIPO_API_KEY")
    out = api.details(_C)
    assert (out["image"], out["image_viewable"], out["tool"], out["session_id"]) == (
        str(picture), True, "tripo_image_to_3d", "s-1")
    assert api.details(_B)["image_viewable"] is False


def test_details_show_the_recorded_call_then_tripos_own_record(api, fake):
    _chat(api)
    api.provenance({"task_id": _C, "tool": "tripo_rig", "session_id": "s-1", "args": {"input": _A, "rig_type": "biped"}})
    fake.api("GET", f"/v3/tasks/{_C}", _task(fake, _C, type_="animate_rig"))
    out = api.details(_C)
    assert (out["tool"], out["parent"], out["session_id"], out["recorded"], out["credits"], out["kind"]) == (
        "tripo_rig", _A, "s-1", True, 20, "model")
    assert out["settings"] == {"rig_type": "biped"} and out["prompt"] == "prompt of c1"

    row = _task(fake, _B, type_="texture_model")
    row["input"] = {"prompt": "gold trim", "model": "v3.0", "original_model_task_id": _A}
    fake.api("GET", f"/v3/tasks/{_B}", row)
    out = api.details(_B)  # made outside Desktop (the CLI, say): nothing recorded
    assert (out["recorded"], out["model"], out["prompt"], out["parent"], out["session_id"], out["tool"]) == (
        False, "v3.0", "gold trim", _A, None, None)
    fake.api("GET", f"/v3/tasks/{_C}", status=500, code=2000)
    out = api.details(_C)
    assert out["remote_error"] == "Tripo API error 2000" and out["tool"] == "tripo_rig"


def test_storage_counts_what_the_plugin_saved(api, tripwire):
    assert api.storage() == {"bytes": 0, "files": 0, "directory": str(api.data)}
    _saved(api, _A, preview=True)
    (api.data / "tripo-out" / ".x.glb.0123.part").write_bytes(b"half")
    out = api.storage()
    saved = [p for p in (api.data / "tripo-out").rglob("*") if p.is_file() and not p.name.endswith(".part")]
    assert out == {"bytes": sum(p.stat().st_size for p in saved), "files": 3,
                   "directory": str(api.data / "tripo-out")}
