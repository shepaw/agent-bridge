#!/usr/bin/env python3
"""
Test scenario: Shepaw does NOT respond to hub.getUIComponentTemplates
This simulates the real deadlock issue where Shepaw hangs or doesn't respond
"""
import asyncio
import json
import sys
import uuid
from datetime import datetime

# Add paths
sys.path.insert(0, '/Users/edenzou/workspace/shepaw/agent-bridge/paw_agent')
sys.path.insert(0, '/Users/edenzou/workspace/shepaw/agent-bridge/paw_acp_sdk')

import aiohttp
from aiohttp import web

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] {msg}", flush=True)


async def ws_client_test_no_hub_response():
    """WebSocket client that does NOT respond to hub.getUIComponentTemplates.
    
    This simulates the real problem: Shepaw app is not responding to hub requests.
    """
    await asyncio.sleep(2)  # Wait for server to start
    
    url = "ws://127.0.0.1:8081/acp/ws"
    
    try:
        async with aiohttp.ClientSession() as session:
            async with session.ws_connect(url, headers={}) as ws:
                log("Connected to agent WS")
                
                # Step 1: Send auth
                auth_id = str(uuid.uuid4())
                await ws.send_json({
                    "jsonrpc": "2.0",
                    "method": "auth.authenticate",
                    "id": auth_id,
                    "params": {"token": "mytoken123"}
                })
                log("→ Sent auth.authenticate")
                
                # Wait for auth response
                response = await asyncio.wait_for(ws.receive(), timeout=5.0)
                data = json.loads(response.data)
                log(f"← Auth response: {data.get('result', {}).get('status', 'failed')}")
                
                # Step 2: Send chat message
                chat_id = str(uuid.uuid4())
                session_id = str(uuid.uuid4())
                await ws.send_json({
                    "jsonrpc": "2.0",
                    "method": "agent.chat",
                    "id": chat_id,
                    "params": {
                        "message": "Hello! Just say 'hi' back to me.",
                        "session_id": session_id
                    }
                })
                log(f"→ Sent agent.chat (session: {session_id[:8]})")
                
                # Wait for chat ack
                response = await asyncio.wait_for(ws.receive(), timeout=5.0)
                data = json.loads(response.data)
                log(f"← Chat ack: {data}")
                
                # Step 3: Listen for response messages
                # IMPORTANT: Do NOT respond to any hub requests!
                # Just listen for ui.textContent and task.completed
                log("Listening for messages (NOT responding to hub requests)...")
                
                collected_text = []
                start_time = datetime.now()
                
                for _ in range(100):
                    try:
                        msg = await asyncio.wait_for(ws.receive(), timeout=30)
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            data = json.loads(msg.data)
                            method = data.get("method")
                            msg_id = data.get("id")
                            elapsed = (datetime.now() - start_time).total_seconds()
                            
                            if method and msg_id:
                                # Hub request - ignore it (don't respond)
                                log(f"[{elapsed:.1f}s] ← hub request (ignored): {method}")
                            elif method:
                                # Notification
                                if method == "ui.textContent":
                                    content = data.get("params", {}).get("content", "")
                                    is_final = data.get("params", {}).get("is_final", False)
                                    if content:
                                        collected_text.append(content)
                                        log(f"[{elapsed:.1f}s] ← text: {repr(content[:30])}")
                                    if is_final:
                                        log(f"[{elapsed:.1f}s] ← text FINAL")
                                elif method == "task.completed":
                                    log(f"[{elapsed:.1f}s] ← Task COMPLETED!")
                                    break
                                elif method == "task.error":
                                    log(f"[{elapsed:.1f}s] ← Task ERROR: {data.get('params')}")
                                    break
                                else:
                                    log(f"[{elapsed:.1f}s] ← notification: {method}")
                            elif msg_id:
                                log(f"[{elapsed:.1f}s] ← response: {str(data)[:80]}")
                                
                    except asyncio.TimeoutError:
                        log("✗ TIMEOUT: No message received in 30s - DEADLOCK DETECTED")
                        break
                
                total_time = (datetime.now() - start_time).total_seconds()
                log(f"\nTest Results:")
                log(f"  Total time: {total_time:.1f}s")
                log(f"  Reply: {''.join(collected_text)}")
                log(f"  Status: {'✓ PASSED' if total_time < 20 else '✗ DEADLOCKED (took > 20s)'}")
                
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
        await ws_client_test_no_hub_response()
    finally:
        log("Shutting down server")
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(run_server_and_test())
