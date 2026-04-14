#!/usr/bin/env python3
"""
Claude Code ACP Agent - Bridge Claude Code to mobile via ACP WebSocket protocol.

Uses claude-agent-sdk (Python SDK) to expose Claude Code's full engineering
capabilities (file editing, bash execution, code search, etc.) over ACP
(WebSocket JSON-RPC 2.0) so the Flutter app can remotely control Claude Code.

Architecture:
    Flutter App <--WebSocket ACP--> claude_code_agent.py <--SDK/PTY--> Claude Code

Backends (in priority order):
  1. PTY  — spawns `claude` interactively with a real PTY; detects native
             permission prompts and proxies them to shepaw as ACP directives
             so the user can confirm/deny directly from the Flutter UI.
  2. SDK  — uses claude-agent-sdk's query() async iterator (non-interactive).
  3. CLI  — fallback: runs `claude -p … --output-format stream-json`.

Usage:
    python claude_code_agent.py --cwd /path/to/project --port 8090

    # With authentication:
    python claude_code_agent.py --cwd . --port 8090 --token my-secret

    # Force PTY backend (interactive permission prompts):
    python claude_code_agent.py --cwd . --port 8090 --backend pty

    # Specify model and permission mode:
    python claude_code_agent.py --cwd . --port 8090 \\
        --model claude-sonnet-4-20250514 --permission-mode default
"""

import asyncio
import json
import uuid
import argparse
import os
import re
import sys
from datetime import datetime
from dataclasses import dataclass, field
from typing import AsyncIterator, Dict, List, Optional

try:
    from aiohttp import web
    import aiohttp
except ImportError:
    print("Error: aiohttp is required. Install it with: pip install aiohttp")
    sys.exit(1)

# Add SDK to path if running from the claude_code/ directory
_sdk_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "shepaw_acp_sdk")
if os.path.isdir(_sdk_dir) and _sdk_dir not in sys.path:
    sys.path.insert(0, os.path.abspath(_sdk_dir))

try:
    from shepaw_acp_sdk import (
        jsonrpc_response,
        jsonrpc_notification,
        jsonrpc_request,
        ACPDirectiveStreamParser,
        ACPTextChunk,
        ACPDirective,
        acp_directive_to_notification,
    )
except ImportError as e:
    print(f"Error: shepaw_acp_sdk not found. Make sure it is installed or\n"
          f"located at ../shepaw_acp_sdk relative to this file.\n"
          f"Details: {e}")
    sys.exit(1)

# Interactive system prompt: instructs Claude Code to use <<<directive>>> blocks
# so the Flutter app can render rich UI components (buttons, forms, etc.).
ACP_INTERACTIVE_SYSTEM_PROMPT = """You can embed interactive UI directives inside your replies using the following syntax:

<<<directive
{"type": "<directive_type>", ...}
>>>

Supported directive types:
- confirm: ask user to confirm an action  (fields: prompt, actions)
- select:  present a list of choices       (fields: prompt, options)
- form:    collect structured user input   (fields: title, fields)
- file:    display / reference a file      (fields: filename, mime_type, url)

Only use directives when you genuinely need structured input from the user.
Outside of directive blocks, reply in normal Markdown."""


# ==================== Configuration ====================

@dataclass
class ClaudeCodeConfig:
    """Configuration for the Claude Code ACP Agent."""
    cwd: str = "."
    permission_mode: str = "default"  # default, acceptEdits, plan, bypassPermissions
    max_turns: Optional[int] = None
    allowed_tools: List[str] = field(default_factory=list)
    model: Optional[str] = None
    port: int = 8090
    token: str = ""
    agent_id: str = ""
    agent_name: str = "Claude Code Agent"
    system_prompt: str = ""
    interactive: bool = True
    max_history: int = 50
    cli_path: str = ""              # Custom CLI executable (e.g. "claude-internal")
    backend: str = "auto"           # "auto" | "pty" | "sdk" | "cli"
    # PTY classifier settings
    classifier: str = "auto"        # "auto" | "ollama" | "none"  (auto = try ollama, fallback regex)
    classifier_model: str = "qwen2.5:1.5b"
    classifier_url: str = "http://localhost:11434"


# ==================== PTY Screen Classifier ====================

# System prompt for the PTY output classifier (few-shot, JSON-only response)
_PTY_CLASSIFIER_SYSTEM = """\
你是一个终端输出分类器，专门识别 Claude Code CLI 的交互式权限提示。
输入是终端屏幕的当前文字内容（已去除 ANSI 转义码）。
判断当前屏幕是否停在一个等待用户操作的交互提示上，输出 JSON。

输出格式（只输出 JSON，不要任何解释）：
{
  "type": "output" | "confirm" | "select" | "input",
  "prompt": "<对用户的问题>",
  "context": "<操作背景，如命令内容、文件路径>",
  "actions": [{"label": "Yes", "value": "y"}, ...],   // type==confirm 时
  "options": [{"label": "选项文字", "value": "0"}, ...], // type==select 时
  "field_label": "<输入框提示>"                          // type==input 时
}

判断规则：
- 末尾出现 ❯/> 开头的菜单行（如 ❯ Yes / No / Always） → select 或 confirm
- 出现 (Y/n)、(y/N/always/skip) 等括号选项 → confirm
- 出现 "Enter …" / "Paste …" / 以冒号结尾的等待输入行 → input
- 以下情况判断为 output（正常内容，不需要交互）：
  * 助手正在输出回复文字
  * 工具执行中（Bash、Read、Write 等进度显示）
  * 错误信息已经打印完毕但不需要回应

示例 1 — confirm：
屏幕内容：
  ╭─ Bash command ─╮
  │ rm -rf /tmp/x  │
  ╰────────────────╯
  Do you want to proceed? (Y/n/always/skip) ›
输出：{"type":"confirm","prompt":"执行 Bash 命令: rm -rf /tmp/x","context":"rm -rf /tmp/x","actions":[{"label":"Yes","value":"y"},{"label":"No","value":"n"},{"label":"Always","value":"always"},{"label":"Skip","value":"skip"}]}

示例 2 — select：
屏幕内容：
  Edit file src/main.py?
  ❯ Yes
    No
    Always allow edits to src/main.py
输出：{"type":"select","prompt":"Edit file src/main.py?","context":"src/main.py","options":[{"label":"Yes","value":"0"},{"label":"No","value":"1"},{"label":"Always allow edits to src/main.py","value":"2"}]}

示例 3 — output：
屏幕内容：
  I'll help you refactor the authentication module. Let me start by reading the current implementation.
输出：{"type":"output","prompt":"","context":""}
"""


