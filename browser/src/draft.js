const emergencyKey = 'cube-diploma-studio:draft';
let database;
let opening;

function openDatabase() {
  if (opening) return opening;
  opening = new Promise(resolve => {
    try {
      const request = indexedDB.open('cube-diploma-studio', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('drafts');
      request.onsuccess = () => {
        database = request.result;
        database.onversionchange = () => {
          database.close();
          database = null;
          opening = null;
        };
        resolve(database);
      };
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return opening;
}

function emergencyDraft() {
  try { return JSON.parse(localStorage.getItem(emergencyKey)); }
  catch { return null; }
}

function put(db, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('drafts', 'readwrite');
    tx.objectStore('drafts').put(record, 'latest');
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error('Браузер прервал сохранение черновика.'));
    tx.onerror = () => reject(tx.error);
  });
}

export async function readDraft() {
  const db = await openDatabase();
  const backup = emergencyDraft();
  if (!db) return backup?.value ?? null;
  const saved = await new Promise(resolve => {
    try {
      const read = db.transaction('drafts').objectStore('drafts').get('latest');
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return (backup && (!saved || backup.time > saved.time) ? backup : saved)?.value ?? null;
}

function recordFor(value) {
  return {value, time: performance.timeOrigin + performance.now()};
}

export async function writeDraft(value) {
  const record = recordFor(value);
  if (database) {
    try {
      await put(database, record);
      const backup = emergencyDraft();
      if (backup && backup.time <= record.time) localStorage.removeItem(emergencyKey);
      return;
    } catch { /* Fall back when IndexedDB is unavailable or over quota. */ }
  }
  try { localStorage.setItem(emergencyKey, JSON.stringify(record)); }
  catch { throw new Error('В браузере не хватает места для сохранения черновика.'); }
}

export function flushDraft(value) {
  // pagehide can suspend asynchronous transactions. Keep the newest snapshot
  // synchronously when space permits, and start the regular write independently.
  const record = recordFor(value);
  try { localStorage.setItem(emergencyKey, JSON.stringify(record)); } catch {}
  if (database) void put(database, record).catch(() => {});
}
