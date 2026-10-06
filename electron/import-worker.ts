import { parentPort, workerData } from 'node:worker_threads';
import { collectFiles, importFiles } from './importer';
(async () => {
  const data = workerData as { files?: string[]; folder?: string; assetsDir: string; withImages: boolean };
  const files = data.folder ? await collectFiles(data.folder) : data.files || [];
  parentPort!.postMessage({ ok: true, data: await importFiles(files, data.assetsDir, data.withImages) });
})().catch(error => parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : '资料无法识别' }));
