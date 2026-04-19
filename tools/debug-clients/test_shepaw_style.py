#!/usr/bin/env python3
"""
Test with Authorization header (like Shepaw does)
"""
import asyncio
import json
import sys
import uuid
from datetime import datetime

sys.path.insert(0, '/Users/edenzou/workspace/shepaw/agent-bridge/paw_agent')
sys.path.insert(0, '/Users/edenzou/workspace/shepaw/agent-bridge/paw_acp_sdk')

import aiohttp
from aiohttp import web

def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S.%f')[:-3]}] {msg}", flush=True)


async def ws_client_shepaw_style():
    """Client that uses Authorization header like Shepaw does."""
    await asyncio.sleep(2)
    
    url = "ws://127.0.0.1:8081/acp/ws"
    
    try:
        async with aiohttp.ClientSession() as session:
            # Send Authorization header like Shepaw does (no auth.authenticate message)
            async with session.ws_connect(url, headers={"Authorization": "Bearer mytoken123"}) as ws:
                log("✓ Connected to agent with Authorization header (Shepaw-style)")
                log("(No auth.authenticate message sent)")
                
                # Directly send agent.chat (without auth.authenticate)
                chat_id = str(uuid.uuid4())
                session_id = str(uuid.uuid4())
                await ws.send_json({
                    "jsonrpc": "2.0",
                    "method": "agent.chat",
                    "id": chat_id,
                    "params": {
                        "message": "Hello from Shepaw-style client!",
                        "session_id": session_id
                    }
                })
                log(f"→ Sent agent.chat (session: {session_id[:8]})")
                
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
                                # Hub request - respond with minimal result
                                if method == "hub.getUIComponentTemplates":
                                    await ws.send_json({
                                        "jsonrpc": "2.0",
                                        "id": msg_id,
                                        "result": {
                                            "version": "1.0",
                                            "prompt_templates": {"acp_directive_prompt": ""},
                                            "components": []
                                        }
                                    })
                                    log(f"[{elapsed:.1f}s] ← hub.getUIComponentTemplates (responded)")
                                else:
                                    await ws.send_json({
                                        "jsonrpc": "2.0",
                                        "id": msg_id,
                                        "result": {}
                                    })
                                    log(f"[{elapsed:.1f}s] ← hub request: {method}")
                            elif method:
                                if method == "ui.textContent":
                                    content = data.get("params", {}).get("content", "")
                                    is_final = data.get("params", {}).get("is_final", False)
                                    if content:
                                        collected_text.append(content)
                                    if is_final:
                                        log(f"[{elapsed:.1f}s] ← Text FINAL")
                                elif method == "task.completed":
                                    log(f"[{elapsed:.1f}s] ← ✓ task.completed!")
                                    break
                                elif method == "task.error":
                                    log(f"[{elapsed:.1f}s] ← ✗ task.error: {data.get('params')}")
                                    break
                            elif msg_id:
                                if "result" in data:
                                    log(f"[{elapsed:.1f}s] ← ✓ Response OK")
                                elif "error" in data:
                                    log(f"[{elapsed:.1f}s] ← ✗ Response ERROR: {data['error']}")
                                    break
                                
                    except asyncio.TimeoutError:
                        log("✗ TIMEOUT: No message in 30s")
                        break
                
                total_time = (datetime.now() - start_time).total_seconds()
                log(f"\n✓ SUCCESS! Total time: {total_time:.1f}s")
                log(f"Reply: {''.join(collected_text)}")
                
    except Exception as e:
        log(f"✗ Error: {e}")
        import traceback
        traceback.print_exc()


async def run_test():
    from paw_agent import PawAgent
    from paw_acp_sdk.providers import GLMProvider
    
    provider = GLMProvider(
        api_base="https://open.bigmodel.cn/api/paas/v4",
        api_key="df9b4f515f664b10933259715f080c4c.IRhNEomafiOojnUf",
        model="glm-4.7"
    )
    
    agent = PawAgent(
        provider=provider,
        name="PawAgent",
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
    log("Agent server started")
    
    try:
        await ws_client_shepaw_style()
    finally:
        log("Shutting down")
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(run_test())
