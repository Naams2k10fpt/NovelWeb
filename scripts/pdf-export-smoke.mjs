import { app, BrowserWindow } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PDFParse } from "pdf-parse";

const outputPath = resolve(process.argv[2] ?? join("tmp", "pdfs", "vietnamese-smoke.pdf"));
const expectedText = ["Tiếng Việt", "Truyện", "Chương", "thức tỉnh", "Nguyễn"];

async function run() {
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const html = `<!doctype html>
<html lang="vi">
<head>
  <meta charset="utf-8">
  <style>
    @page { size: A4; margin: 20mm; }
    body { font-family: "Noto Serif", "Times New Roman", serif; font-size: 14pt; line-height: 1.7; }
    h1 { font-size: 26pt; }
  </style>
</head>
<body>
  <h1>Tiếng Việt trong NovelWeb</h1>
  <p>Truyện mở đầu bằng Chương Một: Sự thức tỉnh của Nguyễn An.</p>
  <p>Đây là phép thử đầy đủ dấu: ă â đ ê ô ơ ư - Ă Â Đ Ê Ô Ơ Ư.</p>
</body>
</html>`;

  try {
    await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await window.webContents.printToPDF({
      pageSize: "A4",
      preferCSSPageSize: true,
      printBackground: true
    });
    const parser = new PDFParse({ data: new Uint8Array(pdf) });

    try {
      const text = (await parser.getText()).text;
      if (expectedText.some((value) => !text.includes(value))) {
        throw new Error(`Vietnamese PDF text check failed: ${text}`);
      }
    } finally {
      await parser.destroy();
    }

    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, pdf);
    console.log(`Vietnamese PDF smoke test passed: ${outputPath}`);
  } finally {
    window.destroy();
    app.quit();
  }
}

app.whenReady().then(run).catch((error) => {
  console.error(error);
  app.exit(1);
});
