import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../src/types';
const call = async (name: string, value?: unknown) => {
  const response = await ipcRenderer.invoke(name, value);
  if (!response.ok) throw new Error(response.error);
  return response.data;
};
const api: DesktopApi = {
  browserConnection: () => call('browser:connection'),
  exportBrowserExtension: () => call('browser:export-extension'),
  copyBrowserExtensionPath: () => call('browser:copy-extension-path'),
  openBrowserGuide: () => call('browser:guide'),
  openBrowserHelp: () => call('browser:help'),
  copyBridgeAddress: () => call('browser:copy-address'),
  copyExtensionPage: (browser) => call('browser:copy-extension-page', browser),
  load: () => call('workspace:load'),
  importData: (kind) => call('products:import', kind),
  supplement: () => call('products:supplement'),
  saveProducts: (products) => call('products:save', products),
  saveShop: (input) => call('shops:save', input),
  loginShop: (input) => call('shops:login', input),
  onShopLoginChanged: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, result: Parameters<typeof listener>[0]) =>
      listener(result);
    ipcRenderer.on('shops:login-changed', receive);
    return () => ipcRenderer.removeListener('shops:login-changed', receive);
  },
  prepareTasks: (input) => call('tasks:prepare', input),
  runTasks: (ids) => call('tasks:run', ids),
  resumeTask: (id) => call('tasks:resume', id),
  restartTask: (id) => call('tasks:restart', id),
  confirmTaskShop: (id) => call('tasks:confirm-shop', id),
  updateTaskProduct: (id) => call('tasks:update-product', id),
  onTaskChanged: (listener) => {
    const receive = (_event: Electron.IpcRendererEvent, task: Parameters<typeof listener>[0]) =>
      listener(task);
    ipcRenderer.on('tasks:changed', receive);
    return () => ipcRenderer.removeListener('tasks:changed', receive);
  },
  stopTasks: () => call('tasks:stop'),
  openEvidence: (id) => call('tasks:evidence', id),
  downloadTemplate: (kind) => call('template:download', kind),
  showDataFolder: () => call('workspace:folder'),
  clearTaskRecords: (ids) => call('tasks:clear-records', ids),
  restoreTaskRecords: (ids) => call('tasks:restore-records', ids),
  agentConfig: () => call('agent:config'),
  saveAgentConfig: (input) => call('agent:save', input),
  testAgentConfig: (input) => call('agent:test', input),
  diagnoseTask: (input) => call('agent:diagnose', input),
  confirmAgentAction: (input) => call('agent:confirm', input),
};
contextBridge.exposeInMainWorld('desktop', api);