class PTYScreenClassifier:
    """
    用 pyte 虚拟终端 + 本地 Ollama 小模型对 PTY 屏幕内容分类。

    降级策略（按优先级）：
      1. Ollama 可用  → 小模型分类（语义理解，覆盖所有场景）
      2. Ollama 不可用 → 回退到 ClaudeCodePTYPromptParser regex（覆盖已知模式）
      3. 两者都失败   → 判定为 output，不打断用户
    """

    COLS = 220
    ROWS = 50

    def __init__(
        self,
        classifier: str = "auto",
        model: str = "qwen2.5:1.5b",
        base_url: str = "http://localhost:11434",
    ):
        self.classifier = classifier   # "auto" | "ollama" | "none"
        self.model = model
        self.base_url = base_url.rstrip("/")
        self._regex_parser = ClaudeCodePTYPromptParser()  # regex fallback

        # pyte virtual terminal
        try:
            import pyte
            self._screen = pyte.Screen(self.COLS, self.ROWS)
            self._stream = pyte.ByteStream(self._screen)
            self._pyte_ok = True
        except ImportError:
            self._pyte_ok = False

        # Track whether ollama is reachable (checked lazily once)
        self._ollama_ok: Optional[bool] = None  # None = not checked yet

    def feed(self, raw: bytes):
        """Feed raw PTY bytes into the virtual terminal."""
        if self._pyte_ok:
            self._stream.feed(raw)

    def screen_text(self) -> str:
        """Return the current logical screen content (trimmed, no empty lines)."""
        if not self._pyte_ok:
            return ""
        lines = []
        for line in self._screen.display:
            stripped = line.rstrip()
            if stripped:
                lines.append(stripped)
        return "\n".join(lines)

    def reset(self):
        """Reset the virtual terminal (call after each completed interaction)."""
        if self._pyte_ok:
            import pyte
            self._screen = pyte.Screen(self.COLS, self.ROWS)
            self._stream = pyte.ByteStream(self._screen)

    # Hard-evidence patterns: these MUST be present for a non-output classification
    # to be trusted.  Without them the LLM is hallucinating a prompt.
    _CONFIRM_EVIDENCE = re.compile(
        r"\(Y/n|Y/n/always|Do you want to proceed|Allow .+\?\s*$|"
        r"Do you trust",
        re.IGNORECASE | re.MULTILINE,
    )
    _SELECT_EVIDENCE = re.compile(
        r"(?:^|\n)[\s]*[❯>]\s+\S",   # at least one ❯/> menu item
        re.MULTILINE,
    )
    _INPUT_EVIDENCE = re.compile(
        r"(?:Enter|Paste|Type)\s+.{0,60}:?\s*$|:\s*$",
        re.IGNORECASE | re.MULTILINE,
    )

    def _verify_classification(self, result: dict, screen_text: str) -> dict:
        """
        Sanity-check a non-output classification against hard regex evidence.

        If the LLM says 'confirm'/'select'/'input' but the screen doesn't contain
        the expected interactive-prompt markers, downgrade to 'output'.
        This prevents false positives on normal assistant reply text.
        """
        t = result.get("type", "output")
        if t == "output":
            return result

        if t == "confirm":
            if self._CONFIRM_EVIDENCE.search(screen_text):
                return result
            print(f"[PTY Classifier] Downgrading '{t}' → 'output' (no confirm evidence)")
            return {"type": "output", "prompt": "", "context": ""}

        if t == "select":
            if self._SELECT_EVIDENCE.search(screen_text):
                return result
            print(f"[PTY Classifier] Downgrading '{t}' → 'output' (no ❯ menu evidence)")
            return {"type": "output", "prompt": "", "context": ""}

        if t == "input":
            if self._INPUT_EVIDENCE.search(screen_text):
                return result
            print(f"[PTY Classifier] Downgrading '{t}' → 'output' (no input prompt evidence)")
            return {"type": "output", "prompt": "", "context": ""}

        return result

    async def classify(self, screen_text: str) -> dict:
        """
        Classify the current screen content.

        Returns a dict with at minimum {"type": "output"|"confirm"|"select"|"input"}.
        Falls back to regex → output on any error.
        """
        if not screen_text.strip():
            return {"type": "output", "prompt": "", "context": ""}

        want_ollama = self.classifier in ("auto", "ollama")

        # ── Try Ollama ──
        if want_ollama:
            if self._ollama_ok is None:
                self._ollama_ok = await self._check_ollama()
                if self._ollama_ok:
                    print(f"[PTY Classifier] Ollama reachable, using {self.model}")
                else:
                    print("[PTY Classifier] Ollama not reachable, falling back to regex")

            if self._ollama_ok:
                try:
                    result = await self._classify_ollama(screen_text)
                    # Verify the LLM's claim against hard regex evidence
                    return self._verify_classification(result, screen_text)
                except Exception as e:
                    print(f"[PTY Classifier] Ollama error: {e}, falling back to regex")
                    self._ollama_ok = False  # stop trying this session

        # ── Regex fallback ──
        if self.classifier != "ollama":  # don't fall back if user forced ollama
            directive = self._regex_parser.parse(screen_text)
            if directive:
                return directive

        # ── Default: treat as normal output ──
        return {"type": "output", "prompt": "", "context": ""}

    async def _check_ollama(self) -> bool:
        """Quick health check: is Ollama running and does the model exist?"""
        try:
            import aiohttp
            async with aiohttp.ClientSession() as sess:
                async with sess.get(
                    f"{self.base_url}/api/tags",
                    timeout=aiohttp.ClientTimeout(total=3),
                ) as resp:
                    if resp.status != 200:
                        return False
                    data = await resp.json()
                    names = [m["name"] for m in data.get("models", [])]
                    # Accept exact match or "name:tag" prefix match
                    return any(
                        n == self.model or n.startswith(self.model.split(":")[0])
                        for n in names
                    )
        except Exception:
            return False

    async def _classify_ollama(self, text: str) -> dict:
        """Call Ollama chat API and parse JSON response."""
        import aiohttp
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": _PTY_CLASSIFIER_SYSTEM},
                {"role": "user", "content": f"当前终端屏幕内容：\n\n{text}"},
            ],
            "stream": False,
            "format": "json",
            "options": {
                "temperature": 0.0,   # deterministic
                "num_predict": 512,
            },
        }
        async with aiohttp.ClientSession() as sess:
            async with sess.post(
                f"{self.base_url}/api/chat",
                json=payload,
                timeout=aiohttp.ClientTimeout(total=15),
            ) as resp:
                resp.raise_for_status()
                data = await resp.json()
                content = data["message"]["content"].strip()
                # Strip markdown code fences if model wraps output
                if content.startswith("```"):
                    content = re.sub(r"^```[a-z]*\n?", "", content)
                    content = re.sub(r"\n?```$", "", content)
                result = json.loads(content)
                # Ensure required field
                if "type" not in result:
                    result["type"] = "output"
                return result


# ==================== PTY Backend ====================

# ANSI escape sequence stripper
# Covers:
#   CSI sequences: \x1b[ ... final-byte
#   OSC sequences: \x1b] ... \x07  or  \x1b] ... \x1b\
#   Other 2-byte ESC sequences: \x1b[@-Z\-_]
#   Bare BEL, backspace (leftover control chars)
_ANSI_ESCAPE = re.compile(
    r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)"   # OSC … BEL or OSC … ST
    r"|\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])"  # CSI / other ESC
    r"|[\x07\x08\x0e\x0f\x1b]"             # BEL, BS, SO, SI, stray ESC
)

def _strip_ansi(text: str) -> str:
    return _ANSI_ESCAPE.sub("", text)


# ── Claude Code TUI chrome patterns ──────────────────────────────────────────
# Box drawing: top/bottom borders start with ╭ ╰ ╔ ╚ ┌ └ etc.
_BOX_BORDER_RE = re.compile(r"^[\s]*[╭╰╔╚┌└╮╯╗╝┐┘]")
# Box side lines: │ or ┆ or ╎ content  (Unicode box-drawing verticals)
# Includes ┆ (light triple dash vertical) used by claude-internal welcome dialog
_BOX_SIDE_RE   = re.compile(r"^[\s]*[│┆╎┊┋]")
# Pure separator lines: ─────  ━━━  ═══  (3+ repetitions of TUI line chars)
_SEPARATOR_RE  = re.compile(r"^[\s]*[─━═╌┄╍]{3,}[\s]*$")
# Status indicator lines: ✓ Done, ⏺ Reading, ◆ Task, ▶ Running, ◐ effort, spinner chars
_STATUS_ICON_RE = re.compile(
    r"^[\s]*[✓✗⏺◆▶⊿◇◐◑◒◓●○►✔✘⊙⊗⊘⊛⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s"
)
# Claude Code startup banner header (e.g. "Claude Code v1.2.3")
_BANNER_RE = re.compile(r"^[\s]*Claude\s+Code\b", re.IGNORECASE)
# Prompt tail: lines ending in › or ❯ (interactive prompt cursor)
_PROMPT_TAIL_RE = re.compile(r"[›❯]\s*$")
# Interactive menu leader lines: ❯ option text  (❯ at start of line)
_MENU_LEADER_RE = re.compile(r"^[\s]*[❯›]\s+\S")
# End-of-turn footer: "◐ low · /effort"  or  "◐ medium · /effort"  etc.
# Claude Code emits this status line exactly once after finishing a reply.
_TURN_END_RE = re.compile(r"[◐◑◒◓]\s+(low|medium|high)\s+·\s+/effort", re.IGNORECASE)


def _clean_claude_output(text: str) -> str:
    """
    Remove Claude Code TUI chrome from pyte-rendered screen text.

    Strips:
    - Box drawing borders  (╭─╮, │ … │, ╰─╯)
    - Status indicator lines  (✓ Done, ⏺ Reading, ◆ Complete, spinner)
    - Pure separator lines  (─────────────)
    - Claude Code startup banner

    Keeps the assistant's prose text and any content that doesn't match
    the above patterns.
    """
    lines = text.splitlines()
    result: List[str] = []
    prev_blank = False
    in_menu = False  # True while we're inside a ❯ menu block

    for line in lines:
        stripped = line.strip()

        # Empty line — pass through, but deduplicate consecutive blanks
        # Also reset menu state on blank line
        if not stripped:
            in_menu = False
            if not prev_blank:
                result.append("")
                prev_blank = True
            continue
        prev_blank = False

        # Box border lines: ╭───╮  ╰───╯
        if _BOX_BORDER_RE.match(line):
            continue

        # Box side lines: │ content │
        if _BOX_SIDE_RE.match(line):
            continue

        # Pure separator lines: ─────────────
        if _SEPARATOR_RE.match(stripped):
            continue

        # Status indicator lines: ✓ Done, ⏺ Reading, ◆ Task complete, ◐ effort, spinner
        if _STATUS_ICON_RE.match(line):
            continue

        # Claude Code startup banner header
        if _BANNER_RE.match(stripped):
            continue

        # Interactive prompt tails (lines ending in › or ❯)
        if _PROMPT_TAIL_RE.search(stripped):
            continue

        # Interactive menu leader lines (❯ Yes  /  › Accept etc.)
        if _MENU_LEADER_RE.match(line):
            in_menu = True
            continue

        # Indented menu option lines following a ❯ leader (e.g. "  No, cancel")
        if in_menu and line.startswith("  ") and len(stripped) < 60 and "\n" not in stripped:
            continue

        in_menu = False
        result.append(line)

    # Strip leading/trailing blank lines
    while result and not result[0].strip():
        result.pop(0)
    while result and not result[-1].strip():
        result.pop()

    return "\n".join(result)


