import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  library: {
    getCurrent: () => ipcRenderer.invoke("library:getCurrent"),
    chooseFolder: () => ipcRenderer.invoke("library:chooseFolder"),
    repairSeriesIndex: () => ipcRenderer.invoke("library:repairSeriesIndex"),
    createBackup: (type: "metadata" | "content" | "full") => ipcRenderer.invoke("library:createBackup", type),
    restoreFullBackup: () => ipcRenderer.invoke("library:restoreFullBackup")
  },
  trash: {
    list: () => ipcRenderer.invoke("trash:list"),
    restore: (trashId: string) => ipcRenderer.invoke("trash:restore", trashId),
    delete: (trashId: string) => ipcRenderer.invoke("trash:delete", trashId)
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
    move: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string, input: unknown) =>
      ipcRenderer.invoke("chapters:move", seriesId, categoryId, volumeId, chapterId, input),
    getContent: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string) =>
      ipcRenderer.invoke("chapters:getContent", seriesId, categoryId, volumeId, chapterId),
    saveContent: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string, input: unknown) =>
      ipcRenderer.invoke("chapters:saveContent", seriesId, categoryId, volumeId, chapterId, input),
    listVersions: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string) =>
      ipcRenderer.invoke("chapters:listVersions", seriesId, categoryId, volumeId, chapterId),
    restoreVersion: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string, versionId: string) =>
      ipcRenderer.invoke("chapters:restoreVersion", seriesId, categoryId, volumeId, chapterId, versionId),
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
    execute: (importSessionId: string, input: unknown) => ipcRenderer.invoke("import:execute", importSessionId, input)
  },
  export: {
    chapterPdf: (seriesId: string, categoryId: string, volumeId: string | null, chapterId: string) =>
      ipcRenderer.invoke("export:chapterPdf", seriesId, categoryId, volumeId, chapterId),
    volumePdf: (seriesId: string, categoryId: string, volumeId: string) =>
      ipcRenderer.invoke("export:volumePdf", seriesId, categoryId, volumeId)
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
