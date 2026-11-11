import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'

function createWindow() {
  const window = new BrowserWindow({
    title: 'lexeme', width: 1600, height: 1000, minWidth: 900, minHeight: 560, show: false,
    backgroundColor: '#10141c',
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
    },
  })
  // Laid out for a large screen: open maximized.
  window.once('ready-to-show', () => { window.maximize(); window.show() })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  const page = process.env.LEXEME_DEV_URL
    ? window.loadURL(process.env.LEXEME_DEV_URL)
    : window.loadFile(fileURLToPath(new URL('../dist/index.html', import.meta.url)))
  page.catch((error) => {
    console.error('unable to load:', error)
    app.exit(1)
  })
}

ipcMain.handle('lexeme:pick-directory', async event => {
  const owner = BrowserWindow.fromWebContents(event.sender)
  const options = { title: 'Open C project folder', properties: ['openDirectory' as const] }
  const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
  return picked.canceled ? undefined : picked.filePaths[0]
})

app.whenReady().then(() => {
  app.setName('lexeme')
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
app.on('window-all-closed', () => app.quit())
