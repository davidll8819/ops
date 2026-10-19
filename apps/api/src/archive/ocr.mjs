import { createRequire } from 'node:module';
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWorker } from 'tesseract.js';

const require = createRequire(import.meta.url);
export const OCR_CAUTION = 'OCR 识别文字可能有误，尤其是数字、手写或模糊内容；请核对原件。';
export const ocrStats = (pages, lowConfidencePages) => ({ engine: 'tesseract.js', version: '7.0.0', languages: ['chi_sim', 'eng'], pages, lowConfidencePages });

/** Stage trusted bundled files together for Tesseract's single public langPath. */
export async function createLocalRecognizer() {
  const base = await realpath(process.env.ARCHIVE_OCR_TMPDIR || tmpdir());
  const directory = await mkdtemp(path.join(base, 'archive-ocr-'));
  const cleanup = async () => {
    const resolved = await realpath(directory);
    if (path.dirname(resolved) !== base || !path.basename(resolved).startsWith('archive-ocr-')) throw new Error('Unsafe OCR resource cleanup path');
    await rm(resolved, { recursive: true, force: true });
  };
  try {
    await Promise.all(['chi_sim', 'eng'].map((code) => copyFile(require.resolve(`@tesseract.js-data/${code}/4.0.0_best_int/${code}.traineddata.gz`), path.join(directory, `${code}.traineddata.gz`))));
    // chi_sim's bundled config requests an unbundled vertical model by default.
    // Restrict auxiliary language loading to the explicitly bundled English model.
    const worker = await createWorker('chi_sim+eng', 1, { langPath: directory, cacheMethod: 'none', logger: () => {}, errorHandler: () => {} }, { tessedit_load_sublangs: 'eng' });
    return { recognize: (...args) => worker.recognize(...args), async terminate() { try { await worker.terminate(); } finally { await cleanup(); } } };
  } catch (error) { await cleanup(); throw error; }
}

/** A single sequential worker is owned by one extraction and terminated in its finally. */
export function ocrSession(createRecognizer = createLocalRecognizer) {
  let worker; let pages = 0; const lowConfidencePages = [];
  return {
    get stats() { return pages ? ocrStats(pages, lowConfidencePages) : undefined; },
    async recognize(bytes, page, location, warnings) {
      try {
        worker ??= await createRecognizer();
        const result = await worker.recognize(bytes);
        if (!result?.data || typeof result.data.text !== 'string' || !Number.isFinite(result.data.confidence)) throw new Error('Invalid OCR result');
        pages += 1;
        if (result.data.confidence < 60) { lowConfidencePages.push(page); warnings.push(`${location}识别置信度较低，请核对原件。`); }
        return result.data.text;
      } catch {
        const error = new Error(`${location} OCR 识别失败，请重新扫描或拆分文件后重试。`); error.code = 'OCR_FAILED'; throw error;
      }
    },
    async close() {
      if (worker) {
        const owned = worker; worker = undefined;
        try { await owned.terminate(); }
        catch { const error = new Error('OCR 资源清理失败，请稍后重试。'); error.code = 'OCR_FAILED'; throw error; }
      }
    },
  };
}
