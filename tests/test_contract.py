"""Contracts against real Hermes core (CI runs this with hermes-agent v0.22.5 and main on PYTHONPATH).

The package goes through core's own Agent Plugins loader, and the server it declares goes through core's own
MCP approval gate, environment filter and media delivery check: a core change that would make Tripo spend
credits without asking, hand the server another credential or drop the skill's chat attachments fails here,
not on a user.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
TOOLS = json.loads((ROOT / "tests" / "fixtures" / "tools-list.json").read_text(encoding="utf-8"))["tools"]
READ_ONLY = {t["name"] for t in TOOLS if (t.get("annotations") or {}).get("readOnlyHint") is True}


@pytest.fixture
def package(tmp_path, monkeypatch):
    """This checkout installed the way `hermes plugins install` lays it out, loaded by core."""
    home = tmp_path / "hermes"
    root = home / "plugins" / "tripo"
    shutil.copytree(ROOT, root, ignore=shutil.ignore_patterns(
        ".git", "node_modules", "tests", "__pycache__", ".pytest_cache"))
    monkeypatch.setenv("HERMES_HOME", str(home))
    for name in ("HERMES_INTERACTIVE", "HERMES_GATEWAY_SESSION", "HERMES_YOLO_MODE", "HERMES_SESSION_KEY"):
        monkeypatch.delenv(name, raising=False)
    from hermes_cli.agent_plugins import load_agent_plugin

    return load_agent_plugin(root, home / "plugin-data" / "tripo")


def test_core_loads_the_package_as_an_untrusted_pinned_server_with_its_skills(package):
    server = package.mcp_servers["tripo"]
    assert server["trust"] == "untrusted"  # every call that is not read-only asks first
    args = [str(a) for a in server.get("args", [])]
    assert any(re.fullmatch(r"tripo-cli@\d+\.\d+\.\d+", a) for a in args), args  # pinned, never @latest
    assert args[-3:] == ["mcp", "--toolset", "full"], args
    assert [s.name for s in package.skills] == ["tripo-3d", "tripo-game-asset"]
    # A declaration key this core does not know yet may only warn; anything else is a broken package.
    assert all("needs a newer Hermes" in d.message for d in package.diagnostics), package.diagnostics


def test_core_runs_the_server_in_the_plugins_data_folder_on_the_international_api(package):
    server = package.mcp_servers["tripo"]
    data = Path(server["cwd"])
    assert data.parent.name == "plugin-data", data  # ${PLUGIN_DATA}: downloads never land in a project by default
    env = server["env"]
    assert Path(env["TRIPO_HOME"]).parent == data, env  # the CLI's history stays out of ~/.tripo
    assert env["TRIPO_REGION"] == "ov" and env["TRIPO_ANALYTICS_ENABLED"] == "0", env


def test_core_hands_the_server_the_profiles_tripo_key_and_no_other_credential(package, monkeypatch):
    from tools.mcp_tool_config import _build_safe_env, _interpolate_env_vars

    declared = package.mcp_servers["tripo"]["env"]
    monkeypatch.setenv("TRIPO_API_KEY", "tsk_fake")
    monkeypatch.setenv("OPENAI_API_KEY", "not-for-tripo")
    env = _build_safe_env(_interpolate_env_vars(declared))
    assert env["TRIPO_API_KEY"] == "tsk_fake"
    assert "OPENAI_API_KEY" not in env

    monkeypatch.delenv("TRIPO_API_KEY")
    env = _build_safe_env(_interpolate_env_vars(declared))
    assert "TRIPO_API_KEY" not in env  # unset: the CLI says to set the key, never sees a literal ${...}


def test_core_asks_before_every_tripo_call_that_is_not_read_only(package):
    from tools.mcp_tool_handlers import _trust_gate_check
    from tools.mcp_tool_registration import _record_tool_trust_metadata

    tools = [SimpleNamespace(name=t["name"], annotations=SimpleNamespace(**t["annotations"]) if t.get("annotations") else None)
             for t in TOOLS]
    _record_tool_trust_metadata("tripo", package.mcp_servers["tripo"], tools)
    for tool in tools:
        refused = (_trust_gate_check("tripo", tool.name) or "").lower()
        if tool.name in READ_ONLY:
            assert refused == "", (tool.name, refused)  # read-only calls never prompt
        else:
            assert "not approve" in refused or "blocked" in refused, (tool.name, refused)
    assert len(READ_ONLY) == 6, READ_ONLY


def test_core_lets_a_tripo_call_outlast_the_servers_longest_wait(package):
    """tripo_task_wait blocks up to its schema maximum, then reads the task once more: on a timeout shorter than
    twice that the call is cut off mid-wait, and repeated timeouts trip the server's breaker."""
    from tools.mcp_tool_common import _resolve_tool_timeout

    wait = next(t for t in TOOLS if t["name"] == "tripo_task_wait")
    longest = wait["inputSchema"]["properties"]["timeout_seconds"]["maximum"]
    assert _resolve_tool_timeout(package.mcp_servers["tripo"]) > 2 * longest


