import '../../web/style.css';
import './register-offline.js';
import badgeScript from '../../web/badges.js?url';
import editorScript from '../../web/app.js?url';
import {defaults, events} from './catalog.js';
import {flushDraft, readDraft, writeDraft} from './draft.js';

let engine;
let nextId = 0;
const pending = new Map();

function getEngine() {
  if (engine) return engine;
  engine = new Worker(new URL('./studio.worker.js', import.meta.url), {type: 'module', name: 'cube-diploma'});
  engine.onmessage = ({data}) => {
    const job = pending.get(data.id);
    if (!job) return;
    pending.delete(data.id);
    if (data.error) job.reject(new Error(data.error));
    else job.resolve(data.result);
  };
  engine.onerror = () => {
    engine.terminate();
    engine = null;
    for (const job of pending.values()) job.reject(new Error('Не удалось загрузить модуль генерации. Обновите страницу.'));
    pending.clear();
  };
  return engine;
}

async function compute(path, body, signal) {
  signal?.throwIfAborted();
  const worker = getEngine();
  const id = ++nextId;
  const abort = () => {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    worker.postMessage({id, cancel: true});
    job.reject(new DOMException('Запрос отменён.', 'AbortError'));
  };
  try {
    return await new Promise((resolve, reject) => {
      pending.set(id, {resolve, reject});
      signal?.addEventListener('abort', abort, {once: true});
      worker.postMessage({id, path, body});
    });
  } finally {
    pending.delete(id);
    signal?.removeEventListener('abort', abort);
  }
}

async function api(path, body, {signal} = {}) {
  if (path === '/api/bootstrap') return Response.json({defaults, events, draft: await readDraft()});
  if (path === '/api/draft') {
    await writeDraft(body);
    return Response.json({ok: true});
  }
  const result = await compute(path, body, signal);
  if (path === '/api/preview') {
    const {previewPng} = await import('./preview.js');
    return new Response(await previewPng(result, signal));
  }
  if (path === '/api/export') return new Response(result, {headers: {'Content-Type': 'application/pdf'}});
  return Response.json(result);
}

function loadSharedScript(url) {
  return new Promise((resolve, reject) => {
    const tag = document.createElement('script');
    tag.src = url;
    tag.onload = resolve;
    tag.onerror = () => reject(new Error('Не удалось загрузить редактор. Обновите страницу.'));
    document.head.append(tag);
  });
}

async function startWebsite() {
  window.cubeStudioBrowser = {api, flushDraft};
  const mode = document.getElementById('processing-mode');
  mode.textContent = 'PDF в браузере';
  mode.title = 'CSV, подписи и готовые PDF обрабатываются на этом устройстве.';
  await loadSharedScript(badgeScript);
  await loadSharedScript(editorScript);
}

startWebsite().catch(error => {
  const alert = document.getElementById('global-error');
  alert.textContent = error.message;
  alert.hidden = false;
});