class ClaudeCodePTYPromptParser:
    """
    Detect Claude Code's native interactive permission prompts from raw PTY output.

    Claude Code renders prompts like:
      ╭─ Bash command ────────────────────────────────────────────────────╮
      │ ls -la                                                            │
      ╰───────────────────────────────────────────────────────────────────╯
      Do you want to proceed? (Y/n/always/skip) ›

    Or file-edit prompts:
      Edit file /path/to/file.py?
      ❯ Yes
        No
        Always allow edits

    We detect these via regex patterns on the stripped text and convert them
    to ACP confirm / select directives.
    """

    # Patterns: (name, regex, directive_builder)
    # Each pattern is tried in order on the *accumulated* prompt buffer.

    # "Do you want to proceed? (Y/n/always/skip) ›" style
    _CONFIRM_YNAS = re.compile(
        r"Do you want to proceed\?\s*\(Y/n(?:/always)?(?:/skip)?\)\s*[›>]?\s*$",
        re.IGNORECASE | re.MULTILINE,
    )

    # Generic "Allow <something>? (Y/n...)" style
    _ALLOW_YN = re.compile(
        r"(Allow[^\n?]*?\?)\s*\(([YynN/a-z]+)\)\s*[›>]?\s*$",
        re.IGNORECASE | re.MULTILINE,
    )

    # Arrow-key menu style: lines starting with "❯" or ">" mark the focused item
    # Followed by lines with spaces (unfocused options)
    _ARROW_MENU = re.compile(
        r"((?:^[ \t]*[❯>]\s*.+\n?)+(?:^[ \t]+\S.*\n?)*)",
        re.MULTILINE,
    )

    # Trust / continue prompt
    _TRUST_PROMPT = re.compile(
        r"(Do you trust the files in this folder\?.*?)\n.*?(Yes|No|Always)",
        re.DOTALL | re.IGNORECASE,
    )

    def parse(self, raw: str) -> Optional[dict]:
        """
        Attempt to parse a permission prompt from `raw` PTY text.

        Returns an ACP directive payload dict, or None if no prompt detected.
        """
        text = _strip_ansi(raw).strip()

        # ── "Do you want to proceed? (Y/n/always/skip)" ──
        if self._CONFIRM_YNAS.search(text):
            # Extract context: last box/paragraph before the question
            context = self._extract_context(text)
            return {
                "type": "confirm",
                "prompt": context or "Claude Code wants to proceed.",
                "actions": [
                    {"label": "Yes", "value": "y"},
                    {"label": "No", "value": "n"},
                    {"label": "Always", "value": "always"},
                    {"label": "Skip", "value": "skip"},
                ],
            }

        # ── "Allow <something>? (Y/n...)" ──
        m = self._ALLOW_YN.search(text)
        if m:
            question = m.group(1).strip()
            opts_raw = m.group(2)
            actions = self._parse_yn_opts(opts_raw)
            return {
                "type": "confirm",
                "prompt": question,
                "actions": actions,
            }

        # ── Arrow-key menu ──
        options = self._parse_arrow_menu(text)
        if options and len(options) >= 2:
            context = self._extract_context(text)
            return {
                "type": "select",
                "prompt": context or "Choose an option:",
                "options": [{"label": o, "value": str(i)} for i, o in enumerate(options)],
            }

        # ── Trust / folder prompt ──
        if self._TRUST_PROMPT.search(text):
            return {
                "type": "confirm",
                "prompt": "Do you trust the files in this folder?",
                "actions": [
                    {"label": "Yes, trust", "value": "y"},
                    {"label": "No", "value": "n"},
                ],
            }

        return None

    # ── Helpers ──

    def _extract_context(self, text: str) -> str:
        """Extract the last meaningful paragraph / box content as context."""
        # Try to grab text inside box characters (╭…╰)
        box = re.search(r"╭.+?╰[─┼╯╰]*", text, re.DOTALL)
        if box:
            inner = re.sub(r"[│╭╰─╯╮]", "", box.group())
            return inner.strip()[:300]

        # Fallback: last non-empty line before the prompt question
        lines = [l.strip() for l in text.splitlines() if l.strip()]
        if lines:
            # Skip the last line (which is the prompt itself)
            candidates = [l for l in lines[:-1] if not re.match(r"^[\(❯>]", l)]
            if candidates:
                return candidates[-1][:300]
        return ""

    @staticmethod
    def _parse_yn_opts(raw: str) -> List[dict]:
        """Parse option string like 'Y/n/always/skip' into action list."""
        mapping = {
            "y": ("Yes", "y"),
            "n": ("No", "n"),
            "a": ("Always", "always"),
            "always": ("Always", "always"),
            "s": ("Skip", "skip"),
            "skip": ("Skip", "skip"),
        }
        actions = []
        seen = set()
        for part in re.split(r"[/,|]", raw.lower()):
            part = part.strip()
            if part in mapping and part not in seen:
                label, value = mapping[part]
                actions.append({"label": label, "value": value})
                seen.add(part)
        if not actions:
            actions = [{"label": "Yes", "value": "y"}, {"label": "No", "value": "n"}]
        return actions

    @staticmethod
    def _parse_arrow_menu(text: str) -> List[str]:
        """Extract menu options from an arrow-key style selection list."""
        options = []
        for line in text.splitlines():
            stripped = line.strip()
            # Focused option
            m = re.match(r"^[❯>]\s+(.+)$", stripped)
            if m:
                options.append(m.group(1).strip())
                continue
            # Unfocused options often just start with spaces in the raw text
            # but after strip() look like plain text after the focused one
            if options and stripped and not re.match(r"^[╭╰│─╯╮]", stripped):
                # Avoid picking up box borders or question text
                if len(stripped) < 80 and not stripped.endswith("?"):
                    options.append(stripped)
        return options


# Input bytes Claude Code sends for each user response value
_PTY_RESPONSE_MAP: Dict[str, bytes] = {
    "y":      b"y\n",
    "yes":    b"y\n",
    "n":      b"n\n",
    "no":     b"n\n",
    "always": b"a\n",
    "skip":   b"s\n",
    # Arrow-menu: numbered index handled separately
    "0":      b"\n",         # Enter = select focused option
    "1":      b"\x1b[B\n",  # Down + Enter
    "2":      b"\x1b[B\x1b[B\n",
    "3":      b"\x1b[B\x1b[B\x1b[B\n",
}

def _value_to_pty_bytes(value: str) -> bytes:
    """Convert an ACP response value to PTY keystrokes for Claude Code."""
    v = value.lower().strip()
    if v in _PTY_RESPONSE_MAP:
        return _PTY_RESPONSE_MAP[v]
    # Numeric index for arrow menu
    try:
        idx = int(v)
        downs = b"\x1b[B" * idx
        return downs + b"\n"
    except ValueError:
        pass
    # Fallback: send the raw value as text + newline
    return (value + "\n").encode()


