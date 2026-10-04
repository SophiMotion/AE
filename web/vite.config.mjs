import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  base: mode === "pages" ? "./" : "/",
  define: { "import.meta.env.VITE_PUBLIC_DEMO": JSON.stringify(mode === "pages" ? "true" : "false") },
  build: {
    outDir: mode === "pages" ? "dist/pages" : "dist/client",
    rollupOptions: {
      output: {
        manualChunks: { chart: ["chart.js"], flow: ["@xyflow/react"] },
      },
    },
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    port: 5178,
    strictPort: true,
    proxy: { "/api": "http://127.0.0.1:8877" },
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.tsx"],
    },
  },
  plugins: [react()],
}));
