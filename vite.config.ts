import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { docs, renderSite } from './web/src/site/render.js';

export default defineConfig({
  plugins: [react(), {
    name: 'public-site',
    generateBundle(_options, bundle) {
      const entry = Object.values(bundle).find(item => item.type === 'chunk' && item.isEntry && item.name === 'site');
      if (!entry || entry.type !== 'chunk') throw new Error('官网构建入口缺失');
      const styles = [...(entry.viteMetadata?.importedCss || [])];
      this.emitFile({ type: 'asset', fileName: 'site/index.html', source: renderSite(undefined, entry.fileName, styles) });
      for (const doc of docs) this.emitFile({ type: 'asset', fileName: `site/docs${doc.slug ? '/' + doc.slug : ''}/index.html`, source: renderSite(doc, entry.fileName, styles) });
      const urls = ['/', ...docs.map(doc => '/docs' + (doc.slug ? '/' + doc.slug : ''))];
      this.emitFile({ type: 'asset', fileName: 'site/sitemap.xml', source: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(url => `<url><loc>https://autoworkflow.top${url}</loc></url>`).join('')}</urlset>` });
      this.emitFile({ type: 'asset', fileName: 'site/robots.txt', source: 'User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /tasks\nDisallow: /devices\nDisallow: /history\nDisallow: /settings\nDisallow: /inbox\nDisallow: /workbench\nSitemap: https://autoworkflow.top/sitemap.xml\n' });
    }
  }],
  publicDir: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify('production')
  },
  build: {
    outDir: 'public/build',
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
    manifest: true,
    rollupOptions: {
      input: { app: 'web/src/main.tsx', site: 'web/src/site/main.ts' },
      output: {
        entryFileNames: chunk => `assets/${chunk.name === 'site' ? 'site' : 'react'}-entry-[hash].js`,
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
