import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Electron 渲染进程以 file:// 加载构建产物，base 必须为相对路径
export default defineConfig({
  base: './',
  plugins: [vue()],
  server: {
    port: 5199,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
