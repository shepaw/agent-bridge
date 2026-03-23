"""
Mac Tools - Tool definitions, risk classification, and execution for Mac operations.

Provides 14 tools that allow an LLM agent to interact with macOS:
shell commands, file operations, app/URL launching, screenshots,
clipboard, system info, AppleScript execution, and file sending.

Each operation is classified into one of three risk levels:
- SAFE: executed immediately, no user notification
- LOW_RISK: executed immediately, user notified afterwards
- HIGH_RISK: requires explicit user confirmation before execution
"""

import asyncio
import base64
import io
import json
import mimetypes
import os
import platform
import shutil
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


# ==================== Risk Classification ====================

class RiskLevel(Enum):
    SAFE = "safe"
    LOW_RISK = "low_risk"
    HIGH_RISK = "high_risk"


# System paths that are considered dangerous to modify
SYSTEM_PATH_BLACKLIST = (
    "/System",
    "/Library",
    "/usr",
    "/bin",
    "/sbin",
    "/etc",
    "/var",
    "/private",
)

# Shell commands considered read-only / safe
_SAFE_SHELL_COMMANDS = frozenset({
    "ls", "cat", "head", "tail", "pwd", "echo", "whoami", "hostname",
    "date", "cal", "uptime", "uname", "which", "where", "type",
    "wc", "sort", "uniq", "cut", "tr", "grep", "egrep", "fgrep",
    "find", "locate", "file", "stat", "du", "df", "free",
    "ps", "top", "htop", "id", "groups", "printenv", "env",
    "sw_vers", "system_profiler", "sysctl", "vm_stat",
    "diskutil", "mdls", "mdfind", "xattr",
    "defaults read", "launchctl list",
    # Network / process inspection
    "lsof", "ss",
})

# PIDs that must never be killed
_PROTECTED_PIDS = frozenset({0, 1})

# Process names (lowercase) that must never be killed
_PROTECTED_PROCESS_NAMES = frozenset({
    "kernel_task", "launchd", "windowserver", "loginwindow",
    "init", "systemd",
    "csrss", "wininit", "services", "lsass", "smss",
    "shepaw",
})

# Shell patterns that indicate high-risk operations
_HIGH_RISK_SHELL_PATTERNS = (
    "sudo", "rm ", "rm\t", "rmdir",
    "mkfs", "dd ", "dd\t",
    "chmod", "chown", "chgrp",
    "> /", ">> /",
    "curl ", "wget ",
    "pip install", "npm install", "brew install",
    "launchctl load", "launchctl unload",
    "defaults write", "defaults delete",
    "killall", "kill ",
    "shutdown", "reboot", "halt",
    "networksetup",
    "dscl", "security",
)

# AppleScript patterns that indicate high-risk operations
_HIGH_RISK_APPLESCRIPT_PATTERNS = (
    "do shell script",
    "delete", "remove",
    "quit", "close",
    "set ", "put ",
    "make new",
    "keystroke", "key code",
    "click",
)

# Maximum output size in bytes before truncation
MAX_OUTPUT_SIZE = 10 * 1024  # 10 KB

# Default subprocess timeout in seconds
DEFAULT_TIMEOUT = 30


# ==================== Tool Definitions (OpenAI function-calling format) ====================

