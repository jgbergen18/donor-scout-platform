// Client-side document text extraction. Originals never leave the device: we extract
// plain text in the browser and send only the text to the server. PDF and DOCX parsers
// are lazy-loaded so they don't weigh down the main bundle.

export const ACCEPTED_DOC_TYPES = '.pdf,.docx,.txt,.md,.csv';

export async function extractText(file) {
  const lower = (file?.name || '').toLowerCase();

  if (/\.(txt|md|csv|text)$/.test(lower)) {
    return (await file.text()).trim();
  }

  if (/\.docx$/.test(lower)) {
    const mammoth = await import('mammoth');
    const arrayBuffer = await file.arrayBuffer();
    const { value } = await mammoth.extractRawText({ arrayBuffer });
    return (value || '').trim();
  }

  if (/\.pdf$/.test(lower)) {
    const pdfjs = await import('pdfjs-dist');
    const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    const data = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data }).promise;
    let out = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      out += content.items.map((it) => it.str || '').join(' ') + '\n\n';
    }
    return out.trim();
  }

  if (/\.doc$/.test(lower)) {
    throw new Error('Old .doc files are not supported. Save it as .docx or PDF, or paste the text.');
  }

  // Unknown extension: try reading it as plain text.
  return (await file.text()).trim();
}
