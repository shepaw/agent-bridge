"""macOS-specific tools for paw_agent."""

import asyncio
import json
import os
from typing import Any, Dict, List, Optional

from .base_tools import _truncate_output, DEFAULT_TIMEOUT, RiskLevel, _HIGH_RISK_SHELL_PATTERNS


# ==================== macOS Tool Definitions ====================

MAC_PLATFORM_TOOL_DEFINITIONS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "app_open",
            "description": "Open an application on the user's Mac.",
            "parameters": {
                "type": "object",
                "properties": {
                    "app_name": {
                        "type": "string",
                        "description": "Name of the application to open (e.g., 'Safari', 'Terminal', 'Finder')",
                    },
                },
                "required": ["app_name"],
            },
        },
    },
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
            "name": "screenshot",
            "description": "Take a screenshot of the user's Mac screen.",
            "parameters": {
                "type": "object",
                "properties": {
                    "region": {
                        "type": "string",
                        "description": "Screen region: 'full' (default), 'window', or 'x,y,w,h' for custom rectangle",
                    },
                    "save_path": {
                        "type": "string",
                        "description": "Path to save the screenshot (default: temp file)",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "clipboard_read",
            "description": "Read the current contents of the clipboard.",
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
            "description": "Write text to the clipboard.",
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
            "name": "applescript_exec",
            "description": "Execute an AppleScript on the user's Mac. Useful for automating macOS applications and system features.",
            "parameters": {
                "type": "object",
                "properties": {
                    "script": {
                        "type": "string",
                        "description": "The AppleScript code to execute",
                    },
                },
                "required": ["script"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "system_info_mac",
            "description": "Get extended macOS-specific system information including battery and display details.",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "enum": ["battery", "displays", "cpu_detail", "memory_detail"],
                        "description": "Category of macOS-specific system info to retrieve",
                    },
                },
                "required": ["category"],
            },
        },
    },
]


# ==================== Risk Classification Additions ====================

_HIGH_RISK_APPLESCRIPT_PATTERNS = (
    "do shell script",
    "delete", "remove",
    "quit", "close",
    "set ", "put ",
    "make new",
    "keystroke", "key code",
    "click",
)


def classify_risk_mac(tool_name: str, arguments: Dict[str, Any]) -> Optional[RiskLevel]:
    """Classify risk for macOS-specific tools. Returns None if not a mac tool."""
    if tool_name == "app_open":
        return RiskLevel.LOW_RISK

    if tool_name == "url_open":
        return RiskLevel.LOW_RISK

    if tool_name == "screenshot":
        return RiskLevel.SAFE

    if tool_name == "clipboard_read":
        return RiskLevel.SAFE

    if tool_name == "clipboard_write":
        return RiskLevel.LOW_RISK

    if tool_name == "applescript_exec":
        return _classify_applescript_risk(arguments.get("script", ""))

    if tool_name == "system_info_mac":
        return RiskLevel.SAFE

    return None


def _classify_applescript_risk(script: str) -> RiskLevel:
    script_lower = script.lower()
    for pattern in _HIGH_RISK_APPLESCRIPT_PATTERNS:
        if pattern in script_lower:
            return RiskLevel.HIGH_RISK
    return RiskLevel.LOW_RISK


def get_risk_description_mac(tool_name: str, arguments: Dict[str, Any]) -> Optional[str]:
    """Human-readable description for mac-specific tools. Returns None if not mac tool."""
    if tool_name == "applescript_exec":
        script = arguments.get("script", "")
        preview = script[:100] + ("..." if len(script) > 100 else "")
        return f"Execute AppleScript: {preview}"
    return None


# ==================== Tool Execution ====================