class ClaudeCodePTYBackend:
    """
    PTY-based backend: spawns `claude` with a real pseudo-terminal.

    This is the only backend that can handle Claude Code's native interactive
    permission prompts (e.g. "Allow bash?", "Edit file?", trust dialogs).

    Flow:
      1. Spawn `claude <args>` under a PTY.
      2. Read PTY output asynchronously into a rolling buffer.
      3. When a permission prompt is detected:
         a. Stop forwarding raw text as ui.textContent.
         b. Convert the prompt to an ACP confirm/select directive.
         c. Suspend the reader and await a Future resolved by the WebSocket handler.
         d. Write the user's response to the PTY master fd.
         e. Resume reading.
      4. Non-prompt text is forwarded as streaming ui.textContent.
      5. When the process exits, a result event is emitted.

    Interaction protocol (ACP JSON-RPC):
      Server → Client:  notification "ui.confirm" or "ui.select"
                        with  { task_id, prompt_id, ... }
      Client → Server:  request "agent.interact"
                        with  { task_id, prompt_id, value }
      Server → Client:  response to "agent.interact" (ack only)
    """

    # How long (seconds) of PTY silence to wait before classifying the screen
    _SILENCE_WINDOW = 0.20
    # How many bytes to buffer before flushing as text
    _TEXT_FLUSH_BYTES = 256
    # Maximum time (seconds) to wait for a user response to a prompt
    _INTERACTION_TIMEOUT = 300.0

    def __init__(self, config: ClaudeCodeConfig, classifier: Optional["PTYScreenClassifier"] = None):
        self.config = config
        self._sessions: Dict[str, str] = {}
        # Classifier: semantic (Ollama) with regex fallback, or regex-only, or none
        if classifier is None:
            # Build a default classifier based on config
            self._classifier = PTYScreenClassifier(
                classifier=config.classifier,
                model=config.classifier_model,
                base_url=config.classifier_url,
            )
        else:
            self._classifier = classifier

    @property
    def name(self) -> str:
        return "PTY"

    async def stream_response(
        self,
        prompt: str,
        session_id: str,
        system_prompt: str = "",
        *,
        interaction_handler=None,   # async callable(directive_payload) -> str value
    ) -> AsyncIterator[dict]:
        """
        Stream events from Claude Code running under a PTY.

        Extra keyword argument:
            interaction_handler: async function called when a native permission
                prompt is detected.  Receives the ACP directive dict and must
                return the user's chosen value string.  If None, prompts are
                auto-accepted ("y").

        Yields the same event dicts as ClaudeCodeSDKBackend.stream_response().
        """
        import pty
        import fcntl
        import termios
        import struct
        import shutil

        cli = self.config.cli_path or shutil.which("claude-internal") or "claude-internal"

        cmd = [cli]

        # Use --print mode: send one prompt and exit — avoids the interactive REPL
        # which never terminates on its own.  Permission prompts still appear even in
        # --print mode, so we can detect and handle them via PTY classification.
        cmd.append("--print")

        # Pass the user prompt as a positional argument (required by --print)
        cmd.append(prompt)

        if self.config.model:
            cmd.extend(["--model", self.config.model])

        if self.config.max_turns:
            cmd.extend(["--max-turns", str(self.config.max_turns)])

        if self.config.allowed_tools:
            cmd.extend(["--allowedTools", ",".join(self.config.allowed_tools)])

        # permission_mode → CLI flag
        pm = self.config.permission_mode
        if pm == "bypassPermissions":
            cmd.append("--dangerously-skip-permissions")
        elif pm == "plan":
            cmd.extend(["--permission-mode", "plan"])
        # "default" and "acceptEdits" need no extra flag

        if system_prompt:
            cmd.extend(["--system-prompt", system_prompt])

        # Resume previous session
        sdk_session_id = self._sessions.get(session_id)
        if sdk_session_id:
            cmd.extend(["--resume", sdk_session_id])

        # ── Spawn under PTY ──
        master_fd, slave_fd = pty.openpty()

        # Match terminal size to pyte's virtual screen so line-wrapping is consistent
        _COLS = PTYScreenClassifier.COLS
        _ROWS = PTYScreenClassifier.ROWS
        winsize = struct.pack("HHHH", _ROWS, _COLS, 0, 0)
        fcntl.ioctl(slave_fd, termios.TIOCSWINSZ, winsize)

        # Build a clean environment (strip sensitive provider keys)
        run_env = _make_clean_env()

        print(f"[PTY] Spawning: {' '.join(cmd)}")
        print(f"[PTY] cwd={self.config.cwd}  pid=?")

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            cwd=self.config.cwd,
            env=run_env,
            close_fds=True,
        )
        os.close(slave_fd)  # parent doesn't need slave end
        print(f"[PTY] Process started, pid={proc.pid}")

        loop = asyncio.get_event_loop()

        # ── Background thread reads PTY fd (loop.add_reader is unreliable on macOS kqueue) ──
        pty_queue: asyncio.Queue = asyncio.Queue()
        _total_bytes = 0

        def _pty_reader_thread():
            nonlocal _total_bytes
            import threading
            threading.current_thread().name = f"pty-reader-{proc.pid}"
            print(f"[PTY] Reader thread started")
            try:
                while True:
                    try:
                        data = os.read(master_fd, 4096)
                    except OSError as e:
                        print(f"[PTY] fd OSError in thread: {e} (total={_total_bytes}B)")
                        break
                    if not data:
                        print(f"[PTY] fd EOF (total={_total_bytes}B)")
                        break
                    _total_bytes += len(data)
                    # Thread-safe: schedule queue.put on the event loop
                    loop.call_soon_threadsafe(pty_queue.put_nowait, data)
            finally:
                print(f"[PTY] Reader thread exiting (total={_total_bytes}B)")
                loop.call_soon_threadsafe(pty_queue.put_nowait, None)  # sentinel

        import threading
        _reader_thread = threading.Thread(target=_pty_reader_thread, daemon=True)
        _reader_thread.start()
        print(f"[PTY] Reader thread launched for fd={master_fd}")

        # Reset the classifier's virtual terminal for a fresh session
        self._classifier.reset()

        _prompt_sent = False
        _cycle = 0
        _pty_done = False   # set True when sentinel None received from thread
        _last_sent_content = ""   # dedup: don't re-send same screen twice
        _idle_cycles = 0    # consecutive silence-window cycles with no new bytes
        _MAX_IDLE_CYCLES = 30  # 30 × 0.2s = 6s idle after process exit → break

        text_buf = ""   # raw bytes (with ANSI) accumulated for flushing as text

        try:
            while True:
                _cycle += 1
                # ── Read bytes until silence window expires ──
                got_any = False
                chunk_count = 0
                while True:
                    try:
                        raw_bytes = await asyncio.wait_for(
                            pty_queue.get(), timeout=self._SILENCE_WINDOW
                        )
                        if raw_bytes is None:   # sentinel: reader thread exited
                            print(f"[PTY] Sentinel received, PTY done")
                            _pty_done = True
                            break
                        got_any = True
                        chunk_count += 1
                        self._classifier.feed(raw_bytes)
                        text_buf += raw_bytes.decode("utf-8", errors="replace")
                    except asyncio.TimeoutError:
                        # No new bytes for _SILENCE_WINDOW — screen is stable
                        break

                if got_any:
                    _idle_cycles = 0
                else:
                    _idle_cycles += 1

                if _pty_done:
                    # Emit the full cleaned output accumulated in text_buf
                    if text_buf:
                        cleaned = _clean_claude_output(_strip_ansi(text_buf))
                        if cleaned and cleaned.strip():
                            yield {"type": "text", "content": cleaned}
                    text_buf = ""
                    print(f"[PTY] PTY done, breaking main loop")
                    break

                # ── After first stable screen, discard startup banner ──
                # With --print mode the prompt is already a CLI argument, so there
                # is nothing to inject.  We just wait for the startup banner to
                # settle, discard it, reset the classifier, and let the response
                # stream in naturally.  The process will exit when done.
                if not _prompt_sent:
                    _idle_cycles = 0  # don't count startup wait as idle
                    _prompt_sent = True
                    startup_text = _strip_ansi(text_buf)
                    print(f"[PTY] Startup screen ({len(text_buf)}B):\n"
                          f"{'─'*40}\n{startup_text[:500]}\n{'─'*40}")
                    # Discard startup banner — don't yield it to the user
                    text_buf = ""
                    self._classifier.reset()
                    continue

                # ── Check if process exited without us seeing the sentinel ──
                # (Happens when PTY fd closes after a long idle period)
                if _idle_cycles >= _MAX_IDLE_CYCLES and proc.returncode is not None:
                    print(f"[PTY] Process exited (rc={proc.returncode}) and {_idle_cycles} "
                          f"idle cycles — treating as done")
                    _pty_done = True
                    if text_buf:
                        cleaned = _clean_claude_output(_strip_ansi(text_buf))
                        if cleaned and cleaned.strip():
                            yield {"type": "text", "content": cleaned}
                    text_buf = ""
                    break

                # ── Classify the current (stable) screen ──
                # Only classify when new bytes arrived — skip idle cycles to avoid
                # burning Ollama API calls while Claude is thinking.
                if not got_any:
                    continue

                screen = self._classifier.screen_text()
                print(f"[PTY] Classifying screen ({len(screen)} chars):\n"
                      f"{'─'*40}\n{screen[:400]}\n{'─'*40}")
                directive = await self._classifier.classify(screen)
                print(f"[PTY] Classification result: {directive}")

                if directive.get("type") != "output":
                    # ── Interactive prompt detected ──
                    # Yield any clean text accumulated before the prompt
                    if text_buf:
                        preceding = _clean_claude_output(_strip_ansi(text_buf))
                        preceding = _strip_prompt_tail(preceding)
                        if preceding.strip() and preceding != _last_sent_content:
                            yield {"type": "text", "content": preceding}
                            _last_sent_content = preceding
                    text_buf = ""

                    if interaction_handler is not None:
                        print(f"[PTY] Waiting for user response (type={directive['type']})...")
                        try:
                            user_value = await asyncio.wait_for(
                                interaction_handler(directive),
                                timeout=self._INTERACTION_TIMEOUT,
                            )
                        except asyncio.TimeoutError:
                            print(f"[PTY] Interaction timeout, defaulting to 'n'")
                            user_value = "n"
                    else:
                        user_value = "y"

                    print(f"[PTY] Writing response: {user_value!r}")
                    response_bytes = _value_to_pty_bytes(user_value)
                    try:
                        os.write(master_fd, response_bytes)
                    except OSError as e:
                        print(f"[PTY] Failed to write response: {e}")
                        break

                    self._classifier.reset()
                    yield {
                        "type": "interaction",
                        "directive": directive,
                        "response": user_value,
                    }
                    continue

                # ── Detect end-of-turn: Claude finished replying ──
                # Claude Code emits "◐ medium · /effort" exactly once at the end
                # of every assistant turn.  When we see it on a stable screen,
                # the reply is complete — emit accumulated text and send /exit.
                if _TURN_END_RE.search(screen):
                    print(f"[PTY] End-of-turn detected, emitting text and exiting")
                    if text_buf:
                        cleaned = _clean_claude_output(_strip_ansi(text_buf))
                        if cleaned and cleaned.strip() and cleaned != _last_sent_content:
                            yield {"type": "text", "content": cleaned}
                            _last_sent_content = cleaned
                    text_buf = ""
                    # Send /exit to close the interactive session gracefully
                    try:
                        os.write(master_fd, b"/exit\n")
                    except OSError:
                        pass
                    # Wait for PTY to close (sentinel will arrive shortly)
                    # Fall through to next iteration which will catch _pty_done

                # ── Otherwise wait for more output ──
                # text_buf accumulates all raw bytes; we'll emit on turn-end, interact,
                # or process exit.  No intermediate snapshots to avoid pyte screen noise.

        finally:
            print(f"[PTY] Loop exited. Cleaning up fd={master_fd}")
            try:
                os.close(master_fd)
            except OSError:
                pass
            # Reader thread will exit on next os.read() raising OSError (fd closed)

        # Wait for process exit
        try:
            await asyncio.wait_for(proc.wait(), timeout=10.0)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()

        # Flush any remaining text
        if text_buf:
            cleaned = _clean_claude_output(_strip_ansi(text_buf))
            if cleaned and cleaned.strip():
                yield {"type": "text", "content": cleaned}

        # Emit a result event
        exit_code = proc.returncode or 0
        yield {
            "type": "result",
            "subtype": "success" if exit_code == 0 else "error",
            "cost": None,
            "turns": 0,
            "duration_ms": 0,
            "session_id": self._sessions.get(session_id, ""),
            "result_text": None,
            "exit_code": exit_code,
        }


