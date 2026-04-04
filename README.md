# PAW Agent Bridge 🤖

**PAW Agent Bridge** 是一个为 Shepaw 应用构建远端智能体的完整解决方案框架。它基于 **paw_acp_sdk** （ACP 协议 SDK）提供的基础通信层，使得任何 Python 或 TypeScript 应用都能无缝接入 Shepaw 生态。

## 📋 核心组成

### 1. **paw_acp_sdk** - ACP 协议核心 SDK
Python 包，提供与 Shepaw 应用通信的基础设施：

```
paw_acp_sdk/
├── server.py              # ACPAgentServer - WebSocket 生命周期管理
├── task_context.py        # TaskContext - 高级消息发送接口
├── providers.py           # LLM 提供商集成 (OpenAI, Claude, GLM 等)
├── tunnel.py              # Channel Tunnel - 公网穿透支持
├── types.py               # 数据类型定义
├── conversation.py        # 会话历史管理
├── directive_parser.py    # 流式指令解析
├── jsonrpc.py            # JSON-RPC 2.0 消息构建
└── utils.py              # 工具函数
```

**关键特性：**
- 📡 基于 WebSocket 的双向通信
- 🔐 Token 认证
- 📊 流式响应（支持实时文本和 UI 组件）
- 🔄 会话历史自动管理
- 🌐 可选公网穿透（Channel Tunnel）
- 🛠️ 多 LLM 提供商支持

### 2. **Agent 实现**
生产级别的智能体实现案例：

#### **claude_code_agent** - Claude Code 工程助手
将 Claude Code IDE 环境暴露到移动端，支持：
- 📝 文件编辑和浏览
- 💻 Bash 命令执行
- 🔍 代码搜索和分析
- 📋 权限控制（plan/acceptEdits/bypassPermissions）

#### **mac_agent** - macOS 系统助手
完整的系统级智能体，支持：
- 🗂️ 文件系统操作
- 💾 系统命令执行
- 🔧 应用集成
- 🤖 多 LLM 后端支持

### 3. **openclaw** - TypeScript 插件（预留）
用于 TypeScript/Node.js 生态的智能体接入方案

## 🚀 快速开始

### 安装 SDK

```bash
# 安装 paw_acp_sdk
pip install -e paw_acp_sdk/

# 或直接从项目安装开发版本
cd paw_acp_sdk && pip install -e .
```

### 最小示例 - Echo Agent

```python
from paw_acp_sdk import ACPAgentServer, TaskContext

class MyAgent(ACPAgentServer):
    async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
        """处理用户消息"""
        await ctx.send_text(f"You said: {message}")

if __name__ == "__main__":
    agent = MyAgent(
        name="Echo Agent",
        description="Simple echo agent",
        token="my-secret-token"
    )
    agent.run(port=8080)
```

启动并连接到 Shepaw：
```bash
python my_agent.py
# 访问 ws://127.0.0.1:8080/ws
```

### 完整示例 - LLM 智能体

```python
from paw_acp_sdk import ACPAgentServer, TaskContext
from paw_acp_sdk.providers import OpenAIProvider
from paw_acp_sdk.directive_parser import ACPDirectiveStreamParser

class LLMAgent(ACPAgentServer):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.llm = OpenAIProvider(
            api_key="sk-...",
            model="gpt-4o",
            base_url="https://api.openai.com/v1"
        )
    
    async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
        """使用 LLM 处理消息"""
        parser = ACPDirectiveStreamParser()
        
        # 流式调用 LLM
        async for chunk in self.llm.stream_chat(
            messages=[{"role": "user", "content": message}],
            system_prompt="You are a helpful assistant."
        ):
            # 解析指令和文本
            for event in parser.feed(chunk):
                if hasattr(event, 'content'):  # 文本块
                    await ctx.send_text(event.content)
                elif hasattr(event, 'directive_type'):  # 指令
                    # 处理 UI 指令
                    pass
        
        # 保存到历史记录
        self.save_reply_to_history(ctx.session_id, "reply_content")

if __name__ == "__main__":
    agent = LLMAgent(
        name="LLM Assistant",
        description="An AI assistant powered by LLM",
        token="secret"
    )
    agent.run(port=8080)
```