MAC_TOOLS_DEFINITIONS: List[Dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "shell_exec",
            "description": "Execute a shell command on the user's Mac. Use for running terminal commands, scripts, and system utilities.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Timeout in seconds (default: 30, max: 300)",
                    },
                    "working_dir": {
                        "type": "string",
                        "description": "Working directory for the command (default: user's home)",
                    },
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "file_read",
            "description": "Read the contents of a file on the user's Mac.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the file to read",
                    },
                    "max_bytes": {
                        "type": "integer",
                        "description": "Maximum bytes to read (default: 10240)",
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "file_write",
            "description": "Write content to a file on the user's Mac. Creates the file if it doesn't exist.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the file to write",
                    },
                    "content": {
                        "type": "string",
                        "description": "Content to write to the file",
                    },
                    "append": {
                        "type": "boolean",
                        "description": "If true, append to existing file instead of overwriting (default: false)",
                    },
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "file_delete",
            "description": "Delete a file or directory on the user's Mac.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the file or directory to delete",
                    },
                    "recursive": {
                        "type": "boolean",
                        "description": "If true, delete directories recursively (default: false)",
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "file_move",
            "description": "Move or rename a file or directory on the user's Mac.",
            "parameters": {
                "type": "object",
                "properties": {
                    "source": {
                        "type": "string",
                        "description": "Absolute path of the source file or directory",
                    },
                    "destination": {
                        "type": "string",
                        "description": "Absolute path of the destination",
                    },
                },
                "required": ["source", "destination"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "file_list",
            "description": "List the contents of a directory on the user's Mac.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the directory to list",
                    },
                    "show_hidden": {
                        "type": "boolean",
                        "description": "Include hidden files (default: false)",
                    },
                    "detail": {
                        "type": "boolean",
                        "description": "Show detailed info (size, modified time) (default: false)",
                    },
                },
                "required": ["path"],
            },
        },
    },
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
            "name": "system_info",
            "description": "Get system information about the user's Mac.",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "enum": ["overview", "cpu", "memory", "disk", "network", "battery", "displays"],
                        "description": "Category of system info to retrieve (default: 'overview')",
                    },
                },
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
            "name": "send_file",
            "description": (
                "Send a file or image to the user so it appears in their chat app. "
                "This is the ONLY way to transfer files and images to the user. "
                "Do NOT use file_read for binary files (images, PDFs, etc.) — use send_file instead. "
                "The file will be served over HTTP and displayed inline in the chat."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the file to send",
                    },
                    "filename": {
                        "type": "string",
                        "description": "Display name for the file (defaults to the file's basename)",
                    },
                    "mime_type": {
                        "type": "string",
                        "description": "MIME type of the file (auto-detected from extension if omitted)",
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "process_list",
            "description": (
                "List running processes on the local machine. "
                "Supports filtering by name, sorting by cpu/memory/pid, and limiting results."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "filter": {
                        "type": "string",
                        "description": "Filter processes by name (case-insensitive substring match)",
                    },
                    "sort_by": {
                        "type": "string",
                        "enum": ["cpu", "memory", "pid", "name"],
                        "description": "Sort order (default: 'cpu')",
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum number of processes to return (default: 50)",
                    },
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "process_kill",
            "description": (
                "Kill a process by PID. Sends SIGTERM by default, or SIGKILL with force=true. "
                "Protected system processes cannot be killed."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "pid": {
                        "type": "integer",
                        "description": "The process ID to kill",
                    },
                    "force": {
                        "type": "boolean",
                        "description": "If true, send SIGKILL instead of SIGTERM (default: false)",
                    },
                },
                "required": ["pid"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "process_detail",
            "description": (
                "Get detailed information about a specific process by PID, "
                "including CPU, memory, command line, and open files."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "pid": {
                        "type": "integer",
                        "description": "The process ID to inspect",
                    },
                },
                "required": ["pid"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "network_connections",
            "description": (
                "List active network connections (TCP/UDP). "
                "Optionally filter by a specific process PID."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "pid": {
                        "type": "integer",
                        "description": "Filter connections by process ID (optional)",
                    },
                },
            },
        },
    },
]


def get_tool_definitions_for_claude() -> List[Dict[str, Any]]:
    """Convert OpenAI-format tool definitions to Anthropic Claude format."""
    tools = []
    for tool_def in MAC_TOOLS_DEFINITIONS:
        func = tool_def["function"]
        tools.append({
            "name": func["name"],
            "description": func["description"],
            "input_schema": func["parameters"],
        })
    return tools


# ==================== Risk Classification ====================

def _is_system_path(path: str) -> bool:
    """Check if a path is within a system-protected directory."""
    real = os.path.realpath(os.path.expanduser(path))
    return any(real.startswith(p) for p in SYSTEM_PATH_BLACKLIST)