def test_core_finds_the_committed_desktop_bundle_inside_the_plugin_sdk():
    """No eval, no dynamic or remote import, no reach into the app's own DOM: the lint `hermes plugins validate`
    runs, over the bundle Desktop really loads."""
    from hermes_cli.plugin_validate_desktop import desktop_surface_hits

    bundle = (ROOT / "desktop" / "plugin.js").read_text(encoding="utf-8")
    assert 'from"@hermes/plugin-sdk"' in bundle and "tripo-model" in bundle
    assert desktop_surface_hits(ROOT) == []


def _messaging_reply_example() -> str:
    """The reply the skill tells the agent to send with a finished model on a chat platform."""
    doc = (ROOT / "skills" / "tripo-3d" / "references" / "messaging.md").read_text(encoding="utf-8")
    blocks = [b for b in re.findall(r"```[^\n]*\n(.*?)```", doc, re.DOTALL) if "MEDIA:" in b]
    assert len(blocks) == 1, blocks
    return blocks[0]


def test_core_delivers_the_skills_chat_reply_as_a_photo_and_a_file_even_in_strict_media_mode(tmp_path):
    """The streaming gateway path (Telegram's default) delivers only MEDIA: lines, so the skill's reply must be
    MEDIA: lines to files core accepts: the preview as a photo and the model (an extension core does not list)
    as a file. Strict mode with recency trust off leaves only core's delivery folders, and a fresh interpreter
    makes core compute those folders from this HERMES_HOME."""
    home = tmp_path / "hermes"
    reply = _messaging_reply_example().replace("<HERMES_HOME>", str(home)).replace("<task_id>", "0abc")
    probe = textwrap.dedent("""
        import json, os, re, sys
        from pathlib import Path
        home, reply = Path(sys.argv[1]), sys.argv[2]
        old = 1_000_000_000  # long before any recency window
        files = [Path(p.strip()) for p in re.findall(r"^MEDIA:(.+)$", reply, re.M)]
        control = home / "plugin-data" / "tripo" / "tripo-out" / "preview.png"  # outside the delivery folders
        for f in [*files, control]:
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(b"x")
            os.utime(f, (old, old))
        from gateway.platforms.base import BasePlatformAdapter, validate_media_delivery_path
        from gateway.run_notifications import _IMAGE_EXTS
        media, cleaned = BasePlatformAdapter.extract_media(reply)
        kept = BasePlatformAdapter.filter_media_delivery_paths(media)
        print(json.dumps({"files": [str(f.resolve()) for f in files], "cleaned": cleaned,
                          "kept": [str(Path(p).resolve()) for p, _ in kept],
                          "photo": [Path(p).suffix.lower() in _IMAGE_EXTS for p, _ in kept],
                          "control": validate_media_delivery_path(str(control))}))
    """)
    env = {k: v for k, v in os.environ.items() if not k.startswith("HERMES_")}
    env.update(HOME=str(tmp_path), HERMES_HOME=str(home), HERMES_MEDIA_DELIVERY_STRICT="1", HERMES_MEDIA_TRUST_RECENT_FILES="0")
    out = subprocess.run([sys.executable, "-c", probe, str(home), reply], env=env, capture_output=True,
                         text=True, encoding="utf-8", check=True).stdout
    result = json.loads(out.strip().splitlines()[-1])
    assert result["control"] is None, result  # strict mode is really on: a non-delivery folder is refused
    assert len(result["files"]) == 2, result  # the preview and the model
    assert result["kept"] == result["files"], result
    assert result["photo"] == [True, False], result
    assert "MEDIA:" not in result["cleaned"] and "](" not in result["cleaned"], result
