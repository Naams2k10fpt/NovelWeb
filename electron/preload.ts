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
  },
  categories: {
    list: (seriesId: string) => ipcRenderer.invoke("categories:list", seriesId),
    get: (seriesId: string, categoryId: string) => ipcRenderer.invoke("categories:get", seriesId, categoryId),
    create: (seriesId: string, input: unknown) => ipcRenderer.invoke("categories:create", seriesId, input),
    update: (seriesId: string, categoryId: string, input: unknown) =>
      ipcRenderer.invoke("categories:update", seriesId, categoryId, input)
  }
});
