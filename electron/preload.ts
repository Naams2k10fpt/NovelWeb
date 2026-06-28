import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  library: {
    getCurrent: () => ipcRenderer.invoke("library:getCurrent"),
    chooseFolder: () => ipcRenderer.invoke("library:chooseFolder")
  }
});