## 🔌 集成新的智能体 - 完整指南

### Step 1: 定义智能体类

```python
from paw_acp_sdk import ACPAgentServer, TaskContext, AgentCard

class MyCustomAgent(ACPAgentServer):
    def get_agent_card(self) -> AgentCard:
        """定义智能体元数据"""
        return AgentCard(
            agent_id="my-agent",
            name="My Custom Agent",
            description="A powerful AI agent for X tasks",
            version="1.0.0",
            capabilities=["chat", "streaming", "tool_use"],
            supported_protocols=["acp"]
        )
    
    async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
        """核心处理逻辑"""
        pass
```

### Step 2: 实现处理逻辑

```python
async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
    """
    处理用户消息
    
    Args:
        ctx: TaskContext - 用于发送消息和组件
        message: str - 用户输入消息
        **kwargs: 其他参数（session_id 等）
    """
    # 标记任务已开始
    await ctx.started()
    
    try:
        # 1. 发送流式文本
        await ctx.send_text("Processing your request...")
        
        # 2. 发送交互式 UI 组件
        response = await ctx.send_action_confirmation(
            prompt="Do you want to proceed?",
            actions=["Yes", "No"]
        )
        
        if response == "Yes":
            # 3. 执行操作并发送结果
            result = await self.do_something()
            await ctx.send_text(result)
        
        # 4. 标记任务完成
        await ctx.completed()
    
    except Exception as e:
        await ctx.error(f"Error: {str(e)}")
```

### Step 3: 支持的 UI 组件

TaskContext 提供的交互式组件：

```python
# ✅ 确认对话框
await ctx.send_action_confirmation(
    prompt="Continue?",
    actions=["Confirm", "Cancel"]
)

# 📝 单选列表
await ctx.send_single_select(
    prompt="Choose one:",
    options=[{"label": "Option A", "value": "a"}, ...]
)

# ☑️ 多选列表
await ctx.send_multi_select(
    prompt="Choose multiple:",
    options=[...],
    min_select=1,
    max_select=3
)

# 📤 文件上传
await ctx.send_file_upload(
    prompt="Upload a file:",
    accept_types=[".txt", ".pdf"],
    max_files=1,
    max_size_mb=10
)

# 📋 表单
await ctx.send_form(
    title="Configuration",
    fields=[
        {"name": "username", "type": "text", "label": "Username"},
        {"name": "password", "type": "password", "label": "Password"},
    ]
)

# 📎 文件消息
await ctx.send_file_message(
    url="https://example.com/file.pdf",
    filename="document.pdf",
    mime_type="application/pdf",
    size=1024000
)
```

### Step 4: 集成 LLM

```python
from paw_acp_sdk.providers import OpenAIProvider, ClaudeProvider, GLMProvider

# OpenAI 兼容 API
llm = OpenAIProvider(
    api_key="sk-...",
    model="gpt-4o",
    base_url="https://api.openai.com/v1"
)

# Anthropic Claude
llm = ClaudeProvider(
    api_key="sk-ant-...",
    model="claude-opus"
)

# ZhipuAI GLM
llm = GLMProvider(
    api_key="xxx.yyy",  # 格式: {id}.{secret}
    model="glm-4"
)

# 流式调用
async for chunk in llm.stream_chat(
    messages=[{"role": "user", "content": "Hello"}],
    system_prompt="You are helpful"
):
    print(chunk)
```

### Step 5: 配置会话历史

```python
from paw_acp_sdk.conversation import ConversationManager

# 自动管理会话历史
manager = ConversationManager(max_history=20)

# 在 on_chat 中使用
messages = self.conversation.get_messages(ctx.session_id)
```

### Step 6: 启用公网穿透（可选）

