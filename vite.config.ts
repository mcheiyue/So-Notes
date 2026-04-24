import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;
const isProfiling = process.env.ENABLE_PROFILING === "true" || process.env.VITE_ENABLE_PROFILING === "true";

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Profiling 构建隔离：仅在 ENABLE_PROFILING=true 时启用 react-dom/profiling
  // 用于性能诊断构建，生产构建默认禁用以减小体积并避免性能开销
  resolve: isProfiling
    ? {
        alias: {
          "react-dom/client": "react-dom/profiling",
        },
      }
    : undefined,

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    pool: "forks",
    fileParallelism: false,
    // Spotlight 组件在 jsdom 渲染时触发 4GB+ 内存消耗（backdrop-blur + animate-in 等复杂 CSS），
    // 在本地开发环境中可正常运行，CI 环境内存受限时排除此文件。
    exclude: ['**/Spotlight.test.tsx', '**/node_modules/**'],
  },
}));
