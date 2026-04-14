#!/usr/bin/env python3
"""
Test script for claude_code_agent.py

Tests:
  1. Unit: _clean_claude_output — verify TUI chrome is stripped, prose kept
  2. Unit: _verify_classification — verify false-positive LLM results are downgraded
  3. Integration: live PTY run with a simple prompt; check output is clean prose
"""

import asyncio
import sys
import os
import textwrap
import re

# Make sure we can import the module
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from claude_code_agent import (
    _clean_claude_output,
    _strip_ansi,
    PTYScreenClassifier,
    ClaudeCodeConfig,
    ClaudeCodePTYBackend,
)

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

PASS = "\033[32m✓ PASS\033[0m"
FAIL = "\033[31m✗ FAIL\033[0m"
INFO = "\033[36mℹ\033[0m"

_failures = 0

def check(name: str, actual: str, *, contains=(), not_contains=()):
    global _failures
    ok = True
    reasons = []
    for s in contains:
        if s not in actual:
            ok = False
            reasons.append(f"  missing: {s!r}")
    for s in not_contains:
        if s in actual:
            ok = False
            reasons.append(f"  should NOT contain: {s!r}")
    if ok:
        print(f"{PASS}  {name}")
    else:
        _failures += 1
        print(f"{FAIL}  {name}")
        for r in reasons:
            print(r)
        print(f"  actual:\n{textwrap.indent(repr(actual), '    ')}")


# ─────────────────────────────────────────────────────────────────────────────
# 1. Unit tests: _clean_claude_output
# ─────────────────────────────────────────────────────────────────────────────

print("\n══════════════════════════════════════════")
print("  1. Unit tests: _clean_claude_output")
print("══════════════════════════════════════════\n")

# 1a: Tool-use box should be stripped entirely
check(
    "Tool box + status line stripped",
    _clean_claude_output(
        "╭─ Bash command ───────────────────────────────────╮\n"
        "│ ls -la /tmp                                       │\n"
        "╰───────────────────────────────────────────────────╯\n"
        "✓ Bash (ls -la /tmp)\n"
    ),
    not_contains=["╭", "╰", "│", "✓ Bash", "─────"],
)

# 1b: Pure prose must pass through untouched
check(
    "Prose text preserved",
    _clean_claude_output(
        "Here is the answer to your question.\n\n"
        "The file has been modified successfully. You can verify by running `git diff`.\n"
    ),
    contains=["Here is the answer", "modified successfully", "git diff"],
)

# 1c: Status lines mixed with prose
check(
    "Status lines stripped, prose + code block kept",
    _clean_claude_output(
        "I'll read the file first.\n\n"
        "⏺ Reading src/main.py\n"
        "✓ Read (1234 chars)\n\n"
        "The file contains a bug on line 42. Here's the fix:\n\n"
        "```python\ndef foo():\n    return 42\n```\n\n"
        "◆ Task complete\n"
    ),
    contains=["I'll read the file", "bug on line 42", "def foo():", "return 42"],
    not_contains=["⏺ Reading", "✓ Read", "◆ Task complete"],
)

# 1d: Separator lines stripped
check(
    "Separator lines stripped",
    _clean_claude_output(
        "Some text above.\n\n"
        "─────────────────────────────────────────────────────\n"
        "More text below.\n"
    ),
    contains=["Some text above", "More text below"],
    not_contains=["─────"],
)

# 1e: Startup banner stripped
check(
    "Startup banner stripped",
    _clean_claude_output(
        "Claude Code v2.1.92\n"
        "Tips for getting started\n"
        "Welcome back!\n\n"
        "> What can I help you with?\n"
    ),
    not_contains=["Claude Code v2"],
)

