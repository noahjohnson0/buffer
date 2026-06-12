const { app, globalShortcut, ipcMain, BrowserWindow, desktopCapturer } = require('electron');
const path = require('path');
const { menubar } = require('menubar');
const Store = require('electron-store');
const fs = require('fs').promises;
const fsSync = require('fs');

// Initialize store for configuration
const store = new Store({
  defaults: {
    bufferDuration: 30, // seconds
    saveDirectory: app.getPath('documents') + '/Buffer Recordings'
  }
});

let mb;
let recordingWindow = null;
let isRecording = false;
let recordingBuffer = [];
let currentRecordingBlob = null;
let recordingStartTime = null;

// Create menubar app
const iconPath = path.join(__dirname, '../assets/icon.png');
mb = menubar({
  index: `file://${__dirname}/index.html`,
  icon: fsSync.existsSync(iconPath) ? iconPath : undefined,
  tooltip: 'Buffer - Screen Recorder',
  browserWindow: {
    width: 300,
    height: 400,
    resizable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  },
  preloadWindow: true
});

// Hide dock icon on macOS
if (app.dock) {
  app.dock.hide();
}

mb.on('ready', () => {
  console.log('Buffer is ready');
  
  // Register global hotkey (Cmd+Shift+S)
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    saveBuffer();
  });

  // Start continuous recording
  startRecording();
});

// Handle app activation
app.on('activate', () => {
  if (mb.window && !mb.window.isVisible()) {
    mb.showWindow();
  }
});

// Cleanup on quit
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopRecording();
});

// IPC handlers
ipcMain.handle('get-config', () => {
  return {
    bufferDuration: store.get('bufferDuration'),
    saveDirectory: store.get('saveDirectory'),
    isRecording: isRecording
  };
});

ipcMain.handle('update-config', (event, config) => {
  if (config.bufferDuration !== undefined) {
    store.set('bufferDuration', config.bufferDuration);
  }
  if (config.saveDirectory !== undefined) {
    store.set('saveDirectory', config.saveDirectory);
  }
  return store.store;
});

ipcMain.handle('save-buffer-now', () => {
  saveBuffer();
});

ipcMain.handle('get-status', () => {
  return {
    isRecording: isRecording,
    bufferSize: recordingBuffer.length
  };
});

// Handle complete recording blob from recording window
ipcMain.on('recording-blob', (event, blobData) => {
  if (!blobData || !blobData.buffer) return;
  
  const recording = {
    data: Buffer.from(blobData.buffer),
    timestamp: Date.now(),
    duration: blobData.duration || 0
  };
  
  recordingBuffer.push(recording);
  recordingStartTime = Date.now();
  
  // Maintain buffer size (keep only last N seconds)
  const bufferDuration = store.get('bufferDuration') * 1000; // convert to ms
  const now = Date.now();
  let totalDuration = 0;
  
  // Remove old recordings that exceed buffer duration
  recordingBuffer = recordingBuffer.filter((rec, index) => {
    if (index === 0) {
      totalDuration = rec.duration;
      return true;
    }
    totalDuration += rec.duration;
    return totalDuration * 1000 <= bufferDuration;
  });
});

ipcMain.on('recording-started', () => {
  isRecording = true;
  if (mb.window) {
    mb.window.webContents.send('status-update', { isRecording: true });
  }
});

ipcMain.on('recording-error', (event, error) => {
  console.error('Recording error:', error);
  isRecording = false;
  if (mb.window) {
    mb.window.webContents.send('status-update', { isRecording: false, error: error });
  }
});

async function startRecording() {
  if (isRecording) return;
  
  try {
    // Get screen source first
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1, height: 1 }
    });

    if (sources.length === 0) {
      throw new Error('No screen sources available');
    }

    // Create hidden window for recording
    recordingWindow = new BrowserWindow({
      width: 1,
      height: 1,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    // Pass the source ID to the renderer
    recordingWindow.webContents.once('did-finish-load', () => {
      recordingWindow.webContents.send('screen-source', sources[0].id);
    });

    recordingWindow.loadFile(path.join(__dirname, 'recorder.html'));
    
    recordingWindow.on('closed', () => {
      recordingWindow = null;
      isRecording = false;
    });

    console.log('Recording window created');
  } catch (error) {
    console.error('Error starting recording:', error);
    isRecording = false;
  }
}

function stopRecording() {
  if (!isRecording) return;
  
  if (recordingWindow) {
    recordingWindow.close();
    recordingWindow = null;
  }
  
  isRecording = false;
  recordingBuffer = [];
  
  if (mb.window) {
    mb.window.webContents.send('status-update', { isRecording: false });
  }
}

async function saveBuffer() {
  if (!recordingWindow || !isRecording) {
    console.log('Not recording, nothing to save');
    return;
  }

  try {
    // Request the current recording from the recorder window
    // This will stop the current recording, get all data, and restart
    recordingWindow.webContents.send('save-recording');
  } catch (error) {
    console.error('Error requesting save:', error);
  }
}

// Handle the saved recording blob
ipcMain.on('saved-recording', async (event, blobData) => {
  if (!blobData || !blobData.buffer) {
    console.log('No recording data to save');
    return;
  }

  try {
    // Create save directory if it doesn't exist
    const saveDir = store.get('saveDirectory');
    await fs.mkdir(saveDir, { recursive: true });
    
    // Generate filename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `buffer-${timestamp}.webm`;
    const filepath = path.join(saveDir, filename);
    
    // Save the complete blob
    const buffer = Buffer.from(blobData.buffer);
    await fs.writeFile(filepath, buffer);
    
    console.log(`Buffer saved to: ${filepath}`);
    
    // Show notification
    if (mb.window) {
      mb.window.webContents.send('buffer-saved', { filepath });
    }
    
    // Show system notification
    const { Notification } = require('electron');
    new Notification({
      title: 'Buffer Saved',
      body: `Recording saved to ${filename}`,
      silent: false
    }).show();
  } catch (error) {
    console.error('Error saving buffer:', error);
  }
});

// Export for testing
module.exports = { startRecording, stopRecording, saveBuffer };
