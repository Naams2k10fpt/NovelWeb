import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const pdfjsRoot = resolve("dist", "win-unpacked", "resources", "app.asar.unpacked", "node_modules", "pdfjs-dist");
const apiPath = join(pdfjsRoot, "legacy", "build", "pdf.mjs");
const workerPath = join(pdfjsRoot, "legacy", "build", "pdf.worker.mjs");
const sourcePath = resolve(process.argv[2] ?? join("tmp", "pdfs", "vietnamese-smoke.pdf"));
const pdfjs = await import(pathToFileURL(apiPath).href);
const workerVersion = (await readFile(workerPath, "utf8")).match(/pdfjsVersion = ([\d.]+)/)?.[1];

assert.equal(workerVersion, pdfjs.version, "Packaged PDF API and worker versions differ.");
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;

const loadingTask = pdfjs.getDocument({ data: new Uint8Array(await readFile(sourcePath)) });
const document = await loadingTask.promise;

try {
  const page = await document.getPage(1);
  const content = await page.getTextContent();
  const text = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");

  assert.match(text, /NovelWeb/, "Packaged PDF.js could not extract text.");
  console.log(`Packaged PDF import smoke passed with API/worker ${pdfjs.version}.`);
} finally {
  await loadingTask.destroy();
}
