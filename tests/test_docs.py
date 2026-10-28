"""Docs contracts: what the README and the skills tell users and the agent must agree with the manifest, the pinned
server's tool list and each other."""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((ROOT / "plugin.json").read_text(encoding="utf-8"))
HERMES = MANIFEST["extensions"]["com.nousresearch.hermes"]
SCHEMA = HERMES["config_schema"]
SERVER = HERMES["servers"]["tripo"]
TOOLS = json.loads((ROOT / "tests" / "fixtures" / "tools-list.json").read_text(encoding="utf-8"))["tools"]
TOOL_NAMES = {t["name"] for t in TOOLS}
READ_ONLY = {t["name"] for t in TOOLS if (t.get("annotations") or {}).get("readOnlyHint") is True}
README = (ROOT / "README.md").read_text(encoding="utf-8")
SKILL_DOCS = {p.relative_to(ROOT).as_posix(): p.read_text(encoding="utf-8") for p in sorted((ROOT / "skills").rglob("*.md"))}
MAIN_SKILL = SKILL_DOCS["skills/tripo-3d/SKILL.md"]
COUNT_WORDS = {"five": 5, "six": 6, "seven": 7, "eight": 8}


def _flat(text: str) -> str:
    return " ".join(text.split())


def test_readme_gives_a_cli_command_for_every_setting():
    """Every option must be reachable off-Desktop as a plain `hermes config set` key."""
    missing = []
    for key, spec in SCHEMA.items():
        command = (f"hermes config set {spec['env']} " if spec.get("type") == "secret"
                   else f"hermes config set plugins.entries.{MANIFEST['name']}.settings.{key} ")
        if command not in README:
            missing.append(command)
    assert not missing, missing


def test_every_doc_sends_the_user_to_the_same_key_page():
    links = re.findall(r"developers\.tripo3d\.ai/[\w/-]+", SCHEMA["api_key"]["description"])
    assert links, "the settings form must say where the key is created"
    page = links[0]
    for name, text in {"README.md": README, "SKILL.md": MAIN_SKILL}.items():
        assert page in text, f"{name} does not point at {page}"


def test_upload_caps_agree_across_the_docs():
    caps: dict[str, dict[str, set[str]]] = {}
    for name, text in {"README.md": README, **SKILL_DOCS}.items():
        for platform, mb in re.findall(r"\b(Telegram|Discord|Slack|WhatsApp|Signal)\b[^.\d]{0,40}?(\d+)\s*[MG]B", text):
            caps.setdefault(platform, {}).setdefault(mb, set()).add(name)
    assert caps.get("Telegram") and caps.get("Discord"), caps
    disagreeing = {platform: found for platform, found in caps.items() if len(found) > 1}
    assert not disagreeing, disagreeing


def test_the_skills_never_have_the_agent_send_a_markdown_image():
    """Streaming gateways (Telegram's default) drop image links and leave the raw markdown: attach with MEDIA:."""
    offenders = []
    for name, text in SKILL_DOCS.items():
        for sentence in re.split(r"(?<=[.:])\s", text):
            if "![" in sentence and "never" not in sentence.lower():
                offenders.append((name, sentence.strip()[:120]))
    assert not offenders, offenders


def test_no_doc_promises_unattended_runs_never_spend():
    """Core reads `approvals.mode: off`, a `--yolo` process and saved Always answers in cron and `chat -q` too, so
    every doc that offers those settings says an unattended run then spends without asking, and what caps it."""
    assert "unattended runs refuse" not in README.lower()
    assert re.search(r"cannot approve, so with the default settings paid calls are refused", _flat(README))
    for name, text in {"README.md": README, "SKILL.md": MAIN_SKILL}.items():
        flat = _flat(text)
        assert re.search(r"unattended runs.{0,400}without asking", flat), name
        if "spend_limit" not in SERVER:
            assert re.search(r"no spend limit.{0,80}no cap", flat), name


def test_the_readme_discloses_what_the_approval_prompt_does_not_show():
    flat = _flat(README)
    if "costs" not in SERVER:
        assert "declares no per-tool costs" in flat
    if "spend_limit" not in SERVER:
        assert "no per-chat spend limit" in flat
    if "timeout" not in SERVER:
        assert "declares no `timeout`" in flat


def test_the_docs_list_exactly_the_servers_tools():
    section = README.split("\n## Tools\n", 1)[1].split("\n## ", 1)[0]
    assert re.search(rf"\b{len(TOOLS)} tools\b", section), "README's tool count"
    assert set(re.findall(r"`(tripo_\w+)`", section)) == TOOL_NAMES
    table = SKILL_DOCS["skills/tripo-3d/references/tools.md"]
    rows = dict(re.findall(r"^\| `(tripo_\w+)` \|.*\| (yes|no) \|$", table, re.M))
    assert set(rows) == TOOL_NAMES
    assert {name for name, prompts in rows.items() if prompts == "no"} == READ_ONLY


def test_every_list_of_prompt_free_tools_is_the_servers_read_only_set():
    for name, text in {"README.md": README, "SKILL.md": MAIN_SKILL}.items():
        found = re.search(r"\b(\w+) (?:read-only tools|tools are read-only)[^:.]*:(.*?)\.(?:\s|$)", _flat(text))
        assert found, name
        assert COUNT_WORDS.get(found.group(1).lower()) == len(READ_ONLY), (name, found.group(1))
        assert set(re.findall(r"`(tripo_\w+)`", found.group(2))) == READ_ONLY, name


def test_the_docs_state_the_servers_longest_wait():
    wait = next(t for t in TOOLS if t["name"] == "tripo_task_wait")
    longest = wait["inputSchema"]["properties"]["timeout_seconds"]["maximum"]
    assert f"up to {longest} s" in MAIN_SKILL
    assert f"at most {longest} s" in README
