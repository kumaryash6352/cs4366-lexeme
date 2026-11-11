// Narrow bridge for the sandboxed renderer: a native folder picker, nothing else.
// Sandboxed preloads must be CommonJS, hence .cts and require().
import electron = require('electron')

electron.contextBridge.exposeInMainWorld('lexeme', {
  pickDirectory: (): Promise<string | undefined> => electron.ipcRenderer.invoke('lexeme:pick-directory'),
})
