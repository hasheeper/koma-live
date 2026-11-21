import { defineConfig } from 'vite'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  base: './',
  build: {
    outDir: fileURLToPath(new URL('./dist/runtime', import.meta.url)),
    lib: {
      entry: fileURLToPath(new URL('src/runtime.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'player.js',
    },
    emptyOutDir: true,
  },
  plugins: [
    {
      name: 'game-dependencies',
      generateBundle(_, bundle) {
        for (const chunk of Object.values(bundle))
          if (chunk.type === 'chunk') {
            const editor = Object.keys(chunk.modules).find((id) =>
              /\/apps\/|\/node_modules\/(vue|@vue|tweakpane|undo-manager)\//.test(id),
            )
            if (editor) throw new Error('游戏包包含编辑器依赖 ' + editor)
          }
      },
    },
  ],
})
