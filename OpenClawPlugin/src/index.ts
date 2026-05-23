// OpenClaw plugin entry. The runtime imports this module and calls the
// exported registration function during plugin activation (see
// openclaw.plugin.json -> activation.onStartup).
export { registerPaperclipBridgePlugin as register } from "./plugin.js";
export { registerPaperclipBridgePlugin } from "./plugin.js";