# 1f: ANSI codes stripped first, then TUI chrome removed, prose kept
check(
    "ANSI+TUI combo: chrome filtered, prose kept",
    _clean_claude_output(_strip_ansi(
        "\x1b[2m╭─ Bash ─╮\x1b[0m\n"
        "\x1b[2m│ echo hi\x1b[0m\n"
        "\x1b[2m╰────────╯\x1b[0m\n"
        "\x1b[32m✓\x1b[0m Done\n"
        "The command printed: hi\n"
    )),
    contains=["The command printed"],
    not_contains=["╭", "│", "╰", "✓"],
)

# 1g: Consecutive blank lines collapsed to single blank
out = _clean_claude_output("Line A\n\n\n\nLine B\n\n\n\nLine C\n")
check(
    "Consecutive blank lines collapsed to one",
    out,
    contains=["Line A", "Line B", "Line C"],
    not_contains=["\n\n\n"],
)

# 1h: Interactive prompt tail (❯ menu) stripped
check(
    "Interactive menu items stripped",
    _clean_claude_output(
        "Looking good! Here is what I found.\n\n"
        "❯ Yes, apply the changes\n"
        "  No, cancel\n"
    ),
    contains=["Looking good"],
    not_contains=["❯ Yes", "No, cancel"],
)

# 1i: Realistic Claude Code reply (what we actually get from the PTY)
realistic_pty = (
    "╭──────────────────────────────────────────────────────────────────╮\n"
    "│ 欢迎使用 Claude Code                                              │\n"
    "╰──────────────────────────────────────────────────────────────────╯\n"
    "\n"
    "你好！有什么我可以帮助你的吗？\n"
    "\n"
    "⏺ Thinking...\n"
    "✓ Done\n"
    "\n"
    "1+1 = 2。\n"
    "\n"
    "◐ medium · /effort\n"
)
out = _clean_claude_output(realistic_pty)
check(
    "Realistic PTY reply: clean prose extracted",
    out,
    contains=["你好", "1+1 = 2"],
    not_contains=["╭", "╰", "│", "✓ Done", "⏺ Thinking", "◐ medium"],
)


# ─────────────────────────────────────────────────────────────────────────────
# 2. Unit tests: _verify_classification
# ─────────────────────────────────────────────────────────────────────────────

print("\n══════════════════════════════════════════")
print("  2. Unit tests: _verify_classification")
print("══════════════════════════════════════════\n")

clf = PTYScreenClassifier(classifier="none")

def verify(result, screen):
    return clf._verify_classification(result, screen)

# 2a: Real select (has ❯) → kept
r = verify({"type": "select", "prompt": "Edit?", "options": []},
           "Edit file src/main.py?\n❯ Yes\n  No\n  Always allow\n")
assert r["type"] == "select", f"Expected select, got {r['type']}"
print(f"{PASS}  Real select screen (has ❯) → kept as 'select'")

# 2b: False-positive select (no ❯) → downgraded
r = verify({"type": "select", "prompt": "Choose:", "options": []},
           "你好\n\n◐ medium · /effort\n\nI can help you with that.\n")
assert r["type"] == "output", f"Expected output, got {r['type']}"
print(f"{PASS}  False select (no ❯ menu) → downgraded to 'output'")

# 2c: Real confirm (has Y/n) → kept
r = verify({"type": "confirm", "prompt": "Proceed?", "actions": []},
           "╭─ Bash command ─╮\n│ rm -rf /tmp/x  │\n╰────────────────╯\n"
           "Do you want to proceed? (Y/n/always/skip) ›\n")
assert r["type"] == "confirm", f"Expected confirm, got {r['type']}"
print(f"{PASS}  Real confirm screen (has Y/n) → kept as 'confirm'")

# 2d: False-positive confirm (no Y/n) → downgraded
r = verify({"type": "confirm", "prompt": "Sure?", "actions": []},
           "I've completed the task. The changes look good.\n\nHere's a summary.\n")
assert r["type"] == "output", f"Expected output, got {r['type']}"
print(f"{PASS}  False confirm (no Y/n marker) → downgraded to 'output'")

