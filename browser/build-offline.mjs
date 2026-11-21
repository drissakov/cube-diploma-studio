import {createHash} from 'node:crypto';
import {readdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const directory = fileURLToPath(new URL('../dist-web/', import.meta.url));
const revision = createHash('sha256');
const urls = [];
const files = await readdir(directory, {recursive: true, withFileTypes: true});
for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
  if (!file.isFile() || !/\.(?:html|css|m?js|ttf|woff2?|pdf|png|wasm)$/i.test(file.name) || file.name === 'sw.js') continue;
  const full = path.join(file.parentPath, file.name);
  const url = '/' + path.relative(directory, full).split(path.sep).join('/');
  urls.push(url === '/index.html' ? '/' : url);
  revision.update(url).update(await readFile(full));
}
const worker = `const prefix = 'cube-diploma-static-';
const name = prefix + '${revision.digest('hex').slice(0, 16)}';
const paths = ${JSON.stringify(urls.sort())};

self.addEventListener('install', event => {
  event.waitUntil(caches.open(name).then(cache => cache.addAll(paths.map(path => new Request(path, {cache: 'reload'})))));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const old of await caches.keys()) if (old.startsWith(prefix) && old !== name) await caches.delete(old);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !paths.includes(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(name);
    return (await cache.match(url.pathname)) || fetch(event.request);
  })());
});
`;
await writeFile(path.join(directory, 'sw.js'), worker);
