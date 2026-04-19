# PAW ACP SDK - 完整 API 参考

## 目录

1. [核心服务器 - ACPAgentServer](#核心服务器---acpagentserver)
2. [任务上下文 - TaskContext](#任务上下文---taskcontext)
3. [数据类型 - Types](#数据类型---types)
4. [LLM 提供商 - Providers](#llm-提供商---providers)
5. [会话管理 - ConversationManager](#会话管理---conversationmanager)
6. [网络穿透 - Tunnel](#网络穿透---tunnel)
7. [指令解析 - DirectiveParser](#指令解析---directiveparser)
8. [JSON-RPC 工具 - JSONRPC](#json-rpc-工具---jsonrpc)
9. [工具函数 - Utils](#工具函数---utils)

---

## 核心服务器 - ACPAgentServer

### 类：`ACPAgentServer`

所有 ACP 智能体的基类。管理 WebSocket 连接、认证、消息路由和对话历史。

#### 初始化

```python
class ACPAgentServer:
    def __init__(
        self,
        name: str,
        token: str = "",
        agent_id: str = "default-agent",
        description: str = "",
        system_prompt: str = "",
        max_history: int = 20,
        history_ttl_seconds: int = 72 * 3600,
        enable_conversation_history: bool = True
    )
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `name` | str | 智能体名称 | 必需 |
| `token` | str | 认证令牌（空字符串禁用认证） | `""` |
| `agent_id` | str | 唯一的智能体标识符 | `"default-agent"` |
| `description` | str | 智能体描述 | `""` |
| `system_prompt` | str | LLM 系统提示词 | `""` |
| `max_history` | int | 最大会话轮数 | `20` |
| `history_ttl_seconds` | int | 会话过期时间（秒） | `72 * 3600` |
| `enable_conversation_history` | bool | 是否启用历史记录 | `True` |

**示例：**
```python
agent = ACPAgentServer(
    name="My Assistant",
    token="secret-key-123",
    agent_id="my-agent",
    description="A helpful AI assistant",
    system_prompt="You are a helpful assistant."
)
```

#### 重写方法

##### `on_chat(ctx, message, **kwargs)`

处理用户消息的核心方法。**必须重写**。

```python
async def on_chat(
    self, 
    ctx: TaskContext, 
    message: str, 
    **kwargs
) -> None
```

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `ctx` | TaskContext | 任务上下文，用于发送消息 |
| `message` | str | 用户输入的消息 |
| `**kwargs` | dict | 额外参数（包含 `session_id` 等） |

**异常处理：**
- 未捕获的异常自动转换为 `task.error` 通知

**示例：**
```python
class MyAgent(ACPAgentServer):
    async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
        await ctx.send_text(f"You said: {message}")
        await ctx.completed()
```

##### `get_agent_card()`

返回智能体的元数据。可选重写。

```python
def get_agent_card(self) -> AgentCard
```

**返回：** `AgentCard` 对象

**示例：**
```python
def get_agent_card(self) -> AgentCard:
    return AgentCard(
        agent_id="my-agent",
        name="My Agent",
        description="Description here",
        version="1.0.0",
        capabilities=["chat", "streaming"],
        supported_protocols=["acp"]
    )
```

##### `get_extra_routes()`

定义自定义 HTTP 路由。可选重写。

```python
def get_extra_routes(self) -> List[tuple]
```

**返回：** 路由元组列表 `[(method, path, handler), ...]`

**示例：**
```python
def get_extra_routes(self) -> List[tuple]:
    return [
        ("GET", "/api/status", self.handle_status),
        ("POST", "/webhook", self.handle_webhook),
    ]

async def handle_status(self, request):
    return aiohttp.web.json_response({"status": "running"})
```

##### `on_request_file_data(session_id, file_id)`

处理文件传输请求。可选重写。

```python
async def on_request_file_data(
    self, 
    session_id: str, 
    file_id: str
) -> Optional[bytes]
```

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `session_id` | str | 会话 ID |
| `file_id` | str | 文件标识符 |

**返回：** 文件内容字节，或 `None` 如果文件不存在

**示例：**
```python
async def on_request_file_data(self, session_id: str, file_id: str):
    if file_id == "document.pdf":
        with open("document.pdf", "rb") as f:
            return f.read()
    return None
```

#### 实例方法

##### `save_reply_to_history(session_id, reply)`

保存助手回复到会话历史。

```python
def save_reply_to_history(self, session_id: str, reply: str) -> None
```

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `session_id` | str | 会话 ID |
| `reply` | str | 助手回复内容 |

**说明：** 自动替换回复中的指令块为摘要。

**示例：**
```python
await ctx.send_text("Processing...")
self.save_reply_to_history(ctx.session_id, "Completed successfully")
```

##### `create_app()`

创建 aiohttp 应用对象。

```python
def create_app(self) -> aiohttp.web.Application
```

**返回：** aiohttp 应用实例

**说明：** 内部使用，通常无需直接调用。

#### 启动方法

##### `run(host='127.0.0.1', port=8080, log_startup=True)`

同步启动本地服务器。

```python
def run(
    self, 
    host: str = '127.0.0.1', 
    port: int = 8080,
    log_startup: bool = True
) -> None
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `host` | str | 监听地址 | `'127.0.0.1'` |
| `port` | int | 监听端口 | `8080` |
| `log_startup` | bool | 打印启动信息 | `True` |

**示例：**
```python
agent = MyAgent(name="Test", token="secret")
agent.run(port=8080)  # 阻塞运行
```

##### `run_with_tunnel(tunnel_config, host='127.0.0.1', port=8080, log_startup=True)`

启动本地服务器并启用公网穿透。

```python
def run_with_tunnel(
    self,
    tunnel_config: ChannelTunnelConfig,
    host: str = '127.0.0.1',
    port: int = 8080,
    log_startup: bool = True
) -> None
```

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `tunnel_config` | ChannelTunnelConfig | 隧道配置 |
| `host` | str | 本地监听地址 |
| `port` | int | 本地监听端口 |
| `log_startup` | bool | 打印启动信息 |

**示例：**
```python
config = ChannelTunnelConfig(
    server_url="https://tunnel.example.com",
    channel_id="ch-123",
    secret="secret"
)
agent.run_with_tunnel(config, port=8080)
```

---

## 任务上下文 - TaskContext

### 类：`TaskContext`

在处理单个任务时使用的高级接口。由 `on_chat()` 方法接收。

#### 属性

```python
@property
def task_id(self) -> str
    """当前任务 ID"""

@property
def session_id(self) -> str
    """当前会话 ID"""

@property
def user_message(self) -> str
    """原始用户消息"""
```

#### 流式文本方法

##### `send_text(content)`

发送文本块（用于流式响应）。

```python
async def send_text(self, content: str) -> None
```

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `content` | str | 文本内容 |

**说明：** 可多次调用。最后一个块应通过 `send_text_final()` 发送。

**示例：**
```python
async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
    async for chunk in llm_stream:
        await ctx.send_text(chunk)
```

##### `send_text_final(content="")`

发送最后的文本块并标记流结束。

```python
async def send_text_final(self, content: str = "") -> None
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `content` | str | 最后的文本内容 | `""` |

**示例：**
```python
await ctx.send_text("Processing complete")
await ctx.send_text_final()
```

#### 任务生命周期方法

##### `started()`

标记任务已开始。

```python
async def started(self) -> None
```

**示例：**
```python
async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
    await ctx.started()
    # ... 处理逻辑 ...
```

##### `completed()`

标记任务已完成。

```python
async def completed(self) -> None
```

**示例：**
```python
result = await self.process(message)
await ctx.send_text(result)
await ctx.completed()
```

##### `error(message)`

标记任务失败并发送错误消息。

```python
async def error(self, message: str) -> None
```

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `message` | str | 错误消息 |

**示例：**
```python
try:
    result = await process()
except Exception as e:
    await ctx.error(f"Processing failed: {str(e)}")
```

#### UI 组件方法

##### `send_action_confirmation(prompt, actions)`

发送是/否确认对话框。

```python
async def send_action_confirmation(
    self,
    prompt: str,
    actions: List[str]
) -> str
```

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `prompt` | str | 确认提示文本 |
| `actions` | List[str] | 操作按钮列表（通常 2 项） |

**返回：** 用户选择的操作字符串

**示例：**
```python
result = await ctx.send_action_confirmation(
    prompt="Delete this file?",
    actions=["Confirm", "Cancel"]
)
if result == "Confirm":
    await delete_file()
```

##### `send_single_select(prompt, options)`

发送单选列表。

```python
async def send_single_select(
    self,
    prompt: str,
    options: List[Dict[str, str]]
) -> str
```

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `prompt` | str | 选择提示文本 |
| `options` | List[Dict] | 选项列表，每项包含 `label` 和 `value` |

**返回：** 用户选择的值

**示例：**
```python
choice = await ctx.send_single_select(
    prompt="Choose an option:",
    options=[
        {"label": "Option A", "value": "a"},
        {"label": "Option B", "value": "b"},
        {"label": "Option C", "value": "c"},
    ]
)
```

##### `send_multi_select(prompt, options, min_select=1, max_select=None)`

发送多选列表。

```python
async def send_multi_select(
    self,
    prompt: str,
    options: List[Dict[str, str]],
    min_select: int = 1,
    max_select: Optional[int] = None
) -> List[str]
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `prompt` | str | 选择提示文本 | - |
| `options` | List[Dict] | 选项列表 | - |
| `min_select` | int | 最少选择数 | `1` |
| `max_select` | int | 最多选择数 | `None`（无限） |

**返回：** 用户选择的值列表

**示例：**
```python
selected = await ctx.send_multi_select(
    prompt="Choose items:",
    options=[
        {"label": "Item 1", "value": "item1"},
        {"label": "Item 2", "value": "item2"},
        {"label": "Item 3", "value": "item3"},
    ],
    min_select=1,
    max_select=2
)
```

##### `send_file_upload(prompt, accept_types, max_files=1, max_size_mb=10)`

发送文件上传对话框。

```python
async def send_file_upload(
    self,
    prompt: str,
    accept_types: List[str],
    max_files: int = 1,
    max_size_mb: int = 10
) -> List[Dict[str, Any]]
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `prompt` | str | 上传提示文本 | - |
| `accept_types` | List[str] | 接受的文件类型（如 `[".pdf", ".txt"]`） | - |
| `max_files` | int | 最多上传文件数 | `1` |
| `max_size_mb` | int | 最大文件大小（MB） | `10` |

**返回：** 文件列表，每个文件包含 `name`, `size`, `type`, `data`

**示例：**
```python
files = await ctx.send_file_upload(
    prompt="Upload documents:",
    accept_types=[".pdf", ".txt", ".doc"],
    max_files=5,
    max_size_mb=50
)
for file in files:
    print(f"Received: {file['name']} ({file['size']} bytes)")
```

##### `send_form(title, fields, description="")`

发送表单。

```python
async def send_form(
    self,
    title: str,
    fields: List[Dict[str, Any]],
    description: str = ""
) -> Dict[str, Any]
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `title` | str | 表单标题 | - |
| `fields` | List[Dict] | 表单字段列表 | - |
| `description` | str | 表单描述 | `""` |

**字段格式：**
```python
{
    "name": "username",           # 字段名
    "label": "Username",          # 显示标签
    "type": "text",               # 字段类型: text, password, email, number, textarea
    "required": True,             # 是否必填
    "placeholder": "Enter name",  # 占位符
    "default": "",                # 默认值
}
```

**返回：** 表单数据字典

**示例：**
```python
form_data = await ctx.send_form(
    title="Configuration",
    description="Please fill in the configuration",
    fields=[
        {
            "name": "username",
            "label": "Username",
            "type": "text",
            "required": True,
            "placeholder": "user@example.com"
        },
        {
            "name": "password",
            "label": "Password",
            "type": "password",
            "required": True
        },
        {
            "name": "options",
            "label": "Additional Options",
            "type": "textarea",
            "placeholder": "Enter options..."
        }
    ]
)
print(f"Username: {form_data['username']}")
```

##### `send_file_message(url, filename, mime_type, size)`

发送文件消息（下载链接）。

```python
async def send_file_message(
    self,
    url: str,
    filename: str,
    mime_type: str,
    size: int
) -> None
```

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `url` | str | 文件下载 URL |
| `filename` | str | 文件名 |
| `mime_type` | str | 文件 MIME 类型（如 `"application/pdf"`） |
| `size` | int | 文件大小（字节） |

**示例：**
```python
await ctx.send_file_message(
    url="https://example.com/document.pdf",
    filename="document.pdf",
    mime_type="application/pdf",
    size=1024000
)
```

##### `send_message_metadata(collapsible=False, title="", auto_collapse=False)`

设置消息显示属性（可折叠、标题等）。

```python
async def send_message_metadata(
    self,
    collapsible: bool = False,
    title: str = "",
    auto_collapse: bool = False
) -> None
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `collapsible` | bool | 是否可折叠 | `False` |
| `title` | str | 消息标题 | `""` |
| `auto_collapse` | bool | 是否自动折叠 | `False` |

**示例：**
```python
await ctx.send_message_metadata(
    collapsible=True,
    title="Execution Details",
    auto_collapse=True
)
await ctx.send_text("Detailed output here...")
```

#### Hub 通信方法

##### `hub_request(method, params, timeout=30)`

向 Shepaw Hub 发送请求并等待响应。

```python
async def hub_request(
    self,
    method: str,
    params: Dict[str, Any],
    timeout: int = 30
) -> Any
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `method` | str | JSON-RPC 方法名 | - |
| `params` | Dict | 方法参数 | - |
| `timeout` | int | 响应超时（秒） | `30` |

**返回：** Hub 返回的结果

**异常：** 超时时抛出 `TimeoutError`

**示例：**
```python
capabilities = await ctx.hub_request(
    method="hub.getCapabilities",
    params={"filter": "file-system"}
)
print(f"Available: {capabilities}")
```

##### `wait_for_response(component_id, timeout=30)`

等待交互式 UI 组件的响应。

```python
async def wait_for_response(
    self,
    component_id: str,
    timeout: int = 30
) -> Any
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `component_id` | str | 组件 ID | - |
| `timeout` | int | 等待超时（秒） | `30` |

**返回：** 用户提交的响应

**异常：** 超时时抛出 `TimeoutError`

---

## 数据类型 - Types

### 数据类

#### `ACPTextChunk`

表示文本流的一个块。

```python
@dataclass
class ACPTextChunk:
    content: str
```

**属性：**

| 属性 | 类型 | 说明 |
|------|------|------|
| `content` | str | 文本内容 |

#### `ACPDirective`

表示解析出的指令块。

```python
@dataclass
class ACPDirective:
    directive_type: str
    payload: dict
```

**属性：**

| 属性 | 类型 | 说明 |
|------|------|------|
| `directive_type` | str | 指令类型（如 `"action_confirmation"`） |
| `payload` | dict | 指令数据 |

#### `AgentCard`

智能体元数据。

```python
@dataclass
class AgentCard:
    agent_id: str
    name: str
    description: str = ""
    version: str = "1.0.0"
    capabilities: List[str] = field(default_factory=lambda: ["chat", "streaming"])
    supported_protocols: List[str] = field(default_factory=lambda: ["acp"])
```

**属性：**

| 属性 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `agent_id` | str | 唯一标识符 | - |
| `name` | str | 显示名称 | - |
| `description` | str | 描述 | `""` |
| `version` | str | 版本 | `"1.0.0"` |
| `capabilities` | List[str] | 能力列表 | `["chat", "streaming"]` |
| `supported_protocols` | List[str] | 支持的协议 | `["acp"]` |

#### `LLMToolCall`

LLM 工具调用。

```python
@dataclass
class LLMToolCall:
    id: str
    name: str
    arguments: dict
```

**属性：**

| 属性 | 类型 | 说明 |
|------|------|------|
| `id` | str | 调用 ID |
| `name` | str | 工具名称 |
| `arguments` | dict | 工具参数 |

#### `LLMStreamResult`

LLM 流式结果。

```python
@dataclass
class LLMStreamResult:
    text_content: str
    tool_calls: List[LLMToolCall]
```

**属性：**

| 属性 | 类型 | 说明 |
|------|------|------|
| `text_content` | str | 文本内容 |
| `tool_calls` | List[LLMToolCall] | 工具调用列表 |

---

## LLM 提供商 - Providers

### 基类：`LLMProvider`

所有 LLM 提供商的基类。

```python
class LLMProvider(ABC):
    @abstractmethod
    async def stream_chat(
        self,
        messages: List[Dict[str, str]],
        system_prompt: str = ""
    ) -> AsyncGenerator[str, None]
    
    @abstractmethod
    async def stream_chat_with_tools(
        self,
        messages: List[Dict[str, str]],
        system_prompt: str = "",
        tools: Optional[List[Dict]] = None,
        on_text_chunk: Optional[Callable] = None
    ) -> AsyncGenerator[LLMStreamResult, None]
```

#### 方法

##### `stream_chat(messages, system_prompt="")`

流式生成纯文本。

```python
async def stream_chat(
    self,
    messages: List[Dict[str, str]],
    system_prompt: str = ""
) -> AsyncGenerator[str, None]
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `messages` | List[Dict] | 消息列表（OpenAI 格式） | - |
| `system_prompt` | str | 系统提示词 | `""` |

**消息格式：**
```python
[
    {"role": "system", "content": "You are helpful"},
    {"role": "user", "content": "Hello"},
    {"role": "assistant", "content": "Hi there"},
    {"role": "user", "content": "What is 2+2?"},
]
```

**产生：** 文本块字符串

**示例：**
```python
async for chunk in llm.stream_chat(
    messages=[{"role": "user", "content": "Explain AI"}],
    system_prompt="Be concise"
):
    print(chunk, end="", flush=True)
```

##### `stream_chat_with_tools(messages, system_prompt="", tools=None, on_text_chunk=None)`

流式生成，支持工具调用。

```python
async def stream_chat_with_tools(
    self,
    messages: List[Dict[str, str]],
    system_prompt: str = "",
    tools: Optional[List[Dict]] = None,
    on_text_chunk: Optional[Callable] = None
) -> AsyncGenerator[LLMStreamResult, None]
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `messages` | List[Dict] | 消息列表 | - |
| `system_prompt` | str | 系统提示词 | `""` |
| `tools` | List[Dict] | 工具定义列表 | `None` |
| `on_text_chunk` | Callable | 文本块回调函数 | `None` |

**工具定义格式：**
```python
[
    {
        "name": "get_weather",
        "description": "Get weather for a location",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {"type": "string", "description": "City name"},
                "unit": {"type": "string", "enum": ["C", "F"]}
            },
            "required": ["location"]
        }
    }
]
```

**返回：** `LLMStreamResult` 对象流

**示例：**
```python
tools = [
    {
        "name": "search",
        "description": "Search the web",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"]
        }
    }
]

async for result in llm.stream_chat_with_tools(
    messages=[{"role": "user", "content": "What is the weather?"}],
    tools=tools
):
    if result.text_content:
        print(result.text_content, end="", flush=True)
    for tool_call in result.tool_calls:
        print(f"Calling {tool_call.name}({tool_call.arguments})")
```

### OpenAIProvider

OpenAI 兼容的 API（OpenAI, DeepSeek, Qwen, Ollama 等）。

```python
class OpenAIProvider(LLMProvider):
    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: str = "https://api.openai.com/v1",
        timeout: int = 300
    )
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `api_key` | str | API 密钥 | - |
| `model` | str | 模型名称 | - |
| `base_url` | str | API 基础 URL | `"https://api.openai.com/v1"` |
| `timeout` | int | 请求超时（秒） | `300` |

**支持的 API：**
- OpenAI: `gpt-4`, `gpt-4o`, `gpt-4-turbo` 等
- DeepSeek: `deepseek-chat` 等
- Qwen: `qwen-max`, `qwen-plus` 等
- Ollama: `llama2`, `mistral` 等
- vLLM: 任何已部署模型
- LM Studio: 本地部署模型

**示例：**
```python
# OpenAI
llm = OpenAIProvider(
    api_key="sk-...",
    model="gpt-4o",
    base_url="https://api.openai.com/v1"
)

# DeepSeek
llm = OpenAIProvider(
    api_key="sk-...",
    model="deepseek-chat",
    base_url="https://api.deepseek.com/v1"
)

# Ollama (本地)
llm = OpenAIProvider(
    api_key="fake",
    model="llama2",
    base_url="http://localhost:11434/v1"
)
```

### ClaudeProvider

Anthropic Claude API。

```python
class ClaudeProvider(LLMProvider):
    def __init__(
        self,
        api_key: str,
        model: str = "claude-opus",
        timeout: int = 300
    )
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `api_key` | str | Claude API 密钥 | - |
| `model` | str | 模型名称 | `"claude-opus"` |
| `timeout` | int | 请求超时（秒） | `300` |

**支持的模型：**
- `claude-opus`
- `claude-sonnet`
- `claude-haiku`

**示例：**
```python
llm = ClaudeProvider(
    api_key="sk-ant-...",
    model="claude-opus"
)
```

### GLMProvider

ZhipuAI GLM API。

```python
class GLMProvider(LLMProvider):
    def __init__(
        self,
        api_key: str,
        model: str = "glm-4",
        timeout: int = 300
    )
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `api_key` | str | GLM API 密钥（格式: `{id}.{secret}`） | - |
| `model` | str | 模型名称 | `"glm-4"` |
| `timeout` | int | 请求超时（秒） | `300` |

**支持的模型：**
- `glm-4`
- `glm-4.7`

**API 密钥格式：**

从 ZhipuAI 控制台获取的密钥格式为 `{id}.{secret}`，例如：
```
8f6c5c4a-b2d1-4e8f-9a3c-7b1f5e2d8c9a.7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f
```

**示例：**
```python
llm = GLMProvider(
    api_key="8f6c5c4a-b2d1-4e8f-9a3c-7b1f5e2d8c9a.7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f",
    model="glm-4"
)
```

---

## 会话管理 - ConversationManager

### 类：`ConversationManager`

管理每个会话的对话历史。

```python
class ConversationManager:
    def __init__(
        self,
        max_history: int = 20,
        max_age_seconds: int = 72 * 3600
    )
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `max_history` | int | 最大历史轮数 | `20` |
| `max_age_seconds` | int | 会话过期时间（秒） | `72 * 3600` |

#### 方法

##### `get_messages(session_id)`

获取会话的消息列表。

```python
def get_messages(self, session_id: str) -> List[Dict[str, str]]
```

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `session_id` | str | 会话 ID |

**返回：** 消息列表（OpenAI 格式）

**示例：**
```python
messages = conversation.get_messages("session-123")
for msg in messages:
    print(f"{msg['role']}: {msg['content']}")
```

##### `add_user_message(session_id, content)`

添加用户消息。

```python
def add_user_message(self, session_id: str, content: str) -> None
```

##### `add_assistant_message(session_id, content)`

添加助手消息。

```python
def add_assistant_message(self, session_id: str, content: str) -> None
```

**示例：**
```python
conversation.add_user_message("session-123", "What is AI?")
conversation.add_assistant_message("session-123", "AI is...")
```

##### `rollback(session_id)`

撤销上一条用户消息及其对应的助手回复。

```python
def rollback(self, session_id: str) -> None
```

**示例：**
```python
conversation.rollback("session-123")  # 移除最后一对消息
```

##### `has_session(session_id)`

检查是否存在会话。

```python
def has_session(self, session_id: str) -> bool
```

##### `initialize_session(session_id, history)`

用历史记录初始化新会话。

```python
def initialize_session(
    self, 
    session_id: str, 
    history: List[Dict[str, str]]
) -> None
```

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `session_id` | str | 会话 ID |
| `history` | List[Dict] | 初始历史消息列表 |

##### `prepend_history(session_id, older_messages)`

将旧消息添加到会话历史前面。

```python
def prepend_history(
    self, 
    session_id: str, 
    older_messages: List[Dict[str, str]]
) -> None
```

**示例：**
```python
# 从数据库加载旧消息
old_msgs = load_from_db(session_id)
conversation.prepend_history(session_id, old_msgs)
```

##### `cleanup_expired(max_age_seconds)`

清理过期的会话。

```python
def cleanup_expired(self, max_age_seconds: int) -> int
```

**返回：** 被清理的会话数量

---

## 网络穿透 - Tunnel

### 类：`ChannelTunnelConfig`

隧道配置。

```python
@dataclass
class ChannelTunnelConfig:
    server_url: str
    channel_id: str
    secret: str
    channel_endpoint: str = ""
    auto_connect: bool = True
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `server_url` | str | Channel Service HTTPS URL | - |
| `channel_id` | str | 唯一通道 ID | - |
| `secret` | str | 认证秘密 | - |
| `channel_endpoint` | str | 可选短名称端点 | `""` |
| `auto_connect` | bool | 自动连接 | `True` |

#### 方法

##### `get_public_endpoint(token, agent_id)`

获取公共 WebSocket 端点 URL。

```python
def get_public_endpoint(self, token: str, agent_id: str) -> str
```

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `token` | str | 认证令牌 |
| `agent_id` | str | 智能体 ID |

**返回：** WebSocket URL 字符串

**格式：**
```
wss://server_url/channels/{channel_id}/{channel_endpoint}?token={token}&agentId={agent_id}
```

**示例：**
```python
config = ChannelTunnelConfig(
    server_url="https://tunnel.example.com",
    channel_id="ch-123",
    secret="secret"
)
url = config.get_public_endpoint("token", "my-agent")
# wss://tunnel.example.com/channels/ch-123?token=token&agentId=my-agent
```

##### `to_dict()` / `from_dict(data)`

序列化/反序列化。

```python
def to_dict(self) -> dict
@classmethod
def from_dict(cls, data: dict) -> "ChannelTunnelConfig"
```

**示例：**
```python
config = ChannelTunnelConfig(...)
config_dict = config.to_dict()
restored = ChannelTunnelConfig.from_dict(config_dict)
```

### 类：`TunnelClient`

隧道客户端，连接到 Channel Service 并转发请求。

```python
class TunnelClient:
    def __init__(
        self,
        config: ChannelTunnelConfig,
        local_url: str,
        on_error: Optional[Callable] = None
    )
```

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `config` | ChannelTunnelConfig | 隧道配置 |
| `local_url` | str | 本地 ACP 服务器 URL（如 `"http://127.0.0.1:8080"`） |
| `on_error` | Callable | 错误回调函数 |

#### 方法

##### `start()`

启动隧道连接。

```python
async def start(self) -> None
```

**说明：** 启动后自动重连（指数退避）。

**异常：** 连接失败时调用 `on_error` 回调。

**示例：**
```python
client = TunnelClient(config, "http://127.0.0.1:8080")
await client.start()
```

##### `stop()`

停止隧道连接。

```python
async def stop(self) -> None
```

**示例：**
```python
await client.stop()
```

#### 隧道协议消息

隧道支持以下消息类型：

| 消息类型 | 方向 | 说明 |
|---------|------|------|
| `request` | Hub → Agent | HTTP 请求转发 |
| `response` | Agent → Hub | HTTP 响应 |
| `ws_connect` | Hub → Agent | WebSocket 连接请求 |
| `ws_data` | 双向 | WebSocket 数据帧（base64） |
| `ws_close` | 双向 | WebSocket 关闭 |
| `ping` | Hub → Agent | 心跳 |
| `pong` | Agent → Hub | 心跳应答 |
| `close` | 任意 | 关闭隧道 |

---

## 指令解析 - DirectiveParser

### 类：`ACPDirectiveStreamParser`

流式解析 LLM 输出中的指令块。

```python
class ACPDirectiveStreamParser:
    def __init__(self)
```

**指令语法：**
```
普通文本...
<<<directive
{"type": "action_confirmation", "prompt": "继续?", "actions": [...]}
>>>
更多文本...
```

#### 方法

##### `feed(chunk)`

输入数据块并获取已解析的事件。

```python
def feed(self, chunk: str) -> List[Union[ACPTextChunk, ACPDirective]]
```

**参数：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `chunk` | str | 文本块 |

**返回：** 事件列表（`ACPTextChunk` 或 `ACPDirective`）

**示例：**
```python
parser = ACPDirectiveStreamParser()

async for chunk in llm_stream:
    for event in parser.feed(chunk):
        if isinstance(event, ACPTextChunk):
            await ctx.send_text(event.content)
        elif isinstance(event, ACPDirective):
            print(f"Directive: {event.directive_type}")
```

##### `flush()`

处理剩余缓冲区并完成解析。

```python
def flush(self) -> List[Union[ACPTextChunk, ACPDirective]]
```

**说明：** 在流结束时调用，用于处理未完成的指令。

**示例：**
```python
async for chunk in llm_stream:
    for event in parser.feed(chunk):
        process(event)

# 流结束时
for event in parser.flush():
    process(event)
```

---

## JSON-RPC 工具 - JSONRPC

### 函数

#### `jsonrpc_response(id, result=None, error=None)`

构建 JSON-RPC 2.0 响应消息。

```python
def jsonrpc_response(
    id: Union[str, int],
    result: Optional[Any] = None,
    error: Optional[str] = None
) -> dict
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `id` | str/int | 请求 ID | - |
| `result` | Any | 成功结果 | `None` |
| `error` | str | 错误消息 | `None` |

**返回：** JSON-RPC 响应对象

**示例：**
```python
# 成功响应
response = jsonrpc_response(123, result={"status": "ok"})

# 错误响应
response = jsonrpc_response(123, error="Invalid request")
```

#### `jsonrpc_notification(method, params=None)`

构建 JSON-RPC 通知消息（无 ID）。

```python
def jsonrpc_notification(
    method: str,
    params: Optional[Any] = None
) -> dict
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `method` | str | 方法名 | - |
| `params` | Any | 参数 | `None` |

**返回：** JSON-RPC 通知对象

**示例：**
```python
notification = jsonrpc_notification(
    "task.started",
    params={"task_id": "task-123"}
)
```

#### `jsonrpc_request(method, params=None, id=None)`

构建 JSON-RPC 请求消息。

```python
def jsonrpc_request(
    method: str,
    params: Optional[Any] = None,
    id: Optional[Union[str, int]] = None
) -> dict
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `method` | str | 方法名 | - |
| `params` | Any | 参数 | `None` |
| `id` | str/int | 请求 ID | `None` |

**返回：** JSON-RPC 请求对象

**示例：**
```python
request = jsonrpc_request(
    "agent.chat",
    params={"message": "Hello"},
    id=1
)
```

---

## 工具函数 - Utils

### 函数

#### `acp_directive_to_notification(directive, task_id, component_method_map=None)`

将指令对象转换为 ACP 通知消息。

```python
def acp_directive_to_notification(
    directive: ACPDirective,
    task_id: str,
    component_method_map: Optional[Dict[str, str]] = None
) -> dict
```

**参数：**

| 参数 | 类型 | 说明 | 默认值 |
|------|------|------|--------|
| `directive` | ACPDirective | 指令对象 | - |
| `task_id` | str | 任务 ID | - |
| `component_method_map` | Dict | 指令类型到 ACP 方法的映射 | `None` |

**返回：** JSON-RPC 通知消息

**默认映射：**
```python
{
    "action_confirmation": "ui.actionConfirmation",
    "single_select": "ui.singleSelect",
    "multi_select": "ui.multiSelect",
    "file_upload": "ui.fileUpload",
    "form": "ui.form",
    # ...
}
```

**示例：**
```python
directive = ACPDirective(
    directive_type="action_confirmation",
    payload={"prompt": "Continue?", "actions": ["Yes", "No"]}
)
notification = acp_directive_to_notification(directive, "task-123")
```

---

## 完整集成示例

### 最小 Echo 智能体

```python
from paw_acp_sdk import ACPAgentServer, TaskContext

class EchoAgent(ACPAgentServer):
    async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
        await ctx.started()
        await ctx.send_text(f"You said: {message}")
        await ctx.completed()

if __name__ == "__main__":
    agent = EchoAgent(name="Echo", token="secret")
    agent.run(port=8080)
```

### LLM 智能体

```python
from paw_acp_sdk import ACPAgentServer, TaskContext
from paw_acp_sdk.providers import OpenAIProvider
from paw_acp_sdk.directive_parser import ACPDirectiveStreamParser

class LLMAgent(ACPAgentServer):
    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.llm = OpenAIProvider(
            api_key="sk-...",
            model="gpt-4o"
        )
    
    async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
        await ctx.started()
        parser = ACPDirectiveStreamParser()
        
        async for chunk in self.llm.stream_chat(
            messages=[
                {"role": "system", "content": self.system_prompt},
                {"role": "user", "content": message}
            ]
        ):
            for event in parser.feed(chunk):
                if hasattr(event, 'content'):
                    await ctx.send_text(event.content)
        
        for event in parser.flush():
            if hasattr(event, 'content'):
                await ctx.send_text(event.content)
        
        await ctx.completed()

if __name__ == "__main__":
    agent = LLMAgent(
        name="AI Assistant",
        token="secret",
        system_prompt="You are a helpful AI assistant."
    )
    agent.run(port=8080)
```

### 带公网穿透的智能体

```python
from paw_acp_sdk import ACPAgentServer, TaskContext, ChannelTunnelConfig
import os

class TunnelAgent(ACPAgentServer):
    async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
        await ctx.send_text(f"Processing: {message}")
        await ctx.completed()

if __name__ == "__main__":
    # 从环境变量读取配置
    tunnel_config = ChannelTunnelConfig(
        server_url=os.getenv("PAW_ACP_TUNNEL_SERVER_URL"),
        channel_id=os.getenv("PAW_ACP_TUNNEL_CHANNEL_ID"),
        secret=os.getenv("PAW_ACP_TUNNEL_SECRET"),
        channel_endpoint=os.getenv("PAW_ACP_TUNNEL_ENDPOINT", "")
    )
    
    agent = TunnelAgent(
        name="Tunnel Agent",
        token=os.getenv("PAW_ACP_TOKEN", "secret")
    )
    
    port = int(os.getenv("PAW_ACP_LOCAL_PORT", 8080))
    agent.run_with_tunnel(tunnel_config, port=port)
```

---

## 常见模式

### 模式 1: 异常处理

```python
async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
    try:
        await ctx.started()
        # 处理逻辑
        result = await process(message)
        await ctx.send_text(result)
        await ctx.completed()
    except Exception as e:
        import traceback
        await ctx.error(f"Error: {str(e)}\n{traceback.format_exc()}")
```

### 模式 2: 用户交互

```python
async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
    await ctx.started()
    
    # 请求确认
    action = await ctx.send_action_confirmation(
        prompt="Proceed with operation?",
        actions=["Yes", "No"]
    )
    
    if action == "Yes":
        # 执行操作
        await ctx.send_text("Operation completed")
    else:
        await ctx.send_text("Operation cancelled")
    
    await ctx.completed()
```

### 模式 3: 会话历史

```python
async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
    session_id = kwargs.get("session_id")
    
    # 获取历史
    messages = self.conversation.get_messages(session_id)
    
    # 调用 LLM
    async for chunk in self.llm.stream_chat(messages):
        await ctx.send_text(chunk)
    
    # 保存到历史
    self.save_reply_to_history(session_id, "reply content")
    
    await ctx.completed()
```

### 模式 4: Hub 通信

```python
async def on_chat(self, ctx: TaskContext, message: str, **kwargs):
    try:
        # 向 Hub 请求数据
        result = await ctx.hub_request(
            method="hub.executeCommand",
            params={"cmd": message},
            timeout=10
        )
        await ctx.send_text(f"Result: {result}")
    except TimeoutError:
        await ctx.error("Hub request timeout")
    
    await ctx.completed()
```

---

## 环境变量参考

当使用环境变量配置时：

```bash
# 隧道配置
export PAW_ACP_TUNNEL_SERVER_URL="https://tunnel.example.com"
export PAW_ACP_TUNNEL_CHANNEL_ID="ch-123"
export PAW_ACP_TUNNEL_SECRET="secret"
export PAW_ACP_TUNNEL_ENDPOINT="my-agent"

# 服务器配置
export PAW_ACP_LOCAL_PORT=8080
export PAW_ACP_TOKEN="agent-token"

# LLM 配置
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="gpt-4o"
```

---

**最后更新：** 2025-03-24

**版本：** paw_acp_sdk 0.1.0