async def exec_app_open(app_name: str) -> Dict[str, Any]:
    """Open an application."""
    try:
        process = await asyncio.create_subprocess_exec(
            "open", "-a", app_name,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=10)

        if process.returncode == 0:
            return {"success": True, "app": app_name, "message": f"Opened {app_name}"}
        else:
            return {"success": False, "error": stderr.decode("utf-8", errors="replace").strip()}
    except asyncio.TimeoutError:
        return {"success": False, "error": "Timed out opening application"}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def exec_url_open(url: str) -> Dict[str, Any]:
    """Open a URL in the default browser."""
    try:
        process = await asyncio.create_subprocess_exec(
            "open", url,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await asyncio.wait_for(process.communicate(), timeout=10)
        return {"success": True, "url": url, "message": f"Opened {url}"}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def exec_screenshot(region: str = "full", save_path: str = None) -> Dict[str, Any]:
    """Take a screenshot using screencapture."""
    import tempfile
    try:
        if save_path:
            output_path = os.path.realpath(os.path.expanduser(save_path))
        else:
            fd, output_path = tempfile.mkstemp(suffix=".png", prefix="screenshot_")
            os.close(fd)

        cmd = ["screencapture"]
        if region == "window":
            cmd.append("-w")
        elif region != "full" and "," in region:
            parts = region.split(",")
            if len(parts) == 4:
                cmd.extend(["-R", ",".join(parts)])
        cmd.append(output_path)

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await asyncio.wait_for(process.communicate(), timeout=10)

        if os.path.exists(output_path):
            size = os.path.getsize(output_path)
            return {
                "success": True,
                "path": output_path,
                "size": size,
                "message": f"Screenshot saved ({size} bytes)",
            }
        else:
            return {"success": False, "error": "Screenshot file not created"}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def exec_clipboard_read() -> Dict[str, Any]:
    """Read clipboard contents using pbpaste."""
    try:
        process = await asyncio.create_subprocess_exec(
            "pbpaste",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=5)
        content = stdout.decode("utf-8", errors="replace") if stdout else ""
        return {
            "success": True,
            "content": _truncate_output(content),
            "length": len(content),
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


async def exec_clipboard_write(text: str) -> Dict[str, Any]:
    """Write text to clipboard using pbcopy."""
    try:
        process = await asyncio.create_subprocess_exec(
            "pbcopy",
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        await asyncio.wait_for(
            process.communicate(input=text.encode("utf-8")),
            timeout=5,
        )
        return {"success": True, "length": len(text), "message": "Text copied to clipboard"}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def exec_applescript(script: str) -> Dict[str, Any]:
    """Execute an AppleScript."""
    try:
        process = await asyncio.create_subprocess_exec(
            "osascript", "-e", script,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30)
        stdout_str = _truncate_output(stdout.decode("utf-8", errors="replace")) if stdout else ""
        stderr_str = stderr.decode("utf-8", errors="replace").strip() if stderr else ""

        if process.returncode == 0:
            return {"success": True, "output": stdout_str}
        else:
            return {"success": False, "error": stderr_str, "output": stdout_str}
    except asyncio.TimeoutError:
        return {"success": False, "error": "AppleScript timed out"}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def exec_system_info_mac(category: str) -> Dict[str, Any]:
    """Get macOS-specific extended system info."""
    from .base_tools import _run_simple_command

    try:
        info: Dict[str, Any] = {"success": True, "category": category}

        if category == "battery":
            result = await _run_simple_command("pmset -g batt")
            if result:
                info["battery"] = result.strip()

        elif category == "displays":
            result = await _run_simple_command("system_profiler SPDisplaysDataType 2>/dev/null")
            if result:
                info["displays"] = _truncate_output(result.strip())

        elif category == "cpu_detail":
            result = await _run_simple_command("sysctl -n machdep.cpu.brand_string")
            if result:
                info["cpu_name"] = result.strip()
            result = await _run_simple_command("sysctl -n hw.ncpu")
            if result:
                info["cpu_cores"] = result.strip()
            result = await _run_simple_command("sysctl -n hw.activecpu")
            if result:
                info["active_cpus"] = result.strip()

        elif category == "memory_detail":
            result = await _run_simple_command("sysctl -n hw.memsize")
            if result:
                info["total_bytes"] = int(result.strip())
                info["total_gb"] = round(int(result.strip()) / (1024 ** 3), 2)
            result = await _run_simple_command("vm_stat")
            if result:
                info["vm_stat"] = result.strip()

        return info
    except Exception as e:
        return {"success": False, "error": str(e)}


# ==================== Tool Executors ====================

MAC_TOOL_EXECUTORS = {
    "app_open": lambda args: exec_app_open(app_name=args["app_name"]),
    "url_open": lambda args: exec_url_open(url=args["url"]),
    "screenshot": lambda args: exec_screenshot(
        region=args.get("region", "full"),
        save_path=args.get("save_path"),
    ),
    "clipboard_read": lambda args: exec_clipboard_read(),
    "clipboard_write": lambda args: exec_clipboard_write(text=args["text"]),
    "applescript_exec": lambda args: exec_applescript(script=args["script"]),
    "system_info_mac": lambda args: exec_system_info_mac(category=args["category"]),
}
