import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

// Shared base config
const base = "";

// UI build — excludes background entry
export default defineConfig({
  plugins: [react()],
  base,
  build: {
    outDir: "dist",
    modulePreload: { polyfill: false },
    emptyOutDir: false,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, "sidepanel.html"),
        newtab: resolve(__dirname, "newtab.html"),
        settings: resolve(__dirname, "settings.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        manualChunks(id) {
          if (id.includes("node_modules")) return "vendor";
        },
      },
    },
  },
});