def classify_risk(tool_name: str, arguments: Dict[str, Any]) -> RiskLevel:
    """Classify the risk level of a tool call based on tool name and arguments."""

    if tool_name == "shell_exec":
        return _classify_shell_risk(arguments.get("command", ""))

    if tool_name == "file_read":
        return RiskLevel.SAFE

    if tool_name == "file_write":
        path = arguments.get("path", "")
        if _is_system_path(path):
            return RiskLevel.HIGH_RISK
        return RiskLevel.LOW_RISK

    if tool_name == "file_delete":
        return RiskLevel.HIGH_RISK

    if tool_name == "file_move":
        src = arguments.get("source", "")
        dst = arguments.get("destination", "")
        if _is_system_path(src) or _is_system_path(dst):
            return RiskLevel.HIGH_RISK
        return RiskLevel.LOW_RISK

    if tool_name == "file_list":
        return RiskLevel.SAFE

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

    if tool_name == "system_info":
        return RiskLevel.SAFE

    if tool_name == "applescript_exec":
        return _classify_applescript_risk(arguments.get("script", ""))

    if tool_name == "send_file":
        return RiskLevel.LOW_RISK

    if tool_name == "process_list":
        return RiskLevel.SAFE

    if tool_name == "process_kill":
        return RiskLevel.HIGH_RISK

    if tool_name == "process_detail":
        return RiskLevel.SAFE

    if tool_name == "network_connections":
        return RiskLevel.SAFE

    # Unknown tool — high risk by default
    return RiskLevel.HIGH_RISK


def _classify_shell_risk(command: str) -> RiskLevel:
    """Classify risk of a shell command."""
    cmd_stripped = command.strip()
    cmd_lower = cmd_stripped.lower()

    # Check for high-risk patterns first
    for pattern in _HIGH_RISK_SHELL_PATTERNS:
        if pattern in cmd_lower:
            return RiskLevel.HIGH_RISK

    # Check for pipes / redirections to system paths
    if "|" in cmd_stripped and any(p in cmd_lower for p in ("/system", "/library", "/usr", "/bin")):
        return RiskLevel.HIGH_RISK

    # Check if the base command is in the safe list
    base_cmd = cmd_stripped.split()[0] if cmd_stripped else ""
    if base_cmd in _SAFE_SHELL_COMMANDS:
        return RiskLevel.SAFE

    # Check two-word safe commands (e.g., "defaults read")
    two_word = " ".join(cmd_stripped.split()[:2]).lower()
    if two_word in _SAFE_SHELL_COMMANDS:
        return RiskLevel.SAFE

    return RiskLevel.LOW_RISK


def _classify_applescript_risk(script: str) -> RiskLevel:
    """Classify risk of an AppleScript."""
    script_lower = script.lower()
    for pattern in _HIGH_RISK_APPLESCRIPT_PATTERNS:
        if pattern in script_lower:
            return RiskLevel.HIGH_RISK
    return RiskLevel.LOW_RISK


# ==================== Tool Output Helper ====================

def _truncate_output(text: str, max_size: int = MAX_OUTPUT_SIZE) -> str:
    """Truncate output if it exceeds max_size bytes."""
    encoded = text.encode("utf-8", errors="replace")
    if len(encoded) <= max_size:
        return text
    truncated = encoded[:max_size].decode("utf-8", errors="replace")
    return truncated + f"\n\n[Output truncated: {len(encoded)} bytes total, showing first {max_size} bytes]"


# ==================== Tool Execution Functions ====================

