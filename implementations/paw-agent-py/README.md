# paw-agent-py

Multi-platform local OS control agent (macOS / Linux / Windows) built on
the Python `shepaw_acp_sdk`.

> **Status: unmaintained in this repo.**
>
> The top-level `sys.path.insert(..., "..", "paw_acp_sdk")` in
> `paw_agent.py` points at the pre-rename SDK path and has been stale for
> a while — kept here as a reference implementation, not wired into CI.
>
> If you want to run it, either:
>
> 1. `pip install -e ../../sdks/shepaw-acp-sdk-python` first, then remove
>    the two `sys.path.insert` lines at the top of `paw_agent.py` and
>    change `from paw_acp_sdk import …` to `from shepaw_acp_sdk import …`, OR
> 2. Update the `sys.path.insert` to
>    `os.path.join(os.path.dirname(__file__), "..", "..", "sdks",
>    "shepaw-acp-sdk-python")` and swap the import name.

See the repo root `README.md` for the overall layout and supported
implementations.
