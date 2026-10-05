import { getDocument, GlobalWorkerOptions } from "../vendor/pdfjs/pdf.min.mjs";

GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;

export async function renderPdfPreview(url) {
  const task = getDocument({
    url,
    withCredentials: false,
    isEvalSupported: false,
    cMapUrl: new URL("../vendor/pdfjs/cmaps/", import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL("../vendor/pdfjs/standard_fonts/", import.meta.url).href,
    wasmUrl: new URL("../vendor/pdfjs/wasm/", import.meta.url).href,
  });
  // Password-protected PDFs should fail visibly rather than leave Add/Refresh pending.
  const passwordRequired = new Promise((_, reject) => {
    task.onPassword = () => reject(new Error("Password-protected PDFs cannot be previewed."));
  });
  try {
    const pdf = await Promise.race([task.promise, passwordRequired]);
    const page = await pdf.getPage(1);
    const original = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(560 / original.width, 560 / original.height) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport, background: "#ffffff" }).promise;
    return canvas.toDataURL("image/webp", 0.85);
  } catch (error) {
    throw new Error(`The PDF first page could not be rendered: ${error.message}`);
  } finally {
    await task.destroy();
  }
}
