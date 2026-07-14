const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow;

const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');
const START_URL = isDev
  ? 'http://localhost:3000'
  : (process.env.RIPPLE_URL || 'https://voice-chat-db0a.onrender.com');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Ripple',
    backgroundColor: '#060A10',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  mainWindow.loadURL(START_URL);
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
