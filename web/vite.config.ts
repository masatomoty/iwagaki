import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    // 計測を素直にするため、意図しないチャンク分割を避ける
    rollupOptions: { output: { manualChunks: undefined } },
  },
  worker: { format: 'es' },
})