async def exec_shell(command: str, timeout: int = DEFAULT_TIMEOUT, working_dir: str = None) -> Dict[str, Any]:
    """Execute a shell command."""
    timeout = min(max(timeout, 1), 300)
    cwd = working_dir or os.path.expanduser("~")

    try:
        process = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)

        stdout_str = _truncate_output(stdout.decode("utf-8", errors="replace")) if stdout else ""
        stderr_str = _truncate_output(stderr.decode("utf-8", errors="replace")) if stderr else ""

        return {
            "success": process.returncode == 0,
            "exit_code": process.returncode,
            "stdout": stdout_str,
            "stderr": stderr_str,
        }
    except asyncio.TimeoutError:
        try:
            process.kill()
        except Exception:
            pass
        return {"success": False, "error": f"Command timed out after {timeout}s"}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def exec_file_read(path: str, max_bytes: int = MAX_OUTPUT_SIZE) -> Dict[str, Any]:
    """Read a file's contents."""
    real_path = os.path.realpath(os.path.expanduser(path))
    try:
        if not os.path.exists(real_path):
            return {"success": False, "error": f"File not found: {path}"}
        if not os.path.isfile(real_path):
            return {"success": False, "error": f"Not a file: {path}"}

        file_size = os.path.getsize(real_path)
        with open(real_path, "r", errors="replace") as f:
            content = f.read(max_bytes)

        result = {
            "success": True,
            "path": real_path,
            "size": file_size,
            "content": content,
        }
        if file_size > max_bytes:
            result["truncated"] = True
            result["note"] = f"File is {file_size} bytes, showing first {max_bytes} bytes"
        return result
    except Exception as e:
        return {"success": False, "error": str(e)}


