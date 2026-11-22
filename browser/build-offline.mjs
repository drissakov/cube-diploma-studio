import {createHash} from 'node:crypto';
import {readdir, readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const directory = fileURLToPath(new URL('../dist-web/', import.meta.url));
const revision = createHash('sha256');
const integrity = {};
const checksum = bytes => 'sha256-' + createHash('sha256').update(bytes).digest('base64');
const entry = path.join(directory, 'index.html');
const html = (await readFile(entry, 'utf8')).replace(/\s*<meta name="studio-release" content="[a-f0-9]{16}">/, '');
const files = await readdir(directory, {recursive: true, withFileTypes: true});
for (const file of files.sort((a, b) => a.name.localeCompare(b.name))) {
  if (!file.isFile() || !/\.(?:html|css|m?js|ttf|woff2?|pdf|png|wasm)$/i.test(file.name) || file.name === 'sw.js') continue;
  const full = path.join(file.parentPath, file.name);
  const url = '/' + path.relative(directory, full).split(path.sep).join('/');
  const bytes = full === entry ? html : await readFile(full);
  integrity[url === '/index.html' ? '/' : url] = checksum(bytes);
  revision.update(url).update(bytes);
}
const release = revision.digest('hex').slice(0, 16);
const stamped = html.replace('</head>', '<meta name="studio-release" content="' + release + '">\n</head>');
integrity['/'] = checksum(stamped);
await writeFile(entry, stamped);

// The generated worker is standalone, including when the editor is offline.
function studioWorker(release, integrity) {
  const prefix = 'cube-diploma-static-';
  const current = prefix + release;
  const bindings = 'cube-diploma-client-releases';
  const clientKey = id => '/.studio-client/' + id;
  const pinned = new Map();

  // A backgrounded tab can outlive both an update and the worker process.
  // Keep its release assignment until that browser client disappears.
  async function pin(id, version) {
    if (!id || !version || pinned.get(id) === version) return;
    await (await caches.open(bindings)).put(clientKey(id), new Response(version));
    pinned.set(id, version);
  }

  async function versionOf(id) {
    if (!id) return null;
    if (!pinned.has(id)) {
      const record = await caches.match(clientKey(id), {cacheName: bindings});
      if (record) pinned.set(id, await record.text());
    }
    return pinned.get(id);
  }

  self.addEventListener('install', event => {
    event.waitUntil((async () => {
      const cache = await caches.open(current);
      const requests = Object.entries(integrity).map(([path, hash]) =>
        new Request(path, {cache: 'reload', integrity: hash}));
      try {
        await cache.addAll(requests);
      } catch (error) {
        if (!await cache.match('/')) await caches.delete(current);
        throw error;
      }
      await self.skipWaiting();
    })());
  });

  self.addEventListener('activate', event => {
    event.waitUntil((async () => {
      const releases = (await caches.keys()).filter(key => key.startsWith(prefix));
      const older = releases.slice(0, releases.indexOf(current));
      const clients = await self.clients.matchAll({type: 'all', includeUncontrolled: true});
      const inUse = new Set();
      for (const client of clients) {
        // The first update from the original cache-first worker has no assignments.
        const version = await versionOf(client.id) || older.at(-1)?.slice(prefix.length) || release;
        await pin(client.id, version);
        inUse.add(prefix + version);
      }
      // Retain the immediately preceding release for in-flight navigations.
      for (const old of older.slice(0, -1)) if (!inUse.has(old)) await caches.delete(old);
      const records = await caches.open(bindings);
      const live = new Set(clients.map(client => clientKey(client.id)));
      for (const key of await records.keys()) {
        if (!live.has(new URL(key.url).pathname)) await records.delete(key);
      }
      await self.clients.claim();
    })());
  });

  self.addEventListener('message', event => {
    const version = event.data?.studioRelease;
    if (/^[a-f0-9]{16}$/.test(version)) event.waitUntil(pin(event.source?.id, version));
  });

  async function stageUpdate() {
    await self.registration.update();
    const installing = self.registration.installing;
    if (installing?.state === 'installing') {
      await new Promise(resolve => installing.addEventListener('statechange', resolve, {once: true}));
    }
  }

  async function navigate(event) {
    let shell;
    try {
      const online = await fetch(event.request, {cache: 'no-store', signal: AbortSignal.timeout(5000)});
      if (online.ok && online.headers.get('content-type')?.includes('text/html')) shell = online;
    } catch { /* The most recently installed release is ready offline. */ }
    shell ??= await caches.match('/', {cacheName: current});
    if (!shell) return Response.error();
    const html = await shell.clone().text();
    const version = html.match(/name="studio-release" content="([a-f0-9]{16})"/)?.[1];
    if (version && version !== release) {
      // Serve a new HTML entry only once its dependencies form a complete cache.
      const target = prefix + version;
      let ready = await caches.match('/', {cacheName: target});
      if (!ready) {
        try {
          // On a slow link, open the installed editor while staging continues.
          await Promise.race([stageUpdate(), new Promise(resolve => setTimeout(resolve, 10000))]);
          ready = await caches.match('/', {cacheName: target});
        } catch { /* Failed downloads leave the installed release available. */ }
      }
      if (!ready) {
        await pin(event.resultingClientId, release);
        return (await caches.match('/', {cacheName: current})) || Response.error();
      }
    }
    await pin(event.resultingClientId, version || release);
    return shell;
  }

  self.addEventListener('fetch', event => {
    const {request} = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (request.mode === 'navigate' && ['/', '/index.html'].includes(url.pathname)) {
      event.respondWith(navigate(event));
    } else if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/')) {
      event.respondWith((async () => {
        const version = await versionOf(event.clientId) || release;
        // Dedicated PDF workers must use the same templates and fonts as their editor.
        await pin(event.resultingClientId, version);
        const response = await caches.match(url.pathname, {cacheName: prefix + version});
        return response || fetch(request, {cache: 'reload'});
      })());
    }
  });
}
const worker = '(' + studioWorker.toString() + ')(' + JSON.stringify(release) + ',' + JSON.stringify(integrity) + ');\n';
await writeFile(path.join(directory, 'sw.js'), worker);
