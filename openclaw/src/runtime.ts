import { createPluginRuntimeStore } from "openclaw/plugin-sdk/compat";
import type { PluginRuntime } from "openclaw/plugin-sdk/msteams";

const { setRuntime: setShepawRuntime, getRuntime: getShepawRuntime } =
  createPluginRuntimeStore<PluginRuntime>("Shepaw runtime not initialized");

export { getShepawRuntime, setShepawRuntime };
