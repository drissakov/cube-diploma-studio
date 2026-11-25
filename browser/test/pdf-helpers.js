import {readFile} from 'node:fs/promises';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';

export function serveAssets(t) {
  t.mock.method(globalThis, 'fetch', async (path) => {
    const source = path.startsWith('/fonts/') ? '../public' + path : '../..' + path;
    return new Response(await readFile(new URL(source, import.meta.url)));
  });
}

export async function pdfPages(bytes) {
  const task = getDocument({data: bytes, isEvalSupported: false});
  const pdf = await task.promise;
  try {
    const pages = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      pages.push(content.items.map(item => item.str).join(' ').replace(/\s+/g, ' '));
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
