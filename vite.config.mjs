import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const resolve = (path) => fileURLToPath(new URL(path, import.meta.url));
const templates = new Map([
  ['participation.pdf', 'application/pdf'],
  ['volunteer.pdf', 'application/pdf'],
  ['podium.pdf', 'application/pdf'],
  ['badge-logo.png', 'image/png'],
  ['badge-cubes.png', 'image/png'],
]);

// The hosted editor and the desktop launcher share the same controls and artwork.
// Only the browser build replaces the desktop API and window lifecycle scripts.
function studioAssets() {
  return {
    name: 'studio-assets',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return html
          .replace(/\s*<link rel="stylesheet" href="\/style\.css">/, '')
          .replace(/\s*<script src="\/(?:badges|app|lifecycle)\.js" defer><\/script>/g, '')
          .replace('</head>', [
            '<meta name="description" content="Сертификаты, призовые дипломы и бейджи для соревнований по спидкубингу. Загрузите список участников и подготовьте PDF для печати в браузере.">',
            '<script type="module" src="/browser-entry.js"></script>',
            '</head>',
          ].join('\n'));
      },
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = req.url?.split('?')[0];
        if (!path?.startsWith('/assets/')) return next();
        const name = path.slice('/assets/'.length);
        if (!templates.has(name)) return next();
        try {
          res.setHeader('Content-Type', templates.get(name));
          res.end(await readFile(resolve('./assets/' + name)));
        } catch (error) {
          next(error);
        }
      });
    },
    async generateBundle() {
      for (const name of templates.keys()) {
        this.emitFile({type: 'asset', fileName: 'assets/' + name, source: await readFile(resolve('./assets/' + name))});
      }
    },
  };
}

export default defineConfig({
  root: resolve('./web'),
  publicDir: resolve('./browser/public'),
  resolve: {alias: {'/browser-entry.js': resolve('./browser/src/main.js')}},
  server: {fs: {allow: [resolve('./')]}},
  worker: {format: 'es'},
  build: {
    outDir: resolve('./dist-web'),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    license: {fileName: 'third-party-licenses.md'},
  },
  plugins: [studioAssets()],
});
