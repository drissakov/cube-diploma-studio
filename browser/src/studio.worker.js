// Keep CSV parsing, typesetting and packing off the UI thread.
const queue = [];
let running = false;
let active;

async function compute({path, body}) {
  if (path === '/api/import') {
    const {registrationCsv} = await import('./csv.js');
    const bytes = new Uint8Array(await body.file.arrayBuffer());
    return registrationCsv(bytes, body.column);
  }
  if (path === '/api/badge-layout') {
    const {layoutInfo} = await import('./packing.js');
    return layoutInfo(body);
  }
  const preview = path === '/api/preview';
  if (!preview && path !== '/api/export') throw new Error('Неизвестная операция.');
  if (body.mode === 'badges') {
    const {badgesPdf} = await import('./badges.js');
    return badgesPdf(body, preview);
  }
  const {certificatePdf} = await import('./certificates.js');
  return certificatePdf(body, preview);
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      active = queue.shift();
      try {
        const result = await compute(active);
        if (!active.cancelled) {
          self.postMessage({id: active.id, result}, result instanceof Uint8Array ? [result.buffer] : []);
        }
      } catch (error) {
        if (!active.cancelled) self.postMessage({id: active.id, error: error.message || 'Не удалось подготовить документ.'});
      } finally {
        active = null;
      }
    }
  } finally {
    running = false;
  }
}

self.onmessage = ({data}) => {
  if (data.cancel) {
    if (active?.id === data.id) active.cancelled = true;
    const index = queue.findIndex(item => item.id === data.id);
    if (index !== -1) queue.splice(index, 1);
    return;
  }
  queue.push(data);
  void drain();
};
