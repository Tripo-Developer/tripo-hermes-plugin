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


PRICES = _flat(SKILL_DOCS["skills/tripo-3d/references/tools.md"].split("\n## Prices\n", 1)[1])


def test_every_offered_image_model_has_a_price():
    """The model choice quotes each option's credits; gemini-* names are aliases and chat_image_1* are retiring."""
    image = next(t for t in TOOLS if t["name"] == "tripo_generate_image")
    offered = {m for m in image["inputSchema"]["properties"]["model"]["enum"]
               if not m.startswith(("gemini-", "chat_image_1"))}
    assert offered <= set(re.findall(r"`([\w.]+)`", PRICES)), offered - set(re.findall(r"`([\w.]+)`", PRICES))


def test_paid_choices_are_asked_with_clarify_and_the_listed_credits():
    flat = _flat(MAIN_SKILL)
    assert "ask with the `clarify` tool: one choice per option naming it and its approximate credits" in flat
    examples = re.findall(r'"(v3\.1|P1|P2)[^"]*· about (\d+) credits"', flat)
    assert len(examples) == 3, examples
    for model, credits in examples:
        row = re.search(rf"\| (?:image- or multiview-to-3D|any generation), {re.escape(model)} \| \d+ bare / (\d+) textured",
                        PRICES)
        assert row and row.group(1) == credits, model


def test_p2_is_the_default_p_series_model_and_p1_comes_only_when_the_user_names_or_picks_it():
    examples = re.findall(r'"(v3\.1|P1|P2)[^"]*· about \d+ credits"', _flat(MAIN_SKILL))
    assert examples == ["v3.1", "P2", "P1"], examples
    models = _flat(MAIN_SKILL.split("\n## Models\n", 1)[1].split("\n## ", 1)[0])
    assert "P2 is the default P-series model; P1 only when the user names it or picks it" in models
    assert "| **P1** | lower cost, only when the user names it or picks it |" in SKILL_DOCS["skills/tripo-3d/references/tools.md"]
    assert "(v3.1 30, P2 110, P1 50)" in SKILL_DOCS["skills/tripo-3d/references/messaging.md"]
    assert "P1 only when the user names it or picks it" in _flat(SKILL_DOCS["skills/tripo-game-asset/SKILL.md"])
    assert "Ask offers v3.1, P2 and P1" in SCHEMA["default_model"]["description"]


def test_desktop_shows_images_in_the_chat_and_models_in_the_card():
    desktop = _flat(MAIN_SKILL.split("- **Hermes Desktop:**", 1)[1].split("\n- **", 1)[0])
    assert "::tripo-model{path=" in desktop
    assert re.search(r"An image result .{0,200}a line that is only `MEDIA:<absolute path>`", desktop)
    assert "This button message is my confirmation of the N-credit cost." in desktop


def test_desktop_posts_a_models_card_right_after_the_create():
    wait = _flat(MAIN_SKILL.split("4. **Wait for the task.**", 1)[1].split("\n5. ", 1)[0])
    assert "**Hermes Desktop: don't wait for a model when nothing else needs it.** Right after the create" in wait
    assert '`::tripo-model{task="<task_id>" title="<short name>"}` on its own line; steps 6–7 don\'t apply' in wait


def test_missing_tools_stop_the_agent_instead_of_another_tripo_server():
    run = _flat(MAIN_SKILL.split("\n## How to Run\n", 1)[1].split("\n## ", 1)[0])
    assert "If `tool_search` finds no `mcp__tripo__` tool, stop" in run
    assert "`hermes gateway restart`" in run
    assert "Never enable, add or switch to another Tripo server" in run


def test_asking_tripo_for_an_image_is_in_scope():
    description = re.search(r"^description: (.+)$", MAIN_SKILL, re.M).group(1)
    when = _flat(MAIN_SKILL.split("\n## When to Use\n", 1)[1].split("\n## ", 1)[0])
    assert "an image made with Tripo" in description
    assert "asks Tripo for an image (`tripo_generate_image`)" in when
    assert "unless the user asks Tripo for one" in when


def test_capability_questions_are_answered_from_the_skill_not_the_web():
    when = _flat(MAIN_SKILL.split("\n## When to Use\n", 1)[1].split("\n## ", 1)[0])
    assert "The user asks what Tripo can do: answer with a short overview from this skill" in when
    assert "No web search and no loading of every tool schema for that" in when


def test_a_model_from_words_starts_with_a_concept_image():
    flat = _flat(MAIN_SKILL)
    assert "A model asked for in words only (no image, task id or model file) starts with a concept image" in flat
    assert "as the last choice, skipping the image for 3D straight from text" in flat
    assert "A skip pick runs `tripo_text_to_3d` with that model" in flat
    assert '"seedream_v4 · about 5 credits", "banana2 · about 10 credits", "banana_pro · about 15 credits"' in flat
    assert "Images get the same question unless the user names a model" in flat
    game = _flat(SKILL_DOCS["skills/tripo-game-asset/SKILL.md"])
    assert "starts with a concept image (tripo-3d, Procedure step 1)" in game


def test_the_clarify_pick_runs_the_call_without_a_second_question():
    step1 = _flat(MAIN_SKILL.split("\n1. **Plan, then confirm.**", 1)[1].split("\n2. **", 1)[0])
    assert '"Go ahead · about N credits"' in step1
    assert "make the billed call right away in the same turn and never ask again in text" in step1


def test_the_skills_read_the_settings_only_the_agent_acts_on():
    """No backend or Desktop code reads these: a key the skills never `hermes config get` would do nothing."""
    skills = _flat("\n".join(SKILL_DOCS.values()))
    unread = [key for key in ("default_model", "blender_handoff", "blender_path")
              if f"hermes config get plugins.entries.{MANIFEST['name']}.settings.{key}" not in skills]
    assert not unread, unread


def test_a_default_model_skips_the_model_question_not_the_price():
    models = _flat(MAIN_SKILL.split("\n## Models\n", 1)[1].split("\n## ", 1)[0])
    assert "without the model question" in models
    assert "the plan still names it and its credits for the user's yes" in models


def test_the_readme_lists_every_choice_of_a_setting():
    for key, spec in SCHEMA.items():
        if "choices" in spec:
            row = next((line for line in README.splitlines() if line.startswith("|") and f"(`{key}`)" in line), "")
            assert all(f"`{choice}`" in row for choice in spec["choices"]), (key, row)
