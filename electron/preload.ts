import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  library: {
    getCurrent: () => ipcRenderer.invoke("library:getCurrent"),
    chooseFolder: () => ipcRenderer.invoke("library:chooseFolder")
  },
  series: {
    list: () => ipcRenderer.invoke("series:list"),
    get: (seriesId: string) => ipcRenderer.invoke("series:get", seriesId),
    create: (input: unknown) => ipcRenderer.invoke("series:create", input),
    update: (seriesId: string, input: unknown) => ipcRenderer.invoke("series:update", seriesId, input)
  }
});