```python
from paw_acp_sdk.tunnel import ChannelTunnelConfig

# 配置隧道
tunnel_config = ChannelTunnelConfig(
    server_url="https://tunnel.example.com",
    channel_id="my-channel-123",
    secret="my-secret",
    channel_endpoint="my-agent"
)

# 启动本地服务 + 公网穿透
agent = MyAgent(...)
await agent.run_with_tunnel(tunnel_config, port=8080)
```

环境变量配置：
```bash
export PAW_ACP_TUNNEL_SERVER_URL="https://tunnel.example.com"
export PAW_ACP_TUNNEL_CHANNEL_ID="my-channel"
export PAW_ACP_TUNNEL_SECRET="secret"
export PAW_ACP_LOCAL_PORT=8080
export PAW_ACP_TOKEN="agent-token"

python my_agent.py  # 自动从环境变量读取
```

## 📚 ACP 协议概览

ACP (Agent Communication Protocol) = **JSON-RPC 2.0 over WebSocket (RFC 6455)**

### 核心消息类型

| 方向 | 方法 | 说明 |
|------|------|------|
| 📥 | `agent.chat` | 应用发送用户消息 |
| 📥 | `agent.getCard` | 获取智能体元数据 |
| 📥 | `auth.authenticate` | 认证请求 |
| 📥 | `agent.cancelTask` | 取消当前任务 |
| 📥 | `agent.submitResponse` | 提交 UI 组件响应 |
| 📥 | `agent.rollback` | 撤销上一条消息 |
| 📤 | `ui.textContent` | 发送流式文本（`is_final` 标记） |
| 📤 | `ui.actionConfirmation` | 确认对话框 |
| 📤 | `ui.singleSelect` | 单选列表 |
| 📤 | `ui.multiSelect` | 多选列表 |
| 📤 | `ui.fileUpload` | 文件上传 |
| 📤 | `ui.form` | 表单 |
| 📤 | `ui.fileMessage` | 文件消息 |
| 📤 | `task.started` | 任务开始 |
| 📤 | `task.completed` | 任务完成 |
| 📤 | `task.error` | 任务错误 |

### 认证

智能体支持两种认证方式：

```python
# 方式1：HTTP Header（推荐）
# Authorization: Bearer your-secret-token

# 方式2：JSON-RPC 方法
# {"method": "auth.authenticate", "params": {"token": "your-secret-token"}}

# 禁用认证
agent = MyAgent(token="")
```

## 🏗️ 项目结构

```
agent-bridge/
├── README.md                           # 本文件
├── paw_acp_sdk/                        # 核心 SDK
│   ├── paw_acp_sdk/
│   │   ├── __init__.py                # 公共 API
│   │   ├── server.py                  # ACPAgentServer 基类
│   │   ├── task_context.py            # 任务消息接口
│   │   ├── providers.py               # LLM 提供商
│   │   ├── tunnel.py                  # 公网穿透
│   │   ├── conversation.py            # 会话管理
│   │   ├── directive_parser.py        # 指令解析
│   │   ├── types.py                   # 数据类型
│   │   ├── jsonrpc.py                 # JSON-RPC 工具
│   │   └── utils.py                   # 工具函数
│   ├── examples/
│   │   ├── echo_agent.py              # 最小示例
│   │   ├── llm_agent_example.py       # LLM 示例
│   │   └── tunnel_agent_example.py    # 隧道示例
│   └── pyproject.toml
│
├── claude_code/
│   └── claude_code_agent.py           # Claude Code IDE 桥接
│
├── mac_agent/
│   ├── mac_agent.py                   # macOS 系统智能体
│   ├── llm_agent.py                   # LLM 基类
│   ├── mac_tools.py                   # macOS 工具库
│   └── README.md
│
├── openclaw/                          # TypeScript/Node.js 支持（预留）
│   ├── package.json
│   ├── src/
│   └── index.ts
│
└── test_*.py                          # 集成测试
```

## 🛠️ 现有实现

### 1. Claude Code Agent (`claude_code/claude_code_agent.py`)

将 Claude Code 工程环境集成到 Shepaw：

```bash
python claude_code_agent.py \
  --cwd /path/to/project \
  --port 8090 \
  --token secret \
  --model claude-sonnet-4-20250514
```

