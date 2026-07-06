import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("api", {
  library: {
    getCurrent: () => ipcRenderer.invoke("library:getCurrent"),
    chooseFolder: () => ipcRenderer.invoke("library:chooseFolder"),
    repairSeriesIndex: () => ipcRenderer.invoke("library:repairSeriesIndex")
  },
  series: {
    list: () => ipcRenderer.invoke("series:list"),
    get: (seriesId: string) => ipcRenderer.invoke("series:get", seriesId),
    create: (input: unknown) => ipcRenderer.invoke("series:create", input),
    update: (seriesId: string, input: unknown) => ipcRenderer.invoke("series:update", seriesId, input),
    chooseCover: (seriesId: string) => ipcRenderer.invoke("series:chooseCover", seriesId),
    moveToTrash: (seriesId: string) => ipcRenderer.invoke("series:moveToTrash", seriesId)
  },
  categories: {
    list: (seriesId: string) => ipcRenderer.invoke("categories:list", seriesId),
    get: (seriesId: string, categoryId: string) => ipcRenderer.invoke("categories:get", seriesId, categoryId),
    create: (seriesId: string, input: unknown) => ipcRenderer.invoke("categories:create", seriesId, input),
    update: (seriesId: string, categoryId: string, input: unknown) =>
      ipcRenderer.invoke("categories:update", seriesId, categoryId, input),
    moveToTrash: (seriesId: string, categoryId: string) =>
      ipcRenderer.invoke("categories:moveToTrash", seriesId, categoryId)
  },
  volumes: {
    list: (seriesId: string, categoryId: string) => ipcRenderer.invoke("volumes:list", seriesId, categoryId),
    get: (seriesId: string, categoryId: string, volumeId: string) =>
      ipcRenderer.invoke("volumes:get", seriesId, categoryId, volumeId),
    create: (seriesId: string, categoryId: string, input: unknown) =>
      ipcRenderer.invoke("volumes:create", seriesId, categoryId, input),
    update: (seriesId: string, categoryId: string, volumeId: string, input: unknown) =>
      ipcRenderer.invoke("volumes:update", seriesId, categoryId, volumeId, input),
    moveToTrash: (seriesId: string, categoryId: string, volumeId: string) =>
      ipcRenderer.invoke("volumes:moveToTrash", seriesId, categoryId, volumeId)
  },
  chapters: {
    list: (seriesId: string, categoryId: string, volumeId: string | null = null) =>
      ipcRenderer.invoke("chapters:list", seriesId, categoryId, volumeId),
    get: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string) =>
      ipcRenderer.invoke("chapters:get", seriesId, categoryId, volumeId, chapterId),
    create: (seriesId: string, categoryId: string, volumeId: string | null, input: unknown) =>
      ipcRenderer.invoke("chapters:create", seriesId, categoryId, volumeId, input),
    update: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string, input: unknown) =>
      ipcRenderer.invoke("chapters:update", seriesId, categoryId, volumeId, chapterId, input),
    reorder: (seriesId: string, categoryId: string, volumeId: string | null, input: unknown) =>
      ipcRenderer.invoke("chapters:reorder", seriesId, categoryId, volumeId, input),
    getContent: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string) =>
      ipcRenderer.invoke("chapters:getContent", seriesId, categoryId, volumeId, chapterId),
    saveContent: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string, input: unknown) =>
      ipcRenderer.invoke("chapters:saveContent", seriesId, categoryId, volumeId, chapterId, input),
    getOriginalPdf: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string) =>
      ipcRenderer.invoke("chapters:getOriginalPdf", seriesId, categoryId, volumeId, chapterId),
    getOriginalText: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string) =>
      ipcRenderer.invoke("chapters:getOriginalText", seriesId, categoryId, volumeId, chapterId),
    chooseImage: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string) =>
      ipcRenderer.invoke("chapters:chooseImage", seriesId, categoryId, volumeId, chapterId),
    getProgress: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string) =>
      ipcRenderer.invoke("chapters:getProgress", seriesId, categoryId, volumeId, chapterId),
    saveProgress: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string, input: unknown) =>
      ipcRenderer.invoke("chapters:saveProgress", seriesId, categoryId, volumeId, chapterId, input),
    moveToTrash: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string) =>
      ipcRenderer.invoke("chapters:moveToTrash", seriesId, categoryId, volumeId, chapterId)
  },
  import: {
    chooseSourceFolder: () => ipcRenderer.invoke("import:chooseSourceFolder"),
    chooseSourceFiles: () => ipcRenderer.invoke("import:chooseSourceFiles"),
    scan: (importSessionId: string) => ipcRenderer.invoke("import:scan", importSessionId),
    readText: (importSessionId: string, fileId: string) => ipcRenderer.invoke("import:readText", importSessionId, fileId),
    execute: (importSessionId: string, input: unknown) => ipcRenderer.invoke("import:execute", importSessionId, input)
  },
  manga: {
    listPages: (seriesId: string, categoryId: string, chapterId: string) =>
      ipcRenderer.invoke("manga:listPages", seriesId, categoryId, chapterId),
    choosePages: (seriesId: string, categoryId: string, chapterId: string) =>
      ipcRenderer.invoke("manga:choosePages", seriesId, categoryId, chapterId),
    addDroppedPages: (seriesId: string, categoryId: string, chapterId: string, files: File[]) =>
      ipcRenderer.invoke(
        "manga:addDroppedPages",
        seriesId,
        categoryId,
        chapterId,
        files.map((file) => webUtils.getPathForFile(file)).filter(Boolean)
      ),
    getPage: (seriesId: string, categoryId: string, chapterId: string, pageFileName: string) =>
      ipcRenderer.invoke("manga:getPage", seriesId, categoryId, chapterId, pageFileName),
    getProgress: (seriesId: string, categoryId: string, chapterId: string) =>
      ipcRenderer.invoke("manga:getProgress", seriesId, categoryId, chapterId),
    saveProgress: (seriesId: string, categoryId: string, chapterId: string, input: unknown) =>
      ipcRenderer.invoke("manga:saveProgress", seriesId, categoryId, chapterId, input),
    removePages: (seriesId: string, categoryId: string, chapterId: string, input: unknown) =>
      ipcRenderer.invoke("manga:removePages", seriesId, categoryId, chapterId, input),
    reorderPages: (seriesId: string, categoryId: string, chapterId: string, input: unknown) =>
      ipcRenderer.invoke("manga:reorderPages", seriesId, categoryId, chapterId, input)
  },
  search: {
    query: (query: string) => ipcRenderer.invoke("search:query", query),
    rebuild: () => ipcRenderer.invoke("search:rebuild")
  },
  reading: {
    listRecent: () => ipcRenderer.invoke("reading:listRecent")
  },
  bookmarks: {
    list: () => ipcRenderer.invoke("bookmarks:list"),
    get: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string) =>
      ipcRenderer.invoke("bookmarks:get", seriesId, categoryId, volumeId, chapterId),
    toggle: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string, input: unknown) =>
      ipcRenderer.invoke("bookmarks:toggle", seriesId, categoryId, volumeId, chapterId, input)
  },
  highlights: {
    list: () => ipcRenderer.invoke("highlights:list"),
    listForChapter: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string) =>
      ipcRenderer.invoke("highlights:listForChapter", seriesId, categoryId, volumeId, chapterId),
    create: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string, input: unknown) =>
      ipcRenderer.invoke("highlights:create", seriesId, categoryId, volumeId, chapterId, input),
    delete: (seriesId: string, highlightId: string) => ipcRenderer.invoke("highlights:delete", seriesId, highlightId)
  }
});
