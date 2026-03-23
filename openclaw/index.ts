import type { OpenClawPluginApi } from "openclaw/plugin-sdk/msteams";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk/msteams";
import { shepawPlugin } from "./src/channel.js";
import { setShepawRuntime } from "./src/runtime.js";

const plugin = {
  id: "shepaw",
  name: "Shepaw",
  description: "Shepaw channel plugin — Remote LLM Agent via ACP WebSocket",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setShepawRuntime(api.runtime);
    api.registerChannel({ plugin: shepawPlugin });
  },
};

export default plugin;
