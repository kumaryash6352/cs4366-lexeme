import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import { createApplication } from '../backend/app.ts'

const server = createApplication({
  logger: true,
  ...(process.env.LEXEME_DEV_URL ? {} : { frontendDir: fileURLToPath(new URL('../../dist/', import.meta.url)) }),
})

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
    : window.loadURL('http://127.0.0.1:3000')
  page.catch((error) => {
    console.error('unable to load:', error)
    app.exit(1)
  })
}

app.whenReady().then(async () => {
  app.setName('lexeme')
  await server.listen({ host: '127.0.0.1', port: 3000 })
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
app.on('before-quit', () => { void server.close() })
app.on('window-all-closed', () => app.quit())
