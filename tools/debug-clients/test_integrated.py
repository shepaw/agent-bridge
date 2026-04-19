#!/usr/bin/env python3
"""
Integration test: starts the agent server in-process, then sends a chat message.
This avoids the subprocess/background shell issue.
"""
import asyncio
import json
import sys
import uuid
import os
from datetime import datetime

# Add paths
sys.path.insert(0, '/Users/edenzou/workspace/shepaw/agent-bridge/paw_agent')
sys.path.insert(0, '/Users/edenzou/workspace/shepaw/agent-bridge/paw_acp_sdk')

import aiohttp
from aiohttp import web

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] {msg}", flush=True)


async def ws_client_test():
    """WebSocket client that simulates Shepaw connecting to the agent."""
    await asyncio.sleep(2)  # Wait for server to start
    
    url = "ws://127.0.0.1:8081/acp/ws"
    headers = {"Authorization": "Bearer mytoken123"}
    
    try:
        async with aiohttp.ClientSession() as session:
            async with session.ws_connect(url, headers=headers) as ws:
                log("Connected to agent WS")
                
                # Step 1: Auth - token must be in params
                auth_id = str(uuid.uuid4())
                await ws.send_json({
                    "jsonrpc": "2.0",
                    "method": "auth.authenticate",
                    "id": auth_id,
                    "params": {"token": "mytoken123"}
                })
                log("→ Sent auth.authenticate")
                
                msg = await asyncio.wait_for(ws.receive(), timeout=5)
                data = json.loads(msg.data)
                log(f"← Auth response: {data}")
                
                # Step 2: Chat
                chat_id = str(uuid.uuid4())
                session_id = str(uuid.uuid4())
                await ws.send_json({
                    "jsonrpc": "2.0",
                    "method": "agent.chat",
                    "id": chat_id,
                    "params": {
                        "message": "Hello! Just say 'hi' back to me in a very short response.",
                        "session_id": session_id
                    }
                })
                log(f"→ Sent agent.chat (session: {session_id[:8]})")
                
                # Read messages until task.completed or timeout
                collected_text = []
                for _ in range(50):
                    try:
                        msg = await asyncio.wait_for(ws.receive(), timeout=30)
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            data = json.loads(msg.data)
                            method = data.get("method")
                            msg_id = data.get("id")
                            if method and msg_id:
                                # This is a JSON-RPC REQUEST from agent to us (hub.*)
                                log(f"← hub request: {method} (id={msg_id[:8]})")
                                if method == "hub.getUIComponentTemplates":
                                    # Respond with a minimal but valid response (simulating Shepaw)
                                    await ws.send_json({
                                        "jsonrpc": "2.0",
                                        "id": msg_id,
                                        "result": {
                                            "version": "1.0",
                                            "prompt_templates": {
                                                "acp_directive_prompt": "You can send UI components using directives."
                                            },
                                            "components": []
                                        }
                                    })
                                    log(f"→ Responded to hub.getUIComponentTemplates")
                                else:
                                    # Unknown hub method - return empty result
                                    await ws.send_json({
                                        "jsonrpc": "2.0",
                                        "id": msg_id,
                                        "result": {}
                                    })
                                    log(f"→ Responded to unknown hub method {method}")
                            elif method:
                                # Notification (no id) from agent to us
                                log(f"← notification: {method}")
                                if method == "ui.textContent":
                                    content = data.get("params", {}).get("content", "")
                                    is_final = data.get("params", {}).get("is_final", False)
                                    if content:
                                        collected_text.append(content)
                                        log(f"  text chunk: {repr(content[:50])}")
                                    if is_final:
                                        log("  (is_final=True)")
                                elif method == "task.completed":
                                    log("Task COMPLETED!")
                                    break
                                elif method == "task.error":
                                    log(f"Task ERROR: {data.get('params')}")
                                    break
                            elif msg_id:
                                # Response to our request (like agent.chat ack)
                                log(f"← response id={msg_id[:8]}: {str(data)[:100]}")
                    except asyncio.TimeoutError:
                        log("TIMEOUT: No message received in 30s - DEADLOCK DETECTED")
                        break
                
                log(f"\nFull reply: {''.join(collected_text)}")
                
    except Exception as e:
        log(f"Client error: {e}")
        import traceback
        traceback.print_exc()


async def run_server_and_test():
    """Start agent server and run client test concurrently."""
    from paw_agent import PawAgent
    from paw_acp_sdk.providers import GLMProvider
    
    provider = GLMProvider(
        api_base="https://open.bigmodel.cn/api/paas/v4",
        api_key="df9b4f515f664b10933259715f080c4c.IRhNEomafiOojnUf",
        model="glm-4.7"
    )
    
    agent = PawAgent(
        provider=provider,
        name="TestAgent",
        token="mytoken123",
        enable_os_tools=True,
        max_tool_rounds=5,
        interactive=True,
        provider_type="glm",
        model="glm-4.7",
        api_base="https://open.bigmodel.cn/api/paas/v4",
        api_key="df9b4f515f664b10933259715f080c4c.IRhNEomafiOojnUf",
    )
    
    app = agent.create_app()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 8081)
    await site.start()
    log("Agent server started on 127.0.0.1:8081")
    
    # Run client test concurrently
    try:
        await ws_client_test()
    finally:
        log("Shutting down server")
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(run_server_and_test())
