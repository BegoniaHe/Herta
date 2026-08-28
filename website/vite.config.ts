import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The website mounts the REAL GUI renderer (packages/gui/src/renderer) on a
// scripted demo bridge — @gui deep-imports the sources directly, so the demo
// stays pixel-identical to the app by construction (WebGL aura, ASCII opening,
// paced streaming all run as the app's own code). Each imported file resolves
// its own deps from packages/gui/node_modules (pnpm file-relative resolution);
// react is deduped so both packages share one copy.
export default defineConfig({
  // Served at the custom domain root: https://www.herta-ai.com/
  // (custom domains drop the /<REPO>/ sub-path, so base is "/").
  base: "/",
  plugins: [react()],
  define: {
    // Per-build stamp for the demo-iframe cache-bust (see Site.tsx): the
    // config is evaluated once per build/dev-server start, so every deploy
    // mints a fresh value.
    __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
  },
  resolve: {
    alias: [
      // The one seam in "the demo is the real renderer": stored pictures.
      // The renderer builds its <img>/lightbox URLs in shared/attachment-image
      // against an Electron protocol; the demo swaps that ONE module for a
      // twin that serves the showcase's two pictures as bundled assets (see
      // src/demo-attachment-image.ts). Everything else runs the app's code.
      {
        // Whole-specifier match: a regex alias REPLACES the matched span
        // only, so anchoring both ends is what swaps the full relative
        // import ("../../../shared/attachment-image.js") for the shim.
        find: /^.*\/shared\/attachment-image\.js$/,
        replacement: resolve(__dirname, "src/demo-attachment-image.ts"),
      },
      {
        find: "@gui",
        replacement: resolve(__dirname, "../packages/gui/src/renderer"),
      },
    ],
    dedupe: ["react", "react-dom"],
  },
  build: {
    rollupOptions: {
      input: {
        // The landing page, and the demo entry it embeds via <iframe> —
        // the app gets a real viewport of its own (fixed positioning,
        // vw/vh, and morph coordinate math all assume a window).
        main: resolve(__dirname, "index.html"),
        demo: resolve(__dirname, "demo.html"),
      },
    },
  },
  server: { port: 4300, strictPort: true },
});
