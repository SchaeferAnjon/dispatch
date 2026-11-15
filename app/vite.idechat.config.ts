// The chat column inside Dispatch IDE (design/two-modes): Dispatch's own ChatPage, built as one
// script + one stylesheet the dispatch-bridge extension loads into its webview (ide-ext/media/chat).
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: "ide-ext/media/chat",
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: "src/idechat/main.tsx",
      output: { format: "es", inlineDynamicImports: true, entryFileNames: "chat.js", assetFileNames: "chat.[ext]" },
    },
  },
});
