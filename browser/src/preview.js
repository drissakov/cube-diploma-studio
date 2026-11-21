import {getDocument, GlobalWorkerOptions, PDFWorker} from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;
let pdfWorker;

export async function previewPng(bytes, signal) {
  signal?.throwIfAborted();
  pdfWorker ??= new PDFWorker();
  await pdfWorker.promise;
  signal?.throwIfAborted();
  const task = getDocument({
    data: bytes, worker: pdfWorker, isEvalSupported: false,
    useSystemFonts: false, useWasm: false
  });
  let render;
  const abort = () => { render?.cancel(); };
  signal?.addEventListener('abort', abort, {once: true});
  try {
    const pdf = await task.promise;
    const page = await pdf.getPage(1);
    signal?.throwIfAborted();
    const viewport = page.getViewport({scale: 1.7});
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const canvasContext = canvas.getContext('2d', {alpha: false});
    render = page.render({canvasContext, canvas, viewport});
    await render.promise;
    signal?.throwIfAborted();
    return await new Promise((resolve, reject) => canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('Не удалось показать страницу PDF.'));
    }, 'image/png'));
  } finally {
    signal?.removeEventListener('abort', abort);
    await task.destroy();
  }
}
