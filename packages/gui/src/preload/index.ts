import {
  contextBridge,
  type IpcRendererEvent,
  ipcRenderer,
  webUtils,
} from "electron";
import type { HertaBridge } from "../renderer/ipc/bridge-types.js";
import { CMD, EVT } from "./channels.js";

function subscribe<T>(channel: string, cb: (e: T) => void): () => void {
  const handler = (_evt: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

const bridge: HertaBridge = {
  platform: process.platform,
  submitText: (text, stagedImageIds) =>
    ipcRenderer.invoke(CMD.submitText, text, stagedImageIds),
  interrupt: (turnId) => ipcRenderer.invoke(CMD.interrupt, turnId),
  rewindLastTurn: (sessionId) =>
    ipcRenderer.invoke(CMD.rewindLastTurn, sessionId),
  maybePlayEasterEgg: () => ipcRenderer.invoke(CMD.maybePlayEasterEgg),
  listSessions: () => ipcRenderer.invoke(CMD.list),
  searchSessions: (query) => ipcRenderer.invoke(CMD.search, query),
  recordSlice: (sessionId, before, count) =>
    ipcRenderer.invoke(CMD.recordSlice, sessionId, before, count),
  openSession: (id) => ipcRenderer.invoke(CMD.open, id),
  createSession: (opts) => ipcRenderer.invoke(CMD.create, opts),
  deleteSession: (id) => ipcRenderer.invoke(CMD.deleteSession, id),
  resolveApproval: (opts) => ipcRenderer.invoke(CMD.resolveApproval, opts),
  listCommandRules: () => ipcRenderer.invoke(CMD.listCommandRules),
  removeCommandRule: (display) =>
    ipcRenderer.invoke(CMD.removeCommandRule, display),
  resyncRecord: () => ipcRenderer.invoke(CMD.resyncRecord),
  checkForUpdate: () => ipcRenderer.invoke(CMD.updateCheck),
  restartAndInstall: () => ipcRenderer.invoke(CMD.updateRestart),
  getUpdateState: () => ipcRenderer.invoke(CMD.updateStatus),
  getAppVersion: () => ipcRenderer.invoke(CMD.appVersion),
  onUpdate: (cb) => subscribe(EVT.update, cb),
  pickWorkspace: () => ipcRenderer.invoke(CMD.pickWorkspace),
  setWorkspace: (sessionId, path) =>
    ipcRenderer.invoke(CMD.setWorkspace, sessionId, path),
  resetWorkspace: (sessionId) =>
    ipcRenderer.invoke(CMD.resetWorkspace, sessionId),
  pickAttachments: () => ipcRenderer.invoke(CMD.pickAttachments),
  attachFiles: (sessionId, paths) =>
    ipcRenderer.invoke(CMD.attachFiles, sessionId, paths),
  removeAttachment: (sessionId, path) =>
    ipcRenderer.invoke(CMD.removeAttachment, sessionId, path),
  stageImages: (sessionId, inputs) =>
    ipcRenderer.invoke(CMD.stageImages, sessionId, inputs),
  unstageImage: (sessionId, id) =>
    ipcRenderer.invoke(CMD.unstageImage, sessionId, id),
  // Electron 43 removed `File.path`, and this preload is CJS + sandboxed
  // (main/index.ts:266 records why it must stay that way), so a dropped
  // file's real path is only reachable through webUtils here. The renderer
  // gets a path string and never a File handle.
  pathForFile: (file) => webUtils.getPathForFile(file),
  getDreamConfig: () => ipcRenderer.invoke(CMD.getDreamConfig),
  setDreamConfig: (cfg) => ipcRenderer.invoke(CMD.setDreamConfig, cfg),
  getBackendConfig: () => ipcRenderer.invoke(CMD.getBackendConfig),
  setBackendConfig: (cfg) => ipcRenderer.invoke(CMD.setBackendConfig, cfg),
  getModelConfig: () => ipcRenderer.invoke(CMD.getModelConfig),
  setModelConfig: (cfg) => ipcRenderer.invoke(CMD.setModelConfig, cfg),
  getLocale: () => ipcRenderer.invoke(CMD.getLocale),
  setLocale: (locale) => ipcRenderer.invoke(CMD.setLocale, locale),
  getInteractionLanguage: () => ipcRenderer.invoke(CMD.getInteractionLanguage),
  setInteractionLanguage: (choice) =>
    ipcRenderer.invoke(CMD.setInteractionLanguage, choice),
  getCloseToTray: () => ipcRenderer.invoke(CMD.getCloseToTray),
  setCloseToTray: (enabled) => ipcRenderer.invoke(CMD.setCloseToTray, enabled),
  getAutoUpdate: () => ipcRenderer.invoke(CMD.getAutoUpdate),
  setAutoUpdate: (enabled) => ipcRenderer.invoke(CMD.setAutoUpdate, enabled),
  getTheme: () => ipcRenderer.invoke(CMD.getTheme),
  setTheme: (theme) => ipcRenderer.invoke(CMD.setTheme, theme),
  getDeepSeekKeyStatus: () => ipcRenderer.invoke(CMD.getDeepSeekKeyStatus),
  setDeepSeekKey: (key) => ipcRenderer.invoke(CMD.setDeepSeekKey, key),
  clearDeepSeekKey: () => ipcRenderer.invoke(CMD.clearDeepSeekKey),
  windowMinimize: () => ipcRenderer.send(CMD.windowMinimize),
  windowToggleMaximize: () => ipcRenderer.send(CMD.windowToggleMaximize),
  windowClose: () => ipcRenderer.send(CMD.windowClose),
  windowIsMaximized: () => ipcRenderer.invoke(CMD.windowIsMaximized),
  onWindowMaximized: (cb) => subscribe(EVT.windowMaximized, cb),
  onWorkspace: (cb) => subscribe(EVT.workspace, cb),
  onRecord: (cb) => subscribe(EVT.record, cb),
  onOverlay: (cb) => subscribe(EVT.overlay, cb),
  onSpeech: (cb) => subscribe(EVT.speech, cb),
  onAgent: (cb) => subscribe(EVT.agent, cb),
  onTurn: (cb) => subscribe(EVT.turn, cb),
  onReset: (cb) => subscribe(EVT.reset, cb),
  onTitle: (cb) => subscribe(EVT.title, cb),
  onSessionDeleted: (cb) => subscribe(EVT.sessionDeleted, cb),
  onNavBlocked: (cb) => subscribe(EVT.navBlocked, cb),
  onVoice: (cb) => subscribe(EVT.voice, cb),
};

contextBridge.exposeInMainWorld("herta", bridge);
