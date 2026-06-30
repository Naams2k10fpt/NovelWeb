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
    update: (seriesId: string, input: unknown) => ipcRenderer.invoke("series:update", seriesId, input),
    moveToTrash: (seriesId: string) => ipcRenderer.invoke("series:moveToTrash", seriesId)
  },
  categories: {
    list: (seriesId: string) => ipcRenderer.invoke("categories:list", seriesId),
    get: (seriesId: string, categoryId: string) => ipcRenderer.invoke("categories:get", seriesId, categoryId),
    create: (seriesId: string, input: unknown) => ipcRenderer.invoke("categories:create", seriesId, input),
    update: (seriesId: string, categoryId: string, input: unknown) =>
      ipcRenderer.invoke("categories:update", seriesId, categoryId, input)
  },
  volumes: {
    list: (seriesId: string, categoryId: string) => ipcRenderer.invoke("volumes:list", seriesId, categoryId),
    get: (seriesId: string, categoryId: string, volumeId: string) =>
      ipcRenderer.invoke("volumes:get", seriesId, categoryId, volumeId),
    create: (seriesId: string, categoryId: string, input: unknown) =>
      ipcRenderer.invoke("volumes:create", seriesId, categoryId, input),
    update: (seriesId: string, categoryId: string, volumeId: string, input: unknown) =>
      ipcRenderer.invoke("volumes:update", seriesId, categoryId, volumeId, input)
  },
  chapters: {
    list: (seriesId: string, categoryId: string, volumeId: string | null = null) =>
      ipcRenderer.invoke("chapters:list", seriesId, categoryId, volumeId),
    get: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string) =>
      ipcRenderer.invoke("chapters:get", seriesId, categoryId, volumeId, chapterId),
    create: (seriesId: string, categoryId: string, volumeId: string | null, input: unknown) =>
      ipcRenderer.invoke("chapters:create", seriesId, categoryId, volumeId, input),
    update: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string, input: unknown) =>
      ipcRenderer.invoke("chapters:update", seriesId, categoryId, volumeId, chapterId, input)
  }
});
