import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production')
  },
  build: {
    outDir: 'public/build',
    emptyOutDir: false,
    minify: true,
    sourcemap: false,
    manifest: true,
    rollupOptions: {
      input: 'web/src/main.tsx',
      output: {
        entryFileNames: 'assets/react-entry-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  },
  test: {
    environment: 'jsdom',
    include: ['web/**/*.test.ts', 'web/**/*.test.tsx'],
    restoreMocks: true
  }
});