async def exec_file_write(path: str, content: str, append: bool = False) -> Dict[str, Any]:
    """Write content to a file."""
    real_path = os.path.realpath(os.path.expanduser(path))
    try:
        # Create parent directories if needed
        parent_dir = os.path.dirname(real_path)
        if not os.path.exists(parent_dir):
            os.makedirs(parent_dir, exist_ok=True)

        mode = "a" if append else "w"
        with open(real_path, mode) as f:
            f.write(content)

        return {
            "success": True,
            "path": real_path,
            "bytes_written": len(content.encode("utf-8")),
            "mode": "append" if append else "write",
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


async def exec_file_delete(path: str, recursive: bool = False) -> Dict[str, Any]:
    """Delete a file or directory."""
    real_path = os.path.realpath(os.path.expanduser(path))
    try:
        if not os.path.exists(real_path):
            return {"success": False, "error": f"Path not found: {path}"}

        if os.path.isdir(real_path):
            if recursive:
                shutil.rmtree(real_path)
            else:
                os.rmdir(real_path)
        else:
            os.remove(real_path)

        return {"success": True, "path": real_path, "deleted": True}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def exec_file_move(source: str, destination: str) -> Dict[str, Any]:
    """Move or rename a file or directory."""
    real_src = os.path.realpath(os.path.expanduser(source))
    real_dst = os.path.realpath(os.path.expanduser(destination))
    try:
        if not os.path.exists(real_src):
            return {"success": False, "error": f"Source not found: {source}"}

        shutil.move(real_src, real_dst)
        return {"success": True, "source": real_src, "destination": real_dst}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def exec_file_list(path: str, show_hidden: bool = False, detail: bool = False) -> Dict[str, Any]:
    """List directory contents."""
    real_path = os.path.realpath(os.path.expanduser(path))
    try:
        if not os.path.exists(real_path):
            return {"success": False, "error": f"Directory not found: {path}"}
        if not os.path.isdir(real_path):
            return {"success": False, "error": f"Not a directory: {path}"}

        entries = os.listdir(real_path)
        if not show_hidden:
            entries = [e for e in entries if not e.startswith(".")]
        entries.sort()

        if detail:
            detailed = []
            for entry in entries:
                entry_path = os.path.join(real_path, entry)
                try:
                    stat = os.stat(entry_path)
                    detailed.append({
                        "name": entry,
                        "type": "directory" if os.path.isdir(entry_path) else "file",
                        "size": stat.st_size,
                        "modified": stat.st_mtime,
                    })
                except OSError:
                    detailed.append({"name": entry, "type": "unknown"})
            return {"success": True, "path": real_path, "entries": detailed, "count": len(detailed)}
        else:
            return {"success": True, "path": real_path, "entries": entries, "count": len(entries)}
    except Exception as e:
        return {"success": False, "error": str(e)}


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
    """Take a screenshot."""
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
            # Custom region: x,y,w,h
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
    """Read clipboard contents."""
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
    """Write text to clipboard."""
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


async def exec_system_info(category: str = "overview") -> Dict[str, Any]:
    """Get system information."""
    try:
        info: Dict[str, Any] = {"success": True, "category": category}

        if category == "overview":
            info["hostname"] = platform.node()
            info["os"] = platform.system()
            info["os_version"] = platform.mac_ver()[0] or platform.release()
            info["architecture"] = platform.machine()
            info["processor"] = platform.processor()

            # Get uptime
            result = await _run_simple_command("uptime")
            if result:
                info["uptime"] = result.strip()

        elif category == "cpu":
            result = await _run_simple_command("sysctl -n machdep.cpu.brand_string")
            if result:
                info["cpu_name"] = result.strip()
            result = await _run_simple_command("sysctl -n hw.ncpu")
            if result:
                info["cpu_cores"] = result.strip()
            result = await _run_simple_command("sysctl -n hw.activecpu")
            if result:
                info["active_cpus"] = result.strip()
            result = await _run_simple_command("ps -A -o %cpu | awk '{s+=$1} END {print s}'")
            if result:
                info["cpu_usage_percent"] = result.strip()

        elif category == "memory":
            result = await _run_simple_command("sysctl -n hw.memsize")
            if result:
                info["total_bytes"] = int(result.strip())
                info["total_gb"] = round(int(result.strip()) / (1024**3), 2)
            result = await _run_simple_command("vm_stat")
            if result:
                info["vm_stat"] = result.strip()

        elif category == "disk":
            result = await _run_simple_command("df -h /")
            if result:
                info["root_disk"] = result.strip()
            result = await _run_simple_command("df -h")
            if result:
                info["all_disks"] = result.strip()

        elif category == "network":
            result = await _run_simple_command("ifconfig | grep 'inet ' | grep -v 127.0.0.1")
            if result:
                info["ip_addresses"] = result.strip()
            result = await _run_simple_command("networksetup -listallhardwareports")
            if result:
                info["network_interfaces"] = _truncate_output(result.strip())

        elif category == "battery":
            result = await _run_simple_command("pmset -g batt")
            if result:
                info["battery"] = result.strip()

        elif category == "displays":
            result = await _run_simple_command("system_profiler SPDisplaysDataType 2>/dev/null")
            if result:
                info["displays"] = _truncate_output(result.strip())

        return info
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


# ==================== Process Management ====================

async def exec_process_list(
    filter_name: Optional[str] = None,
    sort_by: str = "cpu",
    limit: int = 50,
) -> Dict[str, Any]:
    """List running processes."""
    try:
        result = await _run_simple_command("ps aux")
        if not result:
            return {"success": False, "error": "Failed to list processes"}

        processes = _parse_ps_aux(result)

        # Filter
        if filter_name:
            lower_filter = filter_name.lower()
            processes = [p for p in processes if lower_filter in p.get("name", "").lower()]

        # Sort
        sort_key_map = {
            "cpu": lambda p: p.get("cpu_percent", 0),
            "memory": lambda p: p.get("memory_percent", 0),
            "pid": lambda p: p.get("pid", 0),
            "name": lambda p: p.get("name", ""),
        }
        key_fn = sort_key_map.get(sort_by, sort_key_map["cpu"])
        reverse = sort_by not in ("pid", "name")
        processes.sort(key=key_fn, reverse=reverse)

        # Limit
        processes = processes[:limit]

        return {"success": True, "count": len(processes), "processes": processes}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _parse_ps_aux(output: str) -> List[Dict[str, Any]]:
    """Parse ps aux output into a list of process dicts."""
    lines = output.strip().split("\n")
    if len(lines) < 2:
        return []
    results = []
    for line in lines[1:]:
        parts = line.split(None, 10)
        if len(parts) < 11:
            continue
        command = parts[10]
        name = command.split("/")[-1].split()[0] if command else ""
        results.append({
            "user": parts[0],
            "pid": int(parts[1]) if parts[1].isdigit() else 0,
            "cpu_percent": float(parts[2]) if parts[2].replace(".", "", 1).isdigit() else 0.0,
            "memory_percent": float(parts[3]) if parts[3].replace(".", "", 1).isdigit() else 0.0,
            "rss_kb": int(parts[5]) if parts[5].isdigit() else 0,
            "name": name,
            "command": command,
        })
    return results


async def exec_process_kill(pid: int, force: bool = False) -> Dict[str, Any]:
    """Kill a process by PID with protection checks."""
    if pid < 0:
        return {"success": False, "error": f"Invalid PID: {pid}"}

    # Check protected PIDs
    if pid in _PROTECTED_PIDS:
        return {"success": False, "error": f"Cannot kill protected system process (PID {pid})"}

    # Resolve process name
    process_name = None
    try:
        result = await _run_simple_command(f"ps -p {pid} -o comm=")
        if result:
            process_name = result.strip().split("/")[-1]
    except Exception:
        pass

    # Check protected names
    if process_name and process_name.lower() in _PROTECTED_PROCESS_NAMES:
        return {
            "success": False,
            "error": f"Cannot kill protected system process: {process_name} (PID {pid})",
        }

    # Kill
    signal = "-9" if force else "-TERM"
    try:
        process = await asyncio.create_subprocess_exec(
            "kill", signal, str(pid),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=10)

        if process.returncode == 0:
            sig_name = "SIGKILL" if force else "SIGTERM"
            name_str = f" ({process_name})" if process_name else ""
            return {
                "success": True,
                "pid": pid,
                "signal": sig_name,
                "process_name": process_name,
                "message": f"Sent {sig_name} to process {pid}{name_str}",
            }
        else:
            return {"success": False, "error": stderr.decode("utf-8", errors="replace").strip()}
    except asyncio.TimeoutError:
        return {"success": False, "error": "Kill command timed out"}
    except Exception as e:
        return {"success": False, "error": str(e)}


async def exec_process_detail(pid: int) -> Dict[str, Any]:
    """Get detailed info about a process."""
    if pid < 0:
        return {"success": False, "error": f"Invalid PID: {pid}"}

    try:
        # Basic info
        ps_result = await _run_simple_command(
            f"ps -p {pid} -o pid,user,%cpu,%mem,rss,lstart,command"
        )
        if not ps_result or len(ps_result.strip().split("\n")) < 2:
            return {"success": False, "error": f"Process not found (PID {pid})"}

        detail = _parse_ps_detail(ps_result, pid)

        # Open files (best-effort)
        lsof_result = await _run_simple_command(f"lsof -p {pid} 2>/dev/null | head -20")
        if lsof_result:
            detail["open_files_preview"] = _truncate_output(lsof_result.strip(), 2048)

        return {"success": True, **detail}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _parse_ps_detail(output: str, pid: int) -> Dict[str, Any]:
    """Parse ps -p output for a single process."""
    lines = output.strip().split("\n")
    if len(lines) < 2:
        return {"pid": pid}
    line = lines[1].strip()
    if not line:
        return {"pid": pid}
    parts = line.split(None, 10)
    if len(parts) < 7:
        return {"pid": pid, "raw": line}
    return {
        "pid": int(parts[0]) if parts[0].isdigit() else pid,
        "user": parts[1],
        "cpu_percent": float(parts[2]) if parts[2].replace(".", "", 1).isdigit() else 0.0,
        "memory_percent": float(parts[3]) if parts[3].replace(".", "", 1).isdigit() else 0.0,
        "rss_kb": int(parts[4]) if parts[4].isdigit() else 0,
        "start_time": " ".join(parts[5:10]) if len(parts) > 9 else parts[5],
        "command": parts[10] if len(parts) > 10 else parts[-1],
    }


async def exec_network_connections(pid: Optional[int] = None) -> Dict[str, Any]:
    """List active network connections."""
    try:
        pid_flag = f" -p {pid}" if pid is not None else ""
        result = await _run_simple_command(f"lsof -i -n -P{pid_flag} 2>/dev/null")
        if not result:
            return {"success": True, "count": 0, "connections": []}

        connections = _parse_lsof_network(result)
        return {"success": True, "count": len(connections), "connections": connections}
    except Exception as e:
        return {"success": False, "error": str(e)}


def _parse_lsof_network(output: str) -> List[Dict[str, Any]]:
    """Parse lsof -i output."""
    lines = output.strip().split("\n")
    if len(lines) < 2:
        return []
    results = []
    for line in lines[1:]:
        parts = line.split(None)
        if len(parts) < 9:
            continue
        results.append({
            "process": parts[0],
            "pid": int(parts[1]) if parts[1].isdigit() else 0,
            "user": parts[2],
            "type": parts[7] if len(parts) > 7 else "",
            "name": parts[-1],
        })
    return results


# ==================== File Serving (send_file) ====================

# Module-level registry of files being served over HTTP.
# Maps file_id -> {path, filename, mime_type, size, created_at}
_served_files: Dict[str, Dict[str, Any]] = {}

# Served files expire after this many seconds (default: 1 hour)
_SERVED_FILE_TTL = 3600


async def exec_send_file(path: str, filename: str = None, mime_type: str = None) -> Dict[str, Any]:
    """Register a file for HTTP serving and return metadata.

    Does NOT send any WebSocket notification — the caller (mac_agent) handles that.
    """
    real_path = os.path.realpath(os.path.expanduser(path))
    try:
        if not os.path.exists(real_path):
            return {"success": False, "error": f"File not found: {path}"}
        if not os.path.isfile(real_path):
            return {"success": False, "error": f"Not a file: {path}"}

        file_size = os.path.getsize(real_path)
        if filename is None:
            filename = os.path.basename(real_path)
        if mime_type is None:
            mime_type, _ = mimetypes.guess_type(real_path)
            if mime_type is None:
                mime_type = "application/octet-stream"

        file_id = uuid.uuid4().hex[:12]
        _served_files[file_id] = {
            "path": real_path,
            "filename": filename,
            "mime_type": mime_type,
            "size": file_size,
            "created_at": time.time(),
        }

        result = {
            "success": True,
            "file_id": file_id,
            "filename": filename,
            "mime_type": mime_type,
            "size": file_size,
        }

        # Generate thumbnail for image files
        if mime_type.startswith("image/"):
            thumbnail = _generate_thumbnail_base64(real_path)
            if thumbnail:
                result["thumbnail_base64"] = thumbnail

        return result
    except Exception as e:
        return {"success": False, "error": str(e)}


def get_served_file(file_id: str) -> Optional[Dict[str, Any]]:
    """Look up a served file by ID. Returns None if not found or expired."""
    entry = _served_files.get(file_id)
    if entry is None:
        return None
    if time.time() - entry["created_at"] > _SERVED_FILE_TTL:
        _served_files.pop(file_id, None)
        return None
    return entry


def cleanup_expired_files() -> int:
    """Remove expired entries from _served_files. Returns count of removed entries."""
    now = time.time()
    expired = [fid for fid, info in _served_files.items()
               if now - info["created_at"] > _SERVED_FILE_TTL]
    for fid in expired:
        _served_files.pop(fid, None)
    return len(expired)


def _generate_thumbnail_base64(file_path: str, max_dimension: int = 200) -> Optional[str]:
    """Generate a base64-encoded JPEG thumbnail for an image file.

    Returns a base64 string (no data URI prefix) or None on failure.
    Gracefully degrades if Pillow is not installed.
    """
    try:
        from PIL import Image as PILImage
    except ImportError:
        return None

    try:
        with PILImage.open(file_path) as img:
            img.thumbnail((max_dimension, max_dimension))
            # Convert to RGB for JPEG (handles RGBA/palette images)
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=60)
            return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return None


