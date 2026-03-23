"""Windows-specific tools for paw_agent."""

import asyncio
import os
import tempfile
from typing import Any, Dict, List, Optional

from .base_tools import _truncate_output, RiskLevel


# ==================== Windows Tool Definitions ====================

WINDOWS_PLATFORM_TOOL_DEFINITIONS: List[Dict[str, Any]] = [
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
            "name": "app_open",
            "description": "Open an application on Windows.",
            "parameters": {
                "type": "object",
                "properties": {
                    "app_name": {
                        "type": "string",
                        "description": "Name or path of the application to open",
                    },
                },
                "required": ["app_name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "clipboard_read",
            "description": "Read the current contents of the clipboard via PowerShell.",
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
            "description": "Write text to the clipboard via PowerShell.",
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
            "description": "Take a screenshot via PowerShell.",
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

def classify_risk_windows(tool_name: str, arguments: Dict[str, Any]) -> Optional[RiskLevel]:
    """Classify risk for Windows-specific tools. Returns None if not a windows tool."""
    if tool_name == "url_open":
        return RiskLevel.LOW_RISK
    if tool_name == "app_open":
        return RiskLevel.LOW_RISK
    if tool_name == "clipboard_read":
        return RiskLevel.SAFE
    if tool_name == "clipboard_write":
        return RiskLevel.LOW_RISK
    if tool_name == "screenshot":
        return RiskLevel.SAFE
    return None


def get_risk_description_windows(tool_name: str, arguments: Dict[str, Any]) -> Optional[str]:
    return None


# ==================== Tool Execution ====================

async def _run_powershell(script: str, timeout: int = 10) -> Dict[str, Any]:
    """Run a PowerShell command and return stdout."""
    try:
        process = await asyncio.create_subprocess_exec(
            "powershell", "-NoProfile", "-NonInteractive", "-Command", script,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
        stdout_str = stdout.decode("utf-8", errors="replace") if stdout else ""
        stderr_str = stderr.decode("utf-8", errors="replace") if stderr else ""
        return {
            "success": process.returncode == 0,
            "stdout": stdout_str,
            "stderr": stderr_str,
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


async def exec_url_open(url: str) -> Dict[str, Any]:
    """Open a URL using the default browser."""
    result = await _run_powershell(f'Start-Process "{url}"')
    if result.get("success"):
        return {"success": True, "url": url, "message": f"Opened {url}"}
    return {"success": False, "error": result.get("stderr", "Unknown error")}


async def exec_app_open(app_name: str) -> Dict[str, Any]:
    """Open an application using Start-Process."""
    result = await _run_powershell(f'Start-Process "{app_name}"')
    if result.get("success"):
        return {"success": True, "app": app_name, "message": f"Opened {app_name}"}
    return {"success": False, "error": result.get("stderr", "Unknown error")}


async def exec_clipboard_read() -> Dict[str, Any]:
    """Read clipboard using PowerShell Get-Clipboard."""
    result = await _run_powershell("Get-Clipboard")
    if result.get("success"):
        content = result.get("stdout", "")
        return {
            "success": True,
            "content": _truncate_output(content),
            "length": len(content),
        }
    return {"success": False, "error": result.get("stderr", "Unknown error")}


async def exec_clipboard_write(text: str) -> Dict[str, Any]:
    """Write text to clipboard using PowerShell Set-Clipboard."""
    escaped = text.replace("'", "''")
    result = await _run_powershell(f"Set-Clipboard -Value '{escaped}'")
    if result.get("success"):
        return {"success": True, "length": len(text), "message": "Text copied to clipboard"}
    return {"success": False, "error": result.get("stderr", "Unknown error")}


async def exec_screenshot(save_path: str = None) -> Dict[str, Any]:
    """Take a screenshot using PowerShell and .NET."""
    if save_path:
        output_path = os.path.realpath(os.path.expanduser(save_path))
    else:
        fd, output_path = tempfile.mkstemp(suffix=".png", prefix="screenshot_")
        os.close(fd)

    ps_script = (
        "Add-Type -AssemblyName System.Windows.Forms; "
        "Add-Type -AssemblyName System.Drawing; "
        "$screen = [System.Windows.Forms.Screen]::PrimaryScreen; "
        "$bounds = $screen.Bounds; "
        "$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height); "
        "$graphics = [System.Drawing.Graphics]::FromImage($bmp); "
        f"$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size); "
        f"$bmp.Save('{output_path}'); "
        "$graphics.Dispose(); $bmp.Dispose()"
    )
    result = await _run_powershell(ps_script, timeout=15)

    if os.path.exists(output_path):
        size = os.path.getsize(output_path)
        return {
            "success": True,
            "path": output_path,
            "size": size,
            "message": f"Screenshot saved ({size} bytes)",
        }
    return {"success": False, "error": result.get("stderr", "Screenshot file not created")}


# ==================== Tool Executors ====================

WINDOWS_TOOL_EXECUTORS = {
    "url_open": lambda args: exec_url_open(url=args["url"]),
    "app_open": lambda args: exec_app_open(app_name=args["app_name"]),
    "clipboard_read": lambda args: exec_clipboard_read(),
    "clipboard_write": lambda args: exec_clipboard_write(text=args["text"]),
    "screenshot": lambda args: exec_screenshot(save_path=args.get("save_path")),
}