def _strip_prompt_tail(text: str) -> str:
    """Remove the last few lines if they look like a permission prompt."""
    lines = text.splitlines()
    # Drop trailing lines that contain known prompt markers
    while lines:
        last = lines[-1].strip()
        if re.search(r"[❯>]\s+\w|Do you want|Allow .+\?|\(Y/n", last, re.IGNORECASE):
            lines.pop()
        else:
            break
    return "\n".join(lines)


# Environment vars that should NOT be passed to Claude Code subprocesses
_BLOCKED_ENV_VARS = frozenset({
    # Anthropic / Claude
    "ANTHROPIC_API_KEY", "ANTHROPIC_TOKEN", "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    # OpenAI / OpenRouter
    "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE",
    "OPENAI_ORG_ID", "OPENAI_ORGANIZATION", "OPENROUTER_API_KEY",
    # Other LLMs
    "GOOGLE_API_KEY", "DEEPSEEK_API_KEY", "MISTRAL_API_KEY",
    "GROQ_API_KEY", "TOGETHER_API_KEY", "PERPLEXITY_API_KEY",
    "COHERE_API_KEY", "FIREWORKS_API_KEY", "XAI_API_KEY",
    # Gateways / services
    "HELICONE_API_KEY", "PARALLEL_API_KEY", "FIRECRAWL_API_KEY",
    "FIRECRAWL_API_URL",
    # Messaging / channels
    "TELEGRAM_HOME_CHANNEL", "TELEGRAM_HOME_CHANNEL_NAME",
    "DISCORD_HOME_CHANNEL", "DISCORD_HOME_CHANNEL_NAME",
    "DISCORD_REQUIRE_MENTION", "DISCORD_FREE_RESPONSE_CHANNELS",
    "DISCORD_AUTO_THREAD",
    "SLACK_HOME_CHANNEL", "SLACK_HOME_CHANNEL_NAME", "SLACK_ALLOWED_USERS",
    "WHATSAPP_ENABLED", "WHATSAPP_MODE", "WHATSAPP_ALLOWED_USERS",
    "SIGNAL_HTTP_URL", "SIGNAL_ACCOUNT", "SIGNAL_ALLOWED_USERS",
    "SIGNAL_GROUP_ALLOWED_USERS", "SIGNAL_HOME_CHANNEL",
    "SIGNAL_HOME_CHANNEL_NAME", "SIGNAL_IGNORE_STORIES",
    # Home automation / email
    "HASS_TOKEN", "HASS_URL",
    "EMAIL_ADDRESS", "EMAIL_PASSWORD", "EMAIL_IMAP_HOST",
    "EMAIL_SMTP_HOST", "EMAIL_HOME_ADDRESS", "EMAIL_HOME_ADDRESS_NAME",
    # GitHub
    "GH_TOKEN", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY_PATH",
    "GITHUB_APP_INSTALLATION_ID",
    # Cloud / infra
    "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET",
    "DAYTONA_API_KEY",
    # Agent keys
    "AGENT_TOKEN",
})

_SANE_PATH = (
    "/opt/homebrew/bin:/opt/homebrew/sbin:"
    "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
)


def _make_clean_env() -> dict:
    """Return os.environ with sensitive keys stripped and a sane PATH."""
    env = {k: v for k, v in os.environ.items() if k not in _BLOCKED_ENV_VARS}
    existing_path = env.get("PATH", "")
    if "/usr/bin" not in existing_path.split(":"):
        env["PATH"] = f"{existing_path}:{_SANE_PATH}" if existing_path else _SANE_PATH
    # Ensure TERM is set so TUI tools render correctly
    env.setdefault("TERM", "xterm-256color")
    env.setdefault("COLORTERM", "truecolor")
    return env


# ==================== SDK Backend ====================

class ClaudeCodeSDKBackend:
    """Backend using claude-agent-sdk's query() async iterator."""

    def __init__(self, config: ClaudeCodeConfig):
        self.config = config
        self._sessions: Dict[str, str] = {}  # session_id -> sdk session_id

    @property
    def name(self) -> str:
        return "SDK"

    async def stream_response(
        self,
        prompt: str,
        session_id: str,
        system_prompt: str = "",
        **kwargs,
    ) -> AsyncIterator[dict]:
        """Stream Claude Code response as event dicts."""
        from claude_agent_sdk import (
            query,
            ClaudeAgentOptions,
            AssistantMessage,
            SystemMessage,
            ResultMessage,
            TextBlock,
            ToolUseBlock,
            ToolResultBlock,
        )

        options_kwargs = {
            "cwd": self.config.cwd,
            "permission_mode": self.config.permission_mode,
        }

        if self.config.model:
            options_kwargs["model"] = self.config.model

        if self.config.max_turns:
            options_kwargs["max_turns"] = self.config.max_turns

        if self.config.allowed_tools:
            options_kwargs["allowed_tools"] = self.config.allowed_tools

        if system_prompt:
            options_kwargs["system_prompt"] = system_prompt

        sdk_session_id = self._sessions.get(session_id)
        if sdk_session_id:
            options_kwargs["resume"] = sdk_session_id

        options = ClaudeAgentOptions(**options_kwargs)

        async for message in query(prompt=prompt, options=options):
            if isinstance(message, SystemMessage):
                if hasattr(message, "session_id"):
                    self._sessions[session_id] = message.session_id

            elif isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        yield {"type": "text", "content": block.text}
                    elif isinstance(block, ToolUseBlock):
                        yield {
                            "type": "tool_use",
                            "name": block.name,
                            "input": block.input,
                            "id": block.id,
                        }
                    elif isinstance(block, ToolResultBlock):
                        content = block.content
                        if isinstance(content, list):
                            content = "\n".join(
                                c.get("text", str(c))
                                for c in content
                                if isinstance(c, dict)
                            ) or str(content)
                        yield {
                            "type": "tool_result",
                            "tool_use_id": block.tool_use_id,
                            "content": str(content) if content else "",
                            "is_error": block.is_error or False,
                        }

            elif isinstance(message, ResultMessage):
                if hasattr(message, "session_id") and message.session_id:
                    self._sessions[session_id] = message.session_id
                yield {
                    "type": "result",
                    "subtype": getattr(message, "subtype", "success"),
                    "cost": getattr(message, "total_cost_usd", None),
                    "turns": getattr(message, "num_turns", 0),
                    "duration_ms": getattr(message, "duration_ms", 0),
                    "session_id": getattr(message, "session_id", ""),
                    "result_text": getattr(message, "result", None),
                }


# ==================== CLI Backend (Fallback) ====================

