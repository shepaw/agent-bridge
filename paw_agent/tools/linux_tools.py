"""Linux-specific tools for paw_agent."""

import asyncio
import os
import tempfile
from typing import Any, Dict, List, Optional

from .base_tools import _truncate_output, RiskLevel


# ==================== Linux Tool Definitions ====================

LINUX_PLATFORM_TOOL_DEFINITIONS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "url_open",
            "description": "Open a URL in the user's default browser.",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The URL to open",
                    },
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "clipboard_read",
            "description": "Read the current contents of the clipboard (requires xclip or xsel).",
            "parameters": {
                "type": "object",
                "properties": {},
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "clipboard_write",
            "description": "Write text to the clipboard (requires xclip or xsel).",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Text to copy to the clipboard",
                    },
                },
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "screenshot",
            "description": "Take a screenshot (requires scrot, gnome-screenshot, or import).",
            "parameters": {
                "type": "object",
                "properties": {
                    "save_path": {
                        "type": "string",
                        "description": "Path to save the screenshot (default: temp file)",
                    },
                },
            },
        },
    },
]


# ==================== Risk Classification ====================

def classify_risk_linux(tool_name: str, arguments: Dict[str, Any]) -> Optional[RiskLevel]:
    """Classify risk for Linux-specific tools. Returns None if not a linux tool."""
    if tool_name == "url_open":
        return RiskLevel.LOW_RISK
    if tool_name == "clipboard_read":
        return RiskLevel.SAFE
    if tool_name == "clipboard_write":
        return RiskLevel.LOW_RISK
    if tool_name == "screenshot":
        return RiskLevel.SAFE
    return None


def get_risk_description_linux(tool_name: str, arguments: Dict[str, Any]) -> Optional[str]:
    return None


# ==================== Tool Execution ====================

async def exec_url_open(url: str) -> Dict[str, Any]:
    """Open a URL using xdg-open."""
    try:
        process = await asyncio.create_subprocess_exec(
            "xdg-open", url,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await asyncio.wait_for(process.communicate(), timeout=10)
        return {"success": True, "url": url, "message": f"Opened {url}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def exec_clipboard_read() -> Dict[str, Any]:
    """Read clipboard using xclip or xsel."""
    for cmd in (["xclip", "-selection", "clipboard", "-o"], ["xsel", "--clipboard", "--output"]):
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(process.communicate(), timeout=5)
            if process.returncode == 0:
                content = stdout.decode("utf-8", errors="replace") if stdout else ""
                return {
                    "success": True,
                    "content": _truncate_output(content),
                    "length": len(content),
                }
        except FileNotFoundError:
            continue
        except Exception as e:
            return {"success": False, "error": str(e)}
    return {"success": False, "error": "Neither xclip nor xsel is installed"}


async def exec_clipboard_write(text: str) -> Dict[str, Any]:
    """Write text to clipboard using xclip or xsel."""
    for cmd in (["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]):
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(
                process.communicate(input=text.encode("utf-8")),
                timeout=5,
            )
            if process.returncode == 0:
                return {"success": True, "length": len(text), "message": "Text copied to clipboard"}
        except FileNotFoundError:
            continue
        except Exception as e:
            return {"success": False, "error": str(e)}
    return {"success": False, "error": "Neither xclip nor xsel is installed"}


async def exec_screenshot(save_path: str = None) -> Dict[str, Any]:
    """Take a screenshot using scrot, gnome-screenshot, or import."""
    if save_path:
        output_path = os.path.realpath(os.path.expanduser(save_path))
    else:
        fd, output_path = tempfile.mkstemp(suffix=".png", prefix="screenshot_")
        os.close(fd)

    for cmd in (
        ["scrot", output_path],
        ["gnome-screenshot", "-f", output_path],
        ["import", "-window", "root", output_path],
    ):
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(process.communicate(), timeout=15)
            if os.path.exists(output_path):
                size = os.path.getsize(output_path)
                return {
                    "success": True,
                    "path": output_path,
                    "size": size,
                    "message": f"Screenshot saved ({size} bytes)",
                }
        except FileNotFoundError:
            continue
        except Exception as e:
            return {"success": False, "error": str(e)}

    return {"success": False, "error": "No screenshot tool found (install scrot, gnome-screenshot, or imagemagick)"}


# ==================== Tool Executors ====================

LINUX_TOOL_EXECUTORS = {
    "url_open": lambda args: exec_url_open(url=args["url"]),
    "clipboard_read": lambda args: exec_clipboard_read(),
    "clipboard_write": lambda args: exec_clipboard_write(text=args["text"]),
    "screenshot": lambda args: exec_screenshot(save_path=args.get("save_path")),
}
