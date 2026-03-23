"""Platform-aware tool registry for paw_agent.

Exports:
- ``ALL_TOOL_DEFINITIONS``: Combined OpenAI-format tool list for the current platform.
- ``ALL_TOOL_DEFINITIONS_CLAUDE``: Same tools in Claude (Anthropic) format.
- ``classify_risk``: Risk classification for all tools (base + platform).
- ``get_risk_description``: Human-readable description for confirmation prompts.
- ``run_tool``: Async dispatcher — runs any tool by name.
- ``RiskLevel``: Enum of SAFE / LOW_RISK / HIGH_RISK.
- ``exec_send_file``, ``get_served_file``, ``cleanup_expired_files``: File serving helpers.
"""

import sys
from typing import Any, Dict, List, Optional

from .base_tools import (
    BASE_TOOL_DEFINITIONS,
    RiskLevel,
    classify_risk,
    get_risk_description,
    get_tool_definitions_for_claude,
    exec_send_file,
    get_served_file,
    cleanup_expired_files,
    _BASE_TOOL_EXECUTORS,
)

# ── Platform-specific dispatch ─────────────────────────────────────────────

if sys.platform == "darwin":
    from .mac_tools import (
        MAC_PLATFORM_TOOL_DEFINITIONS as PLATFORM_TOOL_DEFINITIONS,
        MAC_TOOL_EXECUTORS as _PLATFORM_EXECUTORS,
        classify_risk_mac as _classify_risk_platform,
        get_risk_description_mac as _get_risk_desc_platform,
    )
elif sys.platform == "linux":
    from .linux_tools import (
        LINUX_PLATFORM_TOOL_DEFINITIONS as PLATFORM_TOOL_DEFINITIONS,
        LINUX_TOOL_EXECUTORS as _PLATFORM_EXECUTORS,
        classify_risk_linux as _classify_risk_platform,
        get_risk_description_linux as _get_risk_desc_platform,
    )
elif sys.platform == "win32":
    from .windows_tools import (
        WINDOWS_PLATFORM_TOOL_DEFINITIONS as PLATFORM_TOOL_DEFINITIONS,
        WINDOWS_TOOL_EXECUTORS as _PLATFORM_EXECUTORS,
        classify_risk_windows as _classify_risk_platform,
        get_risk_description_windows as _get_risk_desc_platform,
    )
else:
    PLATFORM_TOOL_DEFINITIONS: List[Dict[str, Any]] = []
    _PLATFORM_EXECUTORS: Dict[str, Any] = {}

    def _classify_risk_platform(tool_name: str, arguments: Dict[str, Any]) -> Optional[RiskLevel]:
        return None

    def _get_risk_desc_platform(tool_name: str, arguments: Dict[str, Any]) -> Optional[str]:
        return None


# ── Combined tool list ─────────────────────────────────────────────────────

ALL_TOOL_DEFINITIONS: List[Dict[str, Any]] = BASE_TOOL_DEFINITIONS + PLATFORM_TOOL_DEFINITIONS
ALL_TOOL_DEFINITIONS_CLAUDE: List[Dict[str, Any]] = get_tool_definitions_for_claude(ALL_TOOL_DEFINITIONS)

# ── Combined executor map ──────────────────────────────────────────────────

_ALL_EXECUTORS: Dict[str, Any] = {**_BASE_TOOL_EXECUTORS, **_PLATFORM_EXECUTORS}


# ── Risk classification (base + platform override) ─────────────────────────

def classify_risk(tool_name: str, arguments: Dict[str, Any]) -> RiskLevel:  # type: ignore[override]
    """Classify risk for any tool (base or platform-specific)."""
    platform_result = _classify_risk_platform(tool_name, arguments)
    if platform_result is not None:
        return platform_result
    # Fall back to base classification
    from .base_tools import classify_risk as _base_classify
    return _base_classify(tool_name, arguments)


def get_risk_description(risk: RiskLevel, tool_name: str, arguments: Dict[str, Any]) -> str:  # type: ignore[override]
    """Human-readable description for a tool operation."""
    platform_result = _get_risk_desc_platform(tool_name, arguments)
    if platform_result is not None:
        return platform_result
    from .base_tools import get_risk_description as _base_desc
    return _base_desc(risk, tool_name, arguments)


# ── Dispatcher ─────────────────────────────────────────────────────────────

async def run_tool(tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    """Execute any tool (base or platform-specific) by name."""
    executor = _ALL_EXECUTORS.get(tool_name)
    if not executor:
        return {"success": False, "error": f"Unknown tool: {tool_name}"}
    try:
        return await executor(arguments)
    except Exception as e:
        return {"success": False, "error": f"Tool execution error: {e}"}


__all__ = [
    "ALL_TOOL_DEFINITIONS",
    "ALL_TOOL_DEFINITIONS_CLAUDE",
    "PLATFORM_TOOL_DEFINITIONS",
    "RiskLevel",
    "classify_risk",
    "get_risk_description",
    "run_tool",
    "exec_send_file",
    "get_served_file",
    "cleanup_expired_files",
]
