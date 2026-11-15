// The Knowledge page in Dispatch IDE's Customizations (patches/customizations-knowledge.patch): one
// script + one stylesheet in ide-ext/media/knowledge, which the Agents window inlines into its webview.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: "ide-ext/media/knowledge",
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: "src/knowledge/main.tsx",
      output: { format: "es", inlineDynamicImports: true, entryFileNames: "knowledge.js", assetFileNames: "knowledge.[ext]" },
    },
  },
});
