#!/usr/bin/env python3
"""
Test client to reproduce the deadlock issue
"""
import asyncio
import json
import websockets
import uuid
from datetime import datetime

async def test_agent():
    url = "ws://localhost:8081/acp/ws?token=mytoken123&agent_id=test_client"
    
    async with websockets.connect(url) as ws:
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Connected to agent")
        
        # Step 1: Send auth
        auth_msg = {
            "jsonrpc": "2.0",
            "method": "auth.authenticate",
            "id": str(uuid.uuid4())
        }
        print(f"[{datetime.now().strftime('%H:%M:%S')}] → Sending auth.authenticate")
        await ws.send(json.dumps(auth_msg))
        
        # Wait for auth response
        response = await asyncio.wait_for(ws.recv(), timeout=5.0)
        print(f"[{datetime.now().strftime('%H:%M:%S')}] ← Auth response: {response[:100]}")
        
        # Step 2: Send chat message
        chat_msg = {
            "jsonrpc": "2.0",
            "method": "agent.chat",
            "id": str(uuid.uuid4()),
            "params": {
                "message": "Hello, say hello back to me",
                "session_id": str(uuid.uuid4())
            }
        }
        print(f"[{datetime.now().strftime('%H:%M:%S')}] → Sending agent.chat")
        await ws.send(json.dumps(chat_msg))
        
        # Wait for chat response (initial ack)
        try:
            response = await asyncio.wait_for(ws.recv(), timeout=5.0)
            data = json.loads(response)
            print(f"[{datetime.now().strftime('%H:%M:%S')}] ← Chat ack: {data}")
        except asyncio.TimeoutError:
            print(f"[{datetime.now().strftime('%H:%M:%S')}] ✗ Timeout waiting for chat ack (should receive immediately)")
            return
        
        # Step 3: Listen for task.started and ui.textContent
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Waiting for response messages...")
        timeout_count = 0
        while timeout_count < 3:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=10.0)
                data = json.loads(msg)
                method = data.get("method")
                print(f"[{datetime.now().strftime('%H:%M:%S')}] ← {method}: {str(data)[:150]}")
                
                if method == "task.completed" or (method == "ui.textContent" and data.get("params", {}).get("is_final")):
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] Task finished!")
                    break
                    
            except asyncio.TimeoutError:
                timeout_count += 1
                print(f"[{datetime.now().strftime('%H:%M:%S')}] ✗ No message received (timeout {timeout_count}/3)")
                if timeout_count >= 3:
                    print(f"[{datetime.now().strftime('%H:%M:%S')}] DEADLOCK DETECTED: Agent not responding")
                    break
        
        print(f"[{datetime.now().strftime('%H:%M:%S')}] Test complete")

if __name__ == "__main__":
    try:
        asyncio.run(test_agent())
    except KeyboardInterrupt:
        print("Interrupted")
    except Exception as e:
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