async def _run_simple_command(command: str) -> Optional[str]:
    """Run a simple command and return stdout, or None on failure."""
    try:
        process = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(process.communicate(), timeout=10)
        if process.returncode == 0 and stdout:
            return stdout.decode("utf-8", errors="replace")
    except Exception:
        pass
    return None


# ==================== Tool Dispatcher ====================

# Map tool name -> executor function
_TOOL_EXECUTORS = {
    "shell_exec": lambda args: exec_shell(
        command=args["command"],
        timeout=args.get("timeout", DEFAULT_TIMEOUT),
        working_dir=args.get("working_dir"),
    ),
    "file_read": lambda args: exec_file_read(
        path=args["path"],
        max_bytes=args.get("max_bytes", MAX_OUTPUT_SIZE),
    ),
    "file_write": lambda args: exec_file_write(
        path=args["path"],
        content=args["content"],
        append=args.get("append", False),
    ),
    "file_delete": lambda args: exec_file_delete(
        path=args["path"],
        recursive=args.get("recursive", False),
    ),
    "file_move": lambda args: exec_file_move(
        source=args["source"],
        destination=args["destination"],
    ),
    "file_list": lambda args: exec_file_list(
        path=args["path"],
        show_hidden=args.get("show_hidden", False),
        detail=args.get("detail", False),
    ),
    "app_open": lambda args: exec_app_open(
        app_name=args["app_name"],
    ),
    "url_open": lambda args: exec_url_open(
        url=args["url"],
    ),
    "screenshot": lambda args: exec_screenshot(
        region=args.get("region", "full"),
        save_path=args.get("save_path"),
    ),
    "clipboard_read": lambda args: exec_clipboard_read(),
    "clipboard_write": lambda args: exec_clipboard_write(
        text=args["text"],
    ),
    "system_info": lambda args: exec_system_info(
        category=args.get("category", "overview"),
    ),
    "applescript_exec": lambda args: exec_applescript(
        script=args["script"],
    ),
    "send_file": lambda args: exec_send_file(
        path=args["path"],
        filename=args.get("filename"),
        mime_type=args.get("mime_type"),
    ),
    "process_list": lambda args: exec_process_list(
        filter_name=args.get("filter"),
        sort_by=args.get("sort_by", "cpu"),
        limit=args.get("limit", 50),
    ),
    "process_kill": lambda args: exec_process_kill(
        pid=args["pid"],
        force=args.get("force", False),
    ),
    "process_detail": lambda args: exec_process_detail(
        pid=args["pid"],
    ),
    "network_connections": lambda args: exec_network_connections(
        pid=args.get("pid"),
    ),
}