class ClaudeCodeCLIBackend:
    """Fallback backend using Claude Code CLI subprocess."""

    def __init__(self, config: ClaudeCodeConfig):
        self.config = config
        self._sessions: Dict[str, str] = {}

    @property
    def name(self) -> str:
        return "CLI"

    async def stream_response(
        self,
        prompt: str,
        session_id: str,
        system_prompt: str = "",
        **kwargs,
    ) -> AsyncIterator[dict]:
        """Stream Claude Code CLI response by parsing stdout JSON stream."""
        import shutil
        cli = self.config.cli_path or shutil.which("claude") or "claude"
        cmd = [cli, "-p", prompt, "--output-format", "stream-json"]

        if self.config.model:
            cmd.extend(["--model", self.config.model])

        if self.config.max_turns:
            cmd.extend(["--max-turns", str(self.config.max_turns)])

        if self.config.allowed_tools:
            cmd.extend(["--allowedTools", ",".join(self.config.allowed_tools)])

        if system_prompt:
            cmd.extend(["--system-prompt", system_prompt])

        sdk_session_id = self._sessions.get(session_id)
        if sdk_session_id:
            cmd.extend(["--resume", sdk_session_id])

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self.config.cwd,
            env=_make_clean_env(),
        )

        try:
            buffer = ""
            while True:
                chunk = await process.stdout.read(4096)
                if not chunk:
                    break
                buffer += chunk.decode("utf-8", errors="replace")

                while "\n" in buffer:
                    line, buffer = buffer.split("\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    event_type = event.get("type", "")

                    if event_type == "assistant":
                        for block in event.get("message", {}).get("content", []):
                            block_type = block.get("type", "")
                            if block_type == "text":
                                yield {"type": "text", "content": block.get("text", "")}
                            elif block_type == "tool_use":
                                yield {
                                    "type": "tool_use",
                                    "name": block.get("name", ""),
                                    "input": block.get("input", {}),
                                    "id": block.get("id", ""),
                                }
                            elif block_type == "tool_result":
                                yield {
                                    "type": "tool_result",
                                    "tool_use_id": block.get("tool_use_id", ""),
                                    "content": str(block.get("content", "")),
                                    "is_error": block.get("is_error", False),
                                }

                    elif event_type == "result":
                        sid = event.get("session_id", "")
                        if sid:
                            self._sessions[session_id] = sid
                        yield {
                            "type": "result",
                            "subtype": event.get("subtype", "success"),
                            "cost": event.get("total_cost_usd"),
                            "turns": event.get("num_turns", 0),
                            "duration_ms": event.get("duration_ms", 0),
                            "session_id": sid,
                            "result_text": event.get("result"),
                        }

            await process.wait()
        except Exception:
            process.kill()
            await process.wait()
            raise


# ==================== Provider (auto-detect backend) ====================

class ClaudeCodeProvider:
    """
    Selects the backend based on config.backend:
      "auto" → PTY (if OS supports it) → SDK → CLI
      "pty"  → PTY only
      "sdk"  → SDK only
      "cli"  → CLI only
    """

    def __init__(self, config: ClaudeCodeConfig):
        self.config = config
        self.backend = self._detect_backend()

    def _detect_backend(self):
        want = self.config.backend.lower()

        if want in ("pty", "auto"):
            # PTY requires Unix (pty module) and the `claude` CLI
            if self._pty_available():
                classifier = PTYScreenClassifier(
                    classifier=self.config.classifier,
                    model=self.config.classifier_model,
                    base_url=self.config.classifier_url,
                )
                backend = ClaudeCodePTYBackend(self.config, classifier=classifier)
                print(f"  Backend:   PTY (interactive, native permission prompts)")
                print(f"  Classifier:{self.config.classifier} "
                      f"(model: {self.config.classifier_model})")
                return backend
            elif want == "pty":
                raise RuntimeError(
                    "PTY backend requested but not available on this OS "
                    "or `claude` CLI not found."
                )

        if want in ("sdk", "auto"):
            try:
                import claude_agent_sdk  # noqa: F401
                backend = ClaudeCodeSDKBackend(self.config)
                print(f"  Backend:   SDK (claude-agent-sdk)")
                return backend
            except ImportError:
                if want == "sdk":
                    raise RuntimeError(
                        "SDK backend requested but claude-agent-sdk is not installed.\n"
                        "Install: pip install claude-agent-sdk"
                    )

        if want in ("cli", "auto"):
            import shutil
            cli_candidates = []
            if self.config.cli_path:
                cli_candidates.append(self.config.cli_path)
            cli_candidates.extend(["claude", "claude-internal"])

            for cli in cli_candidates:
                if shutil.which(cli):
                    if not self.config.cli_path:
                        self.config.cli_path = cli
                    backend = ClaudeCodeCLIBackend(self.config)
                    print(f"  Backend:   CLI ({cli})")
                    return backend

        raise RuntimeError(
            "No backend available. Options:\n"
            "  PTY:  requires Unix + `claude` CLI (`npm install -g @anthropic-ai/claude-code`)\n"
            "  SDK:  `pip install claude-agent-sdk`\n"
            "  CLI:  `npm install -g @anthropic-ai/claude-code`\n"
            "  Or specify --cli-path /path/to/claude"
        )

    @staticmethod
    def _pty_available() -> bool:
        """Check if PTY backend can be used on this system."""
        import shutil
        try:
            import pty  # noqa: F401 — Unix only
            return shutil.which("claude") is not None or shutil.which("claude-internal") is not None
        except ImportError:
            return False

    @property
    def backend_name(self) -> str:
        return self.backend.name

    def stream_response(
        self,
        prompt: str,
        session_id: str,
        system_prompt: str = "",
        **kwargs,
    ) -> AsyncIterator[dict]:
        return self.backend.stream_response(
            prompt, session_id, system_prompt, **kwargs
        )


# ==================== ACP Server for Claude Code ====================

class ACPClaudeCodeServer:
    """ACP WebSocket server that bridges Claude Code to the Flutter app."""

    def __init__(self, config: ClaudeCodeConfig, provider: ClaudeCodeProvider):
        self.config = config
        self.provider = provider
        self._active_tasks: Dict[str, asyncio.Task] = {}
        # task_id → { prompt_id → Future[str] }
        # Used by PTY backend to suspend and await user responses
        self._pending_interactions: Dict[str, Dict[str, asyncio.Future]] = {}
        # Per-connection ws reference (set during handle_websocket)
        self._ws: Optional[web.WebSocketResponse] = None

    async def handle_websocket(self, request: web.Request) -> web.WebSocketResponse:
        """Handle incoming WebSocket connection."""
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        self._ws = ws

        print(f"[ACP] New WebSocket connection from {request.remote}")

        # ── Token authentication ──
        # Accept token from (in priority order):
        #   1. HTTP header:  Authorization: Bearer <token>
        #   2. HTTP header:  X-Agent-Token: <token>
        #   3. URL query:    ?token=<token>
        #   4. No token configured → always authenticated
        required_token = self.config.token
        if not required_token:
            authenticated = True
            print(f"[ACP] No token configured, connection accepted")
        else:
            # Check Authorization header
            auth_header = request.headers.get("Authorization", "")
            if auth_header.startswith("Bearer "):
                client_token = auth_header[7:].strip()
            else:
                # Check X-Agent-Token header
                client_token = request.headers.get("X-Agent-Token", "").strip()
            # Check query param as last resort
            if not client_token:
                client_token = request.rel_url.query.get("token", "").strip()

            authenticated = (client_token == required_token)
            print(f"[ACP] Token auth: {'OK' if authenticated else 'FAILED'} "
                  f"(header={'Authorization' if auth_header else 'X-Agent-Token/query'})")

            if not authenticated:
                print(f"[ACP] Connection rejected: invalid token")
                await ws.close(code=4001, message=b"Unauthorized")
                return ws

        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    print(f"[ACP] Raw message: {msg.data[:300]}")
                    try:
                        data = json.loads(msg.data)
                    except json.JSONDecodeError:
                        await ws.send_json(jsonrpc_response(
                            None,
                            error={"code": -32700, "message": "Parse error"},
                        ))
                        continue

                    method = data.get("method")
                    msg_id = data.get("id")
                    params = data.get("params", {})

                    print(f"[ACP] method={method!r} id={msg_id!r} authenticated={authenticated}")

                    if method == "auth.authenticate":
                        authenticated, response = self._handle_auth(msg_id, params)
                        await ws.send_json(response)
                    elif method == "ping":
                        await ws.send_json(jsonrpc_response(msg_id, result={"pong": True}))
                    elif not authenticated:
                        print(f"[ACP] Rejected (not authenticated): {method!r}")
                        if msg_id is not None:
                            await ws.send_json(jsonrpc_response(
                                msg_id,
                                error={"code": -32000, "message": "Not authenticated"},
                            ))
                    elif method == "agent.chat":
                        await self._handle_chat(ws, msg_id, params)
                    elif method == "agent.interact":
                        await self._handle_interact(ws, msg_id, params)
                    elif method == "agent.cancelTask":
                        await self._handle_cancel_task(ws, msg_id, params)
                    elif method == "agent.getCard":
                        await self._handle_get_card(ws, msg_id)
                    elif method is not None:
                        print(f"[ACP] Unknown method: {method!r}")
                        if msg_id is not None:
                            await ws.send_json(jsonrpc_response(
                                msg_id,
                                error={"code": -32601, "message": f"Method not found: {method}"},
                            ))
                    else:
                        print(f"[ACP] Notification / response (no method+id routing): {data}")

                elif msg.type == aiohttp.WSMsgType.ERROR:
                    print(f"[ACP] WebSocket error: {ws.exception()}")

        except Exception as e:
            print(f"[ACP] Connection error: {e}")
        finally:
            for task_id, task in self._active_tasks.items():
                task.cancel()
            self._active_tasks.clear()
            # Resolve any pending interaction futures with a default "n"
            for task_futures in self._pending_interactions.values():
                for fut in task_futures.values():
                    if not fut.done():
                        fut.set_result("n")
            self._pending_interactions.clear()
            self._ws = None
            print(f"[ACP] WebSocket connection closed")

        return ws

    def _handle_auth(self, msg_id, params: dict) -> tuple:
        """Handle auth.authenticate request."""
        token = params.get("token", "")

        if not self.config.token:
            return True, jsonrpc_response(msg_id, result={"status": "authenticated"})

        if token == self.config.token:
            print("[ACP] Authentication successful")
            return True, jsonrpc_response(msg_id, result={"status": "authenticated"})
        else:
            print("[ACP] Authentication failed")
            return False, jsonrpc_response(
                msg_id,
                error={"code": -32000, "message": "Authentication failed"},
            )

    async def _handle_interact(self, ws, msg_id, params: dict):
        """
        Handle agent.interact — user responded to a PTY permission prompt.

        Expected params:
            task_id:   the running task's ID
            prompt_id: the UUID sent with the original ui.confirm / ui.select
            value:     the user's chosen value (e.g. "y", "n", "always", "0")
        """
        task_id = params.get("task_id", "")
        prompt_id = params.get("prompt_id", "")
        value = params.get("value", "n")

        task_futures = self._pending_interactions.get(task_id, {})
        fut = task_futures.get(prompt_id)

        if fut and not fut.done():
            fut.set_result(value)
            await ws.send_json(jsonrpc_response(msg_id, result={"status": "ok"}))
            print(f"[PTY] task={task_id[:8]} prompt={prompt_id[:8]} → {value!r}")
        else:
            await ws.send_json(jsonrpc_response(
                msg_id,
                error={"code": -32003, "message": "No pending interaction for that task/prompt_id"},
            ))

    async def _handle_chat(self, ws, msg_id, params: dict):
        """Handle agent.chat - stream Claude Code response via notifications."""
        task_id = params.get("task_id", str(uuid.uuid4()))
        session_id = params.get("session_id", task_id)
        message = params.get("message", "")
        system_prompt_override = params.get("system_prompt")

        if not message:
            await ws.send_json(jsonrpc_response(
                msg_id,
                error={"code": -32602, "message": "Missing 'message' parameter"},
            ))
            return

        print(f"\n{'='*60}")
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Claude Code - Task {task_id}")
        print(f"  Backend: {self.provider.backend_name}")
        print(f"  Session: {session_id}")
        print(f"  Input:   {message[:120]}{'...' if len(message) > 120 else ''}")
        print(f"{'='*60}")

        # Acknowledge the request
        await ws.send_json(jsonrpc_response(msg_id, result={
            "task_id": task_id,
            "status": "accepted",
        }))

        # Send task.started
        await ws.send_json(jsonrpc_notification("task.started", {
            "task_id": task_id,
            "started_at": datetime.now().isoformat(),
        }))

        # Set up interaction tracking for PTY backend
        self._pending_interactions[task_id] = {}

        async def _interaction_handler(directive: dict) -> str:
            """
            Called by PTY backend when a native permission prompt is detected.
            Sends an ACP directive to the Flutter app and waits for a response.
            """
            prompt_id = str(uuid.uuid4())
            loop = asyncio.get_event_loop()
            fut: asyncio.Future = loop.create_future()
            self._pending_interactions[task_id][prompt_id] = fut

            # Send the directive to the Flutter app
            directive_type = directive.get("type", "confirm")
            notification_method = f"ui.{directive_type}"
            payload = {
                "task_id": task_id,
                "prompt_id": prompt_id,
                **directive,
            }
            await ws.send_json(jsonrpc_notification(notification_method, payload))
            print(f"[PTY] Sent {notification_method} prompt_id={prompt_id[:8]}")

            try:
                value = await asyncio.wait_for(
                    asyncio.shield(fut),
                    timeout=ClaudeCodePTYBackend._INTERACTION_TIMEOUT,
                )
            except asyncio.TimeoutError:
                print(f"[PTY] Interaction timeout for prompt_id={prompt_id[:8]}, defaulting to 'n'")
                value = "n"
            finally:
                self._pending_interactions.get(task_id, {}).pop(prompt_id, None)

            return value

        async def _stream_task():
            text_buffer = ""
            parser = ACPDirectiveStreamParser() if self.config.interactive else None

            # Choose interaction handler only for PTY backend
            is_pty = isinstance(self.provider.backend, ClaudeCodePTYBackend)
            ih = _interaction_handler if is_pty else None

            try:
                async for event in self.provider.stream_response(
                    prompt=message,
                    session_id=session_id,
                    system_prompt=(
                        system_prompt_override
                        if system_prompt_override is not None
                        else self.config.system_prompt
                    ),
                    interaction_handler=ih,
                ):
                    event_type = event.get("type", "")

                    if event_type == "text":
                        content = event.get("content", "")
                        text_buffer += content

                        if parser:
                            for evt in parser.feed(content):
                                if isinstance(evt, ACPTextChunk) and evt.content:
                                    await ws.send_json(jsonrpc_notification(
                                        "ui.textContent", {
                                            "task_id": task_id,
                                            "content": evt.content,
                                            "is_final": False,
                                        }
                                    ))
                                elif isinstance(evt, ACPDirective):
                                    notification = acp_directive_to_notification(evt, task_id)
                                    await ws.send_json(notification)
                        else:
                            await ws.send_json(jsonrpc_notification(
                                "ui.textContent", {
                                    "task_id": task_id,
                                    "content": content,
                                    "is_final": False,
                                }
                            ))

                    elif event_type == "interaction":
                        # PTY backend resolved a native prompt — log it
                        directive = event.get("directive", {})
                        response = event.get("response", "")
                        print(f"  [PTY] Prompt resolved: {directive.get('type')} → {response!r}")

                    elif event_type == "tool_use":
                        tool_name = event.get("name", "unknown")
                        tool_input = event.get("input", {})
                        input_summary = _summarize_tool_input(tool_name, tool_input)

                        await ws.send_json(jsonrpc_notification(
                            "ui.messageMetadata", {
                                "task_id": task_id,
                                "metadata": {
                                    "collapsible": True,
                                    "collapsible_title": f"Tool: {tool_name}",
                                    "auto_collapse": True,
                                },
                            }
                        ))
                        await ws.send_json(jsonrpc_notification(
                            "ui.textContent", {
                                "task_id": task_id,
                                "content": f"\n`{tool_name}`: {input_summary}\n",
                                "is_final": False,
                            }
                        ))

                    elif event_type == "tool_result":
                        tool_content = event.get("content", "")
                        is_error = event.get("is_error", False)
                        status = "Error" if is_error else "Done"

                        if tool_content:
                            display = tool_content[:500]
                            if len(tool_content) > 500:
                                display += f"\n... ({len(tool_content)} chars total)"

                            await ws.send_json(jsonrpc_notification(
                                "ui.messageMetadata", {
                                    "task_id": task_id,
                                    "metadata": {
                                        "collapsible": True,
                                        "collapsible_title": f"Result ({status})",
                                        "auto_collapse": True,
                                    },
                                }
                            ))
                            await ws.send_json(jsonrpc_notification(
                                "ui.textContent", {
                                    "task_id": task_id,
                                    "content": f"\n```\n{display}\n```\n",
                                    "is_final": False,
                                }
                            ))

                    elif event_type == "result":
                        cost = event.get("cost")
                        turns = event.get("turns", 0)
                        duration = event.get("duration_ms", 0)
                        result_text = event.get("result_text")

                        if result_text and not text_buffer:
                            if parser:
                                for evt in parser.feed(result_text):
                                    if isinstance(evt, ACPTextChunk) and evt.content:
                                        await ws.send_json(jsonrpc_notification(
                                            "ui.textContent", {
                                                "task_id": task_id,
                                                "content": evt.content,
                                                "is_final": False,
                                            }
                                        ))
                                    elif isinstance(evt, ACPDirective):
                                        notification = acp_directive_to_notification(evt, task_id)
                                        await ws.send_json(notification)

                        stats = []
                        if turns:
                            stats.append(f"turns={turns}")
                        if cost is not None:
                            stats.append(f"cost=${cost:.4f}")
                        if duration:
                            stats.append(f"duration={duration}ms")
                        if stats:
                            print(f"  Stats:   {', '.join(stats)}")

                # Flush parser
                if parser:
                    for evt in parser.flush():
                        if isinstance(evt, ACPTextChunk) and evt.content:
                            await ws.send_json(jsonrpc_notification(
                                "ui.textContent", {
                                    "task_id": task_id,
                                    "content": evt.content,
                                    "is_final": False,
                                }
                            ))
                        elif isinstance(evt, ACPDirective):
                            notification = acp_directive_to_notification(evt, task_id)
                            await ws.send_json(notification)

                # Final text marker
                await ws.send_json(jsonrpc_notification("ui.textContent", {
                    "task_id": task_id,
                    "content": "",
                    "is_final": True,
                }))

                # task.completed
                await ws.send_json(jsonrpc_notification("task.completed", {
                    "task_id": task_id,
                    "status": "success",
                    "completed_at": datetime.now().isoformat(),
                }))

                print(f"  Reply:   {text_buffer[:120]}{'...' if len(text_buffer) > 120 else ''}")
                print(f"  Length:  {len(text_buffer)} chars")

            except asyncio.CancelledError:
                print(f"  Task {task_id} cancelled")
                await ws.send_json(jsonrpc_notification("task.error", {
                    "task_id": task_id,
                    "message": "Task cancelled",
                    "code": -32008,
                }))
            except Exception as e:
                print(f"  Task {task_id} error: {e}")
                import traceback
                traceback.print_exc()
                await ws.send_json(jsonrpc_notification("task.error", {
                    "task_id": task_id,
                    "message": str(e),
                    "code": -32603,
                }))
            finally:
                self._active_tasks.pop(task_id, None)
                self._pending_interactions.pop(task_id, None)

        task = asyncio.create_task(_stream_task())
        self._active_tasks[task_id] = task

    async def _handle_cancel_task(self, ws, msg_id, params: dict):
        """Handle agent.cancelTask request."""
        task_id = params.get("task_id", "")
        task = self._active_tasks.get(task_id)

        if task and not task.done():
            task.cancel()
            await ws.send_json(jsonrpc_response(msg_id, result={
                "task_id": task_id,
                "status": "cancelled",
            }))
            print(f"[ACP] Task {task_id} cancel requested")
        else:
            await ws.send_json(jsonrpc_response(
                msg_id,
                error={"code": -32003, "message": f"Task not found: {task_id}"},
            ))

    async def _handle_get_card(self, ws, msg_id):
        """Handle agent.getCard request."""
        capabilities = ["chat", "streaming", "code_editing", "file_operations", "bash_execution"]
        if self.config.interactive:
            capabilities.append("interactive_messages")
        if self.provider.backend_name == "PTY":
            capabilities.append("native_permission_prompts")

        await ws.send_json(jsonrpc_response(msg_id, result={
            "agent_id": self.config.agent_id,
            "name": self.config.agent_name,
            "description": (
                f"Claude Code Agent ({self.provider.backend_name}) "
                f"— cwd: {self.config.cwd}"
            ),
            "version": "1.1.0",
            "capabilities": capabilities,
            "supported_protocols": ["acp"],
        }))


# ==================== Helpers ====================

def _summarize_tool_input(tool_name: str, tool_input: dict) -> str:
    """Create a concise summary of tool input for display."""
    if tool_name == "Read":
        return tool_input.get("file_path", "")
    elif tool_name == "Write":
        path = tool_input.get("file_path", "")
        content = tool_input.get("content", "")
        return f"{path} ({len(content)} chars)"
    elif tool_name == "Edit":
        path = tool_input.get("file_path", "")
        old = tool_input.get("old_string", "")
        return f"{path} (replacing {len(old)} chars)"
    elif tool_name == "Bash":
        cmd = tool_input.get("command", "")
        if len(cmd) > 100:
            cmd = cmd[:100] + "..."
        return cmd
    elif tool_name == "Glob":
        return tool_input.get("pattern", "")
    elif tool_name == "Grep":
        pattern = tool_input.get("pattern", "")
        path = tool_input.get("path", "")
        return f"/{pattern}/ in {path}" if path else f"/{pattern}/"
    elif tool_name == "WebSearch":
        return tool_input.get("query", "")
    elif tool_name == "WebFetch":
        return tool_input.get("url", "")
    elif tool_name == "Task":
        return tool_input.get("description", "")
    else:
        for k, v in tool_input.items():
            v_str = str(v)
            if len(v_str) > 80:
                v_str = v_str[:80] + "..."
            return f"{k}={v_str}"
        return ""


# ==================== App Factory ====================

def create_app(config: ClaudeCodeConfig, provider: ClaudeCodeProvider) -> web.Application:
    """Create the web application with ACP WebSocket route."""
    app = web.Application()
    app["config"] = config
    app["provider"] = provider
    server = ACPClaudeCodeServer(config, provider)
    app.router.add_get("/acp/ws", server.handle_websocket)
    return app


# ==================== CLI ====================

def parse_args():
    parser = argparse.ArgumentParser(
        description="Claude Code ACP Agent - Bridge Claude Code to mobile via WebSocket",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Auto-detect best backend (PTY if available, then SDK, then CLI)
  python claude_code_agent.py --cwd . --port 8090

  # Force PTY backend for interactive permission prompts
  python claude_code_agent.py --cwd /path/to/project --port 8090 --backend pty

  # With authentication and specific model
  python claude_code_agent.py --cwd /path/to/project \\
      --port 8090 --token my-secret --model claude-sonnet-4-20250514

  # With permission mode and tool restrictions
  python claude_code_agent.py --cwd . --port 8090 \\
      --permission-mode default \\
      --allowed-tools Read,Glob,Grep,Edit,Bash

  # Limit max turns
  python claude_code_agent.py --cwd . --port 8090 --max-turns 20

Flutter app: Add ACP agent at ws://<IP>:8090/acp/ws

ACP Interaction Protocol (PTY backend):
  Server → Client:  { "method": "ui.confirm", "params": { "task_id": "...",
                       "prompt_id": "...", "prompt": "Allow bash?",
                       "actions": [{"label": "Yes", "value": "y"}, ...] } }
  Client → Server:  { "id": 1, "method": "agent.interact",
                       "params": { "task_id": "...", "prompt_id": "...",
                                   "value": "y" } }
        """,
    )

    parser.add_argument(
        "--cwd", default=".",
        help="Working directory for Claude Code (default: current directory)",
    )
    parser.add_argument(
        "--port", type=int, default=int(os.getenv("AGENT_PORT", "8090")),
        help="Server port (default: 8090, or AGENT_PORT env var)",
    )
    parser.add_argument(
        "--token", default=os.getenv("AGENT_TOKEN", ""),
        help="Authentication token (default: AGENT_TOKEN env var)",
    )
    parser.add_argument(
        "--model", default=os.getenv("CLAUDE_MODEL", ""),
        help="Claude model to use (default: SDK/CLI default)",
    )
    parser.add_argument(
        "--permission-mode", default="default",
        choices=["default", "acceptEdits", "plan", "bypassPermissions"],
        help="Permission mode for Claude Code (default: default)",
    )
    parser.add_argument(
        "--max-turns", type=int, default=None,
        help="Maximum number of agentic turns (default: unlimited)",
    )
    parser.add_argument(
        "--allowed-tools", default="",
        help="Comma-separated list of allowed tools (default: all)",
    )
    parser.add_argument(
        "--name", default=os.getenv("AGENT_NAME", "Claude Code Agent"),
        help="Agent display name",
    )
    parser.add_argument(
        "--agent-id", default=os.getenv("AGENT_ID", ""),
        help="Agent ID (default: auto-generated)",
    )
    parser.add_argument(
        "--system-prompt", default="",
        help="Additional system prompt to prepend",
    )
    parser.add_argument(
        "--no-interactive", action="store_true", default=False,
        help="Disable interactive directive parsing",
    )
    parser.add_argument(
        "--cli-path", default=os.getenv("CLAUDE_CLI_PATH", ""),
        help="Path or name of the Claude Code CLI executable "
             "(default: auto-detect 'claude', or CLAUDE_CLI_PATH env var)",
    )
    parser.add_argument(
        "--backend", default=os.getenv("CLAUDE_BACKEND", "auto"),
        choices=["auto", "pty", "sdk", "cli"],
        help=(
            "Backend to use (default: auto):\n"
            "  auto — PTY → SDK → CLI (best available)\n"
            "  pty  — PTY only (interactive, proxies native permission prompts)\n"
            "  sdk  — claude-agent-sdk only\n"
            "  cli  — claude CLI (-p / stream-json) only"
        ),
    )

    # PTY classifier settings
    parser.add_argument(
        "--classifier", default=os.getenv("PTY_CLASSIFIER", "auto"),
        choices=["auto", "ollama", "none"],
        help=(
            "PTY screen classifier (default: auto):\n"
            "  auto   — try Ollama LLM first, fall back to regex if unavailable\n"
            "  ollama — use Ollama LLM only (error if Ollama not reachable)\n"
            "  none   — regex-only fallback, no LLM (fastest, lowest coverage)"
        ),
    )
    parser.add_argument(
        "--classifier-model", default=os.getenv("PTY_CLASSIFIER_MODEL", "qwen2.5:1.5b"),
        help="Ollama model name for PTY classification (default: qwen2.5:1.5b)",
    )
    parser.add_argument(
        "--classifier-url", default=os.getenv("PTY_CLASSIFIER_URL", "http://localhost:11434"),
        help="Ollama base URL (default: http://localhost:11434)",
    )

    return parser.parse_args()


def main():
    args = parse_args()

    cwd = os.path.abspath(args.cwd)
    if not os.path.isdir(cwd):
        print(f"Error: --cwd directory does not exist: {cwd}")
        sys.exit(1)

    interactive = not args.no_interactive

    system_prompt = args.system_prompt or ""
    if interactive:
        if system_prompt:
            system_prompt = system_prompt.rstrip() + "\n\n" + ACP_INTERACTIVE_SYSTEM_PROMPT
        else:
            system_prompt = ACP_INTERACTIVE_SYSTEM_PROMPT

    allowed_tools = [t.strip() for t in args.allowed_tools.split(",") if t.strip()] if args.allowed_tools else []

    config = ClaudeCodeConfig(
        cwd=cwd,
        permission_mode=args.permission_mode,
        max_turns=args.max_turns,
        allowed_tools=allowed_tools,
        model=args.model or None,
        port=args.port,
        token=args.token,
        agent_id=args.agent_id or f"claude_code_{uuid.uuid4().hex[:8]}",
        agent_name=args.name,
        system_prompt=system_prompt,
        interactive=interactive,
        cli_path=args.cli_path or "",
        backend=args.backend,
        classifier=args.classifier,
        classifier_model=args.classifier_model,
        classifier_url=args.classifier_url,
    )

    print("=" * 60)
    print("  Claude Code ACP Agent")
    print("=" * 60)
    print(f"  Agent ID:    {config.agent_id}")
    print(f"  Agent Name:  {config.agent_name}")
    print(f"  CWD:         {config.cwd}")
    print(f"  Model:       {config.model or '(default)'}")
    print(f"  Permission:  {config.permission_mode}")
    print(f"  Max Turns:   {config.max_turns or '(unlimited)'}")
    print(f"  Tools:       {', '.join(config.allowed_tools) if config.allowed_tools else '(all)'}")
    print(f"  Port:        {config.port}")
    print(f"  Auth:        {'Token required' if config.token else 'No auth'}")
    print(f"  Interactive: {'Enabled' if config.interactive else 'Disabled'}")
    print(f"  Backend pref:{config.backend}")
    print(f"  Classifier:  {config.classifier} (model: {config.classifier_model})")

    try:
        provider = ClaudeCodeProvider(config)
    except RuntimeError as e:
        print(f"\nError: {e}")
        sys.exit(1)

    print("-" * 60)
    print(f"  ACP WS:      ws://localhost:{config.port}/acp/ws")
    if config.token:
        print("-" * 60)
        print(f"  Token:       {config.token}")
    print("=" * 60)
    print(f"\nServer starting on port {config.port}... Press Ctrl+C to stop.\n")

    app = create_app(config, provider)
    web.run_app(app, host="0.0.0.0", port=config.port, print=None)


if __name__ == "__main__":
    main()
