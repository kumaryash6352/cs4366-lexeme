import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'

function createWindow() {
  const window = new BrowserWindow({
    title: 'lexeme', width: 1200, height: 800, minWidth: 680, minHeight: 480,
    backgroundColor: '#10141c',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
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

app.whenReady().then(() => {
  app.setName('lexeme')
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
app.on('window-all-closed', () => app.quit())