# 2e: 'output' always passes through
r = verify({"type": "output", "prompt": ""}, "anything goes here")
assert r["type"] == "output"
print(f"{PASS}  'output' type always passes through unchanged")


# ─────────────────────────────────────────────────────────────────────────────
# 3. Integration test: live PTY run
# ─────────────────────────────────────────────────────────────────────────────

print("\n══════════════════════════════════════════")
print("  3. Integration test: live PTY")
print("══════════════════════════════════════════\n")

async def run_integration():
    import shutil
    global _failures

    cli = shutil.which("claude-internal") or shutil.which("claude")
    if not cli:
        print(f"{INFO}  Skipping: no claude CLI found")
        return

    print(f"{INFO}  CLI: {cli}")
    print(f"{INFO}  Prompt: '用一句话回答：1+1=?'")
    print()

    config = ClaudeCodeConfig(
        cwd=os.path.expanduser("~"),
        backend="pty",
        classifier="auto",
    )
    classifier = PTYScreenClassifier(
        classifier=config.classifier,
        model=config.classifier_model,
        base_url=config.classifier_url,
    )
    backend = ClaudeCodePTYBackend(config, classifier=classifier)

    events = []
    text_parts = []

    try:
        async for event in backend.stream_response(
            prompt="用一句话回答：1+1=?",
            session_id="test-session",
        ):
            events.append(event)
            etype = event.get("type", "")
            if etype == "text":
                content = event.get("content", "")
                text_parts.append(content)
                print(f"  [text] {content!r}")
            elif etype == "result":
                print(f"  [result] exit_code={event.get('exit_code')}  subtype={event.get('subtype')}")
            elif etype == "interaction":
                d = event.get("directive", {})
                print(f"  [interaction] type={d.get('type')} → {event.get('response')!r}")
            else:
                print(f"  [{etype}]")
    except Exception as e:
        import traceback
        _failures += 1
        print(f"{FAIL}  Integration raised exception: {e}")
        traceback.print_exc()
        return

    full_text = "\n".join(text_parts)
    print(f"\n  ── Full text output ({len(full_text)} chars) ──")
    print(textwrap.indent(full_text or "(empty)", "  "))
    print(f"  ─────────────────────────────────────────\n")

    # ── Checks ──
    if not full_text.strip():
        _failures += 1
        print(f"{FAIL}  No text output received")
    else:
        print(f"{PASS}  Got text output ({len(full_text)} chars)")

    if "2" in full_text:
        print(f"{PASS}  Output contains expected answer '2'")
    else:
        _failures += 1
        print(f"{FAIL}  Output does not contain '2'")

    box_chars = [c for c in "╭╰╮╯│╔╚╗╝┌└┐┘" if c in full_text]
    if box_chars:
        _failures += 1
        print(f"{FAIL}  TUI box chars still present: {box_chars}")
    else:
        print(f"{PASS}  No TUI box chars in output")

    if "─────" in full_text or "━━━━" in full_text:
        _failures += 1
        print(f"{FAIL}  Separator lines still present")
    else:
        print(f"{PASS}  No separator lines in output")

    if re.search(r"^[✓✗⏺◆▶◐]\s", full_text, re.MULTILINE):
        _failures += 1
        print(f"{FAIL}  Status icon lines still present (✓ ⏺ ◆ etc.)")
    else:
        print(f"{PASS}  No status icon lines in output")

    result_events = [e for e in events if e.get("type") == "result"]
    if result_events:
        print(f"{PASS}  Got result event (exit_code={result_events[0].get('exit_code')})")
    else:
        _failures += 1
        print(f"{FAIL}  No result event received")


asyncio.run(run_integration())


# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────

print("\n══════════════════════════════════════════")
if _failures == 0:
    print(f"  \033[32mAll tests passed!\033[0m")
else:
    print(f"  \033[31m{_failures} test(s) FAILED\033[0m")
print("══════════════════════════════════════════\n")
sys.exit(0 if _failures == 0 else 1)
