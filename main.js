const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// Meal plans are stored in Local Storage and mirrored to this JSON file.
// The renderer never touches the filesystem directly; it asks the main
// process through IPC instead.
const DATA_FILE = path.join(__dirname, 'data', 'recipe.json');

// Read the JSON mirror and always return an array.
function readMealPlanFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) return [];
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.mealPlans)) return parsed.mealPlans;
    return [];
  } catch (error) {
    return [];
  }
}

// IPC READ: the renderer asks for saved plans stored in the JSON file.
ipcMain.on('mealplans:read', event => {
  event.returnValue = readMealPlanFile();
});

// IPC WRITE: the renderer sends the full plan list to be mirrored.
ipcMain.on('mealplans:write', (event, plans) => {
  try {
    const directory = path.dirname(DATA_FILE);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
    const safePlans = Array.isArray(plans) ? plans : [];
    fs.writeFileSync(DATA_FILE, JSON.stringify(safePlans, null, 2));
    event.returnValue = true;
  } catch (error) {
    event.returnValue = false;
  }
});

// Create the application window and load the Discover page.
function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      // The renderer uses Local Storage plus IPC for the JSON data file.
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// Start the application once Electron is ready.
app.whenReady().then(createWindow);

// Quit on Windows/Linux when every window is closed.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Re-open a window when the macOS dock icon is clicked.
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