**功能：**
- 📝 代码编辑和预览
- 🔍 符号搜索
- 💻 Bash 执行
- 📊 权限模式控制

### 2. Mac Agent (`mac_agent/mac_agent.py`)

完整的 macOS 系统助手：

```bash
python mac_agent.py \
  --provider openai \
  --model gpt-4o \
  --api-key sk-...
```

**支持的 LLM：**
- OpenAI (GPT-4, GPT-4o)
- Claude (Anthropic)
- GLM (ZhipuAI)

## 🎯 快速集成 - Claude Code 和 OpenClaw

### 为 Claude Code 添加 Shepaw 支持

```python
# claude_code/claude_code_agent.py 中
from paw_acp_sdk import ACPAgentServer, TaskContext
from claude_agent_sdk import ClaudeAgentClient

class ClaudeCodeAgent(ACPAgentServer):
    def __init__(self, cwd: str, model: str, **kwargs):
        super().__init__(**kwargs)
        self.client = ClaudeAgentClient(cwd=cwd, model=model)
    
    async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
        async for chunk in self.client.stream_chat(message):
            await ctx.send_text(chunk)

# 启动
agent = ClaudeCodeAgent(
    name="Claude Code",
    description="Claude Code IDE Bridge",
    cwd="/path/to/project",
    model="claude-sonnet-4-20250514"
)
agent.run(port=8090)
```

### 为 OpenClaw 添加 ACP 支持

```typescript
// openclaw/src/index.ts
import { ACPBridge } from 'paw-acp-sdk-ts';

interface OpenClawAgent {
  execute(command: string): Promise<string>;
}

class OpenClawACPAgent extends ACPBridge {
  private agent: OpenClawAgent;
  
  async onChat(message: string): Promise<void> {
    const result = await this.agent.execute(message);
    await this.sendText(result);
  }
}

export default OpenClawACPAgent;
```

## 📖 高级特性

### 1. 自定义 HTTP 路由

```python
class MyAgent(ACPAgentServer):
    def get_extra_routes(self) -> List[tuple]:
        return [
            ("GET", "/api/status", self.handle_status),
            ("POST", "/api/webhook", self.handle_webhook),
        ]
    
    async def handle_status(self, request):
        return aiohttp.web.json_response({"status": "ok"})
```

### 2. Hub 通信（与 Shepaw 应用交互）

```python
async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
    # 向 Hub 请求数据
    capabilities = await ctx.hub_request(
        method="hub.getCapabilities",
        params={},
        timeout=10
    )
    
    await ctx.send_text(f"Hub capabilities: {capabilities}")
```

### 3. 指令流解析（LLM 输出结构化）

```python
from paw_acp_sdk.directive_parser import ACPDirectiveStreamParser

parser = ACPDirectiveStreamParser()

async for chunk in llm_stream:
    for event in parser.feed(chunk):
        if isinstance(event, ACPTextChunk):
            await ctx.send_text(event.content)
        elif isinstance(event, ACPDirective):
            # 处理结构化指令
            if event.directive_type == "action_confirmation":
                await ctx.send_action_confirmation(**event.payload)
```

### 4. 会话历史回滚

```python
async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
    if message == "/undo":
        self.conversation.rollback(ctx.session_id)
        await ctx.send_text("Last message undone")
```

## 🔐 安全性

- ✅ **Token 认证**：使用 Bearer Token 或 JSON-RPC 认证
- ✅ **HTTPS + WSS**：支持安全的 WebSocket 连接
- ✅ **隔离会话**：每个连接独立的会话历史
- ✅ **权限控制**：支持 plan/acceptEdits/bypassPermissions 模式

## 📝 许可证

MIT License

## 🤝 贡献

欢迎提交问题和拉取请求！

## 📞 支持

- 📚 查看 `examples/` 中的完整示例
- 🔍 参考 `paw_acp_sdk/` 中的 API 文档
- 💬 联系项目维护者

---

**PAW Agent Bridge** - 让任何 AI 应用接入 Shepaw 生态 🚀