async def run_tool(tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    """Execute a tool by name with given arguments."""
    executor = _TOOL_EXECUTORS.get(tool_name)
    if not executor:
        return {"success": False, "error": f"Unknown tool: {tool_name}"}
    try:
        return await executor(arguments)
    except Exception as e:
        return {"success": False, "error": f"Tool execution error: {e}"}


def get_risk_description(risk: RiskLevel, tool_name: str, arguments: Dict[str, Any]) -> str:
    """Generate a human-readable description of a tool operation for confirmation prompts."""
    if tool_name == "shell_exec":
        return f"Execute shell command: `{arguments.get('command', '')}`"
    if tool_name == "file_write":
        return f"Write to file: {arguments.get('path', '')}"
    if tool_name == "file_delete":
        path = arguments.get("path", "")
        recursive = arguments.get("recursive", False)
        return f"Delete {'directory (recursive)' if recursive else 'file'}: {path}"
    if tool_name == "file_move":
        return f"Move: {arguments.get('source', '')} → {arguments.get('destination', '')}"
    if tool_name == "applescript_exec":
        script = arguments.get("script", "")
        preview = script[:100] + ("..." if len(script) > 100 else "")
        return f"Execute AppleScript: {preview}"
    if tool_name == "send_file":
        return f"Send file to user: {arguments.get('path', '')}"
    if tool_name == "process_kill":
        pid = arguments.get("pid", "")
        force = arguments.get("force", False)
        signal = "SIGKILL / force" if force else "SIGTERM"
        return f"Kill process PID {pid} ({signal})"
    return f"Execute {tool_name} with args: {json.dumps(arguments, ensure_ascii=False)[:200]}"
