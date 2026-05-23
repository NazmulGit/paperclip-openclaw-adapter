import esbuild from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({ uiEntry: "src/ui/index.tsx" });
const watch = process.argv.includes("--watch");

// Mark all node_modules as external for the worker so esbuild doesn't
// try to bundle ws / zod / SDK (which breaks ESM/CJS interop at runtime).
const workerConfig = {
  ...presets.esbuild.worker,
  packages: "external",
};
const manifestConfig = {
  ...presets.esbuild.manifest,
  packages: "external",
};

const workerCtx = await esbuild.context(workerConfig);
const manifestCtx = await esbuild.context(manifestConfig);
const uiCtx = await esbuild.context(presets.esbuild.ui);

if (watch) {
  await Promise.all([workerCtx.watch(), manifestCtx.watch(), uiCtx.watch()]);
  console.log("esbuild watch mode enabled for worker, manifest, and ui");
} else {
  await Promise.all([workerCtx.rebuild(), manifestCtx.rebuild(), uiCtx.rebuild()]);
  await Promise.all([workerCtx.dispose(), manifestCtx.dispose(), uiCtx.dispose()]);
  console.log("esbuild build complete");
}
