const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');
const zlib = require('zlib');

// Extra Xenia command-line flags. Empty by default: the dashboard already makes the Xenia
// window cover the game screen, and some Xenia builds reject '--fullscreen'.
const XENIA_ARGS = [];
const XENIA_EXE_NAMES = ['xenia_canary.exe', 'xenia.exe'];

// ---------- per-build data ----------
// Settings, localStorage (profiles, layout, comics library) and Chromium caches live in the user-data folder.
// By default every build gets its own folder, so an old build's state and caches never reach a new one.
// Set KEEP_DATA_ACROSS_BUILDS = true to keep one folder for all builds (upgrades keep the data); then the
// Chromium caches are cleared whenever the build changes, so the new code always runs.
const KEEP_DATA_ACROSS_BUILDS = true;

// A short fingerprint of the code that is shipped: changes whenever index.html, main.js or preload.js change.
function currentBuildId() {
  try {
    const h = crypto.createHash('sha1');
    for (const f of ['index.html', 'main.js', 'preload.js']) h.update(fs.readFileSync(path.join(__dirname, f)));
    return h.digest('hex').slice(0, 12);
  } catch (e) {
    return 'unknown';
  }
}

if (!KEEP_DATA_ACROSS_BUILDS) {
  // dev runs (npm start) and installed builds never share a folder either
  app.setPath('userData', path.join(app.getPath('appData'),
    app.getName() + (app.isPackaged ? '' : '-dev') + ' ' + currentBuildId()));
}

// ---------- settings ----------
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}

function clampInt(v, min, max, def) {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : def;
}

// Display preferences chosen in Settings > Display
// dash: screen the dashboard lives on, game: screen the game opens on,
// mode: 0 stay behind the game, 1 move to another screen, 2 hide while playing
function prefs() {
  const d = loadSettings().display || {};
  return {
    dash: clampInt(d.dash, 0, 7, 0),
    game: clampInt(d.game, 0, 7, 0),
    mode: clampInt(d.mode, 0, 2, 0),
    card: d.card === 0 ? 0 : 1,
  };
}

// ---------- displays ----------
// Primary screen is always index 0, so "Screen 1" in the menu is the main one.
function sortedDisplays() {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter((d) => d.id !== primary.id);
  return [primary, ...others];
}

function displayAt(i) {
  const list = sortedDisplays();
  return list[Math.min(Math.max(0, i | 0), list.length - 1)];
}

// ---------- window ----------
let mainWin = null;
let xeniaProc = null;
let gameRunning = false;

function createWindow() {
  mainWin = new BrowserWindow({
    width: 1920,
    height: 1080,
    show: false, // shown below, already fullscreen, so no flash of a small window
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true, // the Bing tab shows pages in a <webview>; Electron ignores it unless this is on
    },
  });

  mainWin.once('ready-to-show', () => {
    placeDashboard(displayAt(prefs().dash));
    mainWin.show();
  });

  // Hidden shortcut to pick a different Xenia (overrides the bundled one)
  mainWin.webContents.on('before-input-event', async (event, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && input.key.toLowerCase() === 'x') {
      event.preventDefault();
      await chooseXeniaManually();
    }
  });

  // Guest pages of the Bing tab: keep them sandboxed, without the dashboard preload
  mainWin.webContents.on('will-attach-webview', (_e, webPreferences) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });

  mainWin.loadFile(path.join(__dirname, 'index.html'));
}

// Put the dashboard fullscreen on a given screen
function placeDashboard(disp) {
  if (!mainWin || mainWin.isDestroyed()) return;
  mainWin.setFullScreen(false);
  mainWin.setBounds(disp.bounds);
  mainWin.setFullScreen(true);
}

function pageCall(js) {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.executeJavaScript(js).catch(() => {});
  }
}

// ---------- Xenia (Xbox 360 emulator) ----------
function findXeniaExe(dir) {
  for (const name of XENIA_EXE_NAMES) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Where the Xenia files come from, first match: a "xenia" folder next to the dashboard exe
// (a newer Xenia can be put there), then the copy bundled inside the app.
function xeniaSourceDir() {
  if (!app.isPackaged) {
    const dev = path.join(__dirname, 'xenia');
    return findXeniaExe(dev) ? dev : null;
  }
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  const candidates = [path.join(exeDir, 'xenia'), path.join(process.resourcesPath, 'xenia')];
  return candidates.find((d) => findXeniaExe(d)) || null;
}

// Copies the Xenia files into a writable folder in the app data directory and returns its exe.
// Xenia writes its config, shader cache, saves and xenia.log next to itself, which fails when it
// runs from Program Files or from inside the app's resources. An existing config file (*.toml)
// in the copy is kept; other files are copied again only when they changed.
function syncXeniaFiles(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) {
      syncXeniaFiles(s, d);
    } else if (ent.isFile()) {
      let ds = null;
      try { ds = fs.statSync(d); } catch (e) {}
      if (ds && /\.toml$/i.test(ent.name)) continue;
      const ss = fs.statSync(s);
      if (!ds || ds.size !== ss.size || ds.mtimeMs < ss.mtimeMs) fs.copyFileSync(s, d);
    }
  }
}

// Xenia keeps its config, log, launch data and saves in the Documents folder, unless a portable.txt
// file is next to the exe. portable.txt makes it use the Xenia folder, where the dashboard looks.
// The first time, saves and config already in Documents\Xenia are copied over, so they are not lost.
function ensurePortable(dir) {
  const marker = path.join(dir, 'portable.txt');
  if (fs.existsSync(marker)) return;
  fs.writeFileSync(marker, 'Keeps the Xenia files in this folder (created by x360launcher).\n');
  const oldDir = path.join(app.getPath('documents'), 'Xenia');
  const oldContent = path.join(oldDir, 'content');
  const newContent = path.join(dir, 'content');
  if (fs.existsSync(oldContent) && !fs.existsSync(newContent)) {
    fs.cpSync(oldContent, newContent, { recursive: true });
  }
  const oldConfig = path.join(oldDir, 'xenia-canary.config.toml');
  const newConfig = path.join(dir, 'xenia-canary.config.toml');
  if (fs.existsSync(oldConfig) && !fs.existsSync(newConfig)) {
    fs.copyFileSync(oldConfig, newConfig);
  }
}

// Readable text inside a binary file (ASCII and UTF-16LE), for the debug file only
function readableStrings(buf, max = 40) {
  const out = new Set();
  const ascii = buf.toString('latin1').match(/[\x20-\x7e]{4,}/g) || [];
  for (const s of ascii) out.add(s);
  const wide = buf.toString('utf16le').match(/[\x20-\x7e]{4,}/g) || [];
  for (const s of wide) out.add(s);
  return [...out].slice(0, max);
}

function bundledXenia() {
  const src = xeniaSourceDir();
  if (!src) return null;
  const dst = path.join(app.getPath('userData'), 'xenia');
  try {
    syncXeniaFiles(src, dst);
    try { ensurePortable(dst); } catch (e) {}
  } catch (e) {
    dialog.showErrorBox('Xenia', 'Xenia files could not be copied:\n' + e.message);
    return null;
  }
  return findXeniaExe(dst);
}

async function chooseXeniaManually() {
  const r = await dialog.showOpenDialog(mainWin, {
    title: 'xenia.exe را انتخاب کنید',
    properties: ['openFile'],
    filters: [{ name: 'Xenia', extensions: ['exe'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;

  const st = loadSettings();
  st.xeniaPath = r.filePaths[0];
  saveSettings(st);
  return st.xeniaPath;
}

async function getXeniaExe() {
  const st = loadSettings();
  if (st.xeniaPath && fs.existsSync(st.xeniaPath)) {
    try { ensurePortable(path.dirname(st.xeniaPath)); } catch (e) {}
    return st.xeniaPath; // manual override
  }
  const bundled = bundledXenia();
  if (bundled) return bundled;
  return chooseXeniaManually();
}

function isXbox360Image(p) {
  return /\.(iso|xex)$/i.test(p);
}

// ---------- PowerShell helpers ----------
function toEncoded(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPs(script, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const ps = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', toEncoded(script)],
      { windowsHide: true }
    );
    let out = '';
    ps.stdout.on('data', (d) => (out += d.toString()));
    const timer = setTimeout(() => {
      ps.kill();
      resolve({ code: -1, out });
    }, timeoutMs);
    ps.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, out: '' });
    });
    ps.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

// ---------- game window (Win32 through PowerShell) ----------
// Electron gives screen sizes in DIPs; Win32 needs physical pixels (DIP x scale factor).
function physicalBounds(disp) {
  const s = disp.scaleFactor || 1;
  return {
    x: Math.round(disp.bounds.x * s),
    y: Math.round(disp.bounds.y * s),
    width: Math.round(disp.bounds.width * s),
    height: Math.round(disp.bounds.height * s),
  };
}

// Script: waits for the game window (by process id or exe name), makes it borderless,
// puts it over the game screen and brings it to the front. Prints READY when done.
// With bounds null it only brings the window to the front.
function winScript({ pid, procName, bounds, timeoutSec }) {
  const lines = [
    "$ErrorActionPreference='SilentlyContinue'",
    `$xpid=${pid | 0}; $pn='${String(procName || '').replace(/'/g, "''")}'`,
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class XbWin {',
    '  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);',
    '  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetWindowLong(IntPtr h, int idx);',
    '  [DllImport("user32.dll", EntryPoint="SetWindowLongW")] public static extern int SetWindowLong(IntPtr h, int idx, int val);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);',
    '  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);',
    '  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);',
    '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    '  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);',
    '}',
    '"@',
  ];
  if (bounds) lines.push(`$tx=${bounds.x}; $ty=${bounds.y}; $tw=${bounds.width}; $th=${bounds.height}`);
  lines.push(
    `$deadline=(Get-Date).AddSeconds(${timeoutSec | 0})`,
    'while((Get-Date) -lt $deadline){',
    '  $c=@()',
    '  if($pn){$c+=@(Get-Process -Name $pn -ErrorAction SilentlyContinue)}',
    '  if($xpid -gt 0){$c+=@(Get-Process -Id $xpid -ErrorAction SilentlyContinue)}',
    '  $w=$c | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1',
    '  if($w){',
    '    $h=$w.MainWindowHandle',
    `    [XbWin]::ShowWindow($h,${bounds ? 9 : 5}) | Out-Null`
  );
  if (bounds) {
    lines.push(
      '    $st=[XbWin]::GetWindowLong($h,-16)',
      '    $st=($st -band (-bnot 0x00CF0000)) -bor [int]::MinValue -bor 0x10000000',
      '    [XbWin]::SetWindowLong($h,-16,$st) | Out-Null',
      '    [XbWin]::SetWindowPos($h,[IntPtr](-1),$tx,$ty,$tw,$th,0x0060) | Out-Null',
      '    [XbWin]::SetWindowPos($h,[IntPtr](-2),$tx,$ty,$tw,$th,0x0060) | Out-Null'
    );
  }
  lines.push(
    '    $fg=[XbWin]::GetForegroundWindow(); $ft=[XbWin]::GetWindowThreadProcessId($fg,[IntPtr]::Zero); $me=[XbWin]::GetCurrentThreadId()',
    '    [XbWin]::AttachThreadInput($me,$ft,$true) | Out-Null',
    '    [XbWin]::keybd_event(0x12,0,0,[UIntPtr]::Zero); [XbWin]::keybd_event(0x12,0,2,[UIntPtr]::Zero)',
    '    [XbWin]::BringWindowToTop($h) | Out-Null',
    '    [XbWin]::SetForegroundWindow($h) | Out-Null',
    '    [XbWin]::AttachThreadInput($me,$ft,$false) | Out-Null',
    '    Write-Output "READY"',
    '    exit 0',
    '  }',
    '  Start-Sleep -Milliseconds 250',
    '}',
    'exit 1'
  );
  return lines.join('\n');
}

// Runs a window script; cb(true) only when it printed READY
function runWindowScript(script, cb) {
  const ps = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', toEncoded(script)],
    { windowsHide: true }
  );
  let out = '';
  ps.stdout.on('data', (d) => (out += d.toString()));
  ps.on('error', () => cb(false));
  ps.on('close', () => cb(out.includes('READY')));
  return ps;
}

// ---------- game lifecycle ----------
// Read by the dashboard's loading screen (window.XBOX_STATE):
// launching: waiting for the game window; running: game process alive;
// open: the game window is on the game screen.
const gameState = { launching: new Set(), running: new Set(), open: new Set() };
let winWatch = null; // PowerShell that waits for / places the game window

function stateSnapshot() {
  return {
    launching: [...gameState.launching],
    running: [...gameState.running],
    open: [...gameState.open],
  };
}

// The game window is on the game screen: release the loading screen
function gameOpened(g) {
  winWatch = null;
  gameState.launching.delete(g.path);
  gameState.open.add(g.path);
  pageCall('window.__xbGameReady && window.__xbGameReady()');
  if (g.pr.card) pageCall(`window.__xbGameStarted && window.__xbGameStarted(${JSON.stringify(g.name)})`);
  if (!mainWin || mainWin.isDestroyed()) return;

  if (g.pr.mode === 2) {
    mainWin.hide();
  } else if (g.pr.mode === 1) {
    const gameId = displayAt(g.pr.game).id;
    const other = sortedDisplays().find((d) => d.id !== gameId);
    if (other) {
      placeDashboard(other);
      // Moving the dashboard can take the focus; give it back to the game
      setTimeout(() => runWindowScript(winScript({ pid: g.pid, procName: g.procName, bounds: null, timeoutSec: 3 }), () => {}), 400);
    }
  }
  // mode 0: the dashboard stays where it is, behind the game
}

// Waits for the game window and places it on the chosen game screen.
// The loading screen stays up until this succeeds.
function watchGameWindow(g) {
  const script = winScript({
    pid: g.pid,
    procName: g.procName,
    bounds: physicalBounds(displayAt(g.pr.game)),
    timeoutSec: 180,
  });
  const ps = runWindowScript(script, (ok) => {
    // A watcher that was stopped or replaced (for example when Xenia restarts) reports nothing
    if (winWatch !== ps) return;
    winWatch = null;
    if (ok && gameState.launching.has(g.path)) {
      gameOpened(g);
    } else if (gameState.launching.has(g.path)) {
      gameState.launching.delete(g.path);
      if (gameState.running.has(g.path)) {
        pageCall('typeof toast==="function"&&toast("Game window was not found")');
      }
    }
  });
  winWatch = ps;
}

// Launch failed before a game ran
function abortLaunch(gamePath) {
  gameRunning = false;
  gameState.launching.delete(gamePath);
  gameState.running.delete(gamePath);
  pageCall('window.__xbGameReady && window.__xbGameReady()');
}

// The game process ended: drop it and bring the dashboard back fullscreen
function endGame(gamePath, pr) {
  if (!gameRunning) return;
  gameRunning = false;
  gameState.running.delete(gamePath);
  gameState.launching.delete(gamePath);
  gameState.open.delete(gamePath);
  if (winWatch) {
    try { winWatch.kill(); } catch (e) {}
    winWatch = null;
  }
  pageCall('window.__xbGameReady && window.__xbGameReady()');
  pageCall('window.__xbGameStopped && window.__xbGameStopped()');
  if (!mainWin || mainWin.isDestroyed()) return;
  placeDashboard(displayAt(pr.dash));
  mainWin.show();
  mainWin.focus();
}

// Xenia reports its state in xenia.log and on its console:
//  - "Failed to launch title": the title could not be loaded, so Xenia is started again.
//  - "Launching new title" / "Title closed with new launch data": the game asked for another
//    title (many Xbox 360 games start a second XEX this way). Xenia keeps that title in
//    launch_data.bin, so Xenia is started again WITHOUT the game path and loads that title,
//    instead of starting the original game from the beginning.
const XENIA_MAX_FAILS = 2;      // a title that will not load is tried this many times
const XENIA_MAX_SWITCHES = 12;  // title switches allowed in one play session
const XENIA_RESTART_TEXT = /Launching new title|Title closed with new launch data/i;
const XENIA_FAIL_TEXT = /Failed to launch title/i;

// Reads the new part of xenia.log and calls onHit('failed' | 'restart') for every event found.
// Returns { flush, stop }: flush reads what is new right now, stop ends the watch.
function watchXeniaLog(xeniaDir, startSize, onHit, onChunk) {
  const logPath = path.join(xeniaDir, 'xenia.log');
  let pos = startSize;
  let stopped = false;
  const check = () => {
    if (stopped) return;
    try {
      const size = fs.statSync(logPath).size;
      if (size < pos) pos = 0; // the log was rewritten by a new run
      if (size > pos) {
        const fd = fs.openSync(logPath, 'r');
        const buf = Buffer.alloc(size - pos);
        fs.readSync(fd, buf, 0, buf.length, pos);
        fs.closeSync(fd);
        pos = size;
        const txt = buf.toString('utf8');
        if (onChunk) onChunk(txt);
        if (XENIA_FAIL_TEXT.test(txt)) onHit('failed');
        if (XENIA_RESTART_TEXT.test(txt)) onHit('restart');
      }
    } catch (e) {
      // log not created yet
    }
  };
  const timer = setInterval(check, 700);
  return {
    flush: check,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}

// Xenia keeps the title it wants to load next in a file named launch_data.bin. Its exact place is
// not known, so the Xenia folder and its subfolders (3 levels) are searched. With "since" given,
// only files written at or after that time count, so a file left over from an earlier session is ignored.
function findPendingTitle(xeniaDir, since = 0) {
  const found = [];
  const walk = (dir, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of ents) {
      const p = path.join(dir, ent.name);
      if (ent.isFile() && /^launch_data\.bin$/i.test(ent.name)) {
        try { if (fs.statSync(p).mtimeMs >= since) found.push(p); } catch (e) {}
      } else if (ent.isDirectory() && depth < 3) {
        walk(p, depth + 1);
      }
    }
  };
  walk(xeniaDir, 0);
  return found;
}

// A title that Xenia could not load is forgotten, so the next start uses the game's own path
function clearLaunchData(xeniaDir) {
  for (const f of findPendingTitle(xeniaDir, 0)) {
    try { fs.rmSync(f, { force: true }); } catch (e) {}
  }
}

function logSizeOf(xeniaDir) {
  try { return fs.statSync(path.join(xeniaDir, 'xenia.log')).size; } catch (e) { return 0; }
}

// The last lines Xenia wrote during this start
function xeniaLogTail(xeniaDir, startSize) {
  try {
    const logPath = path.join(xeniaDir, 'xenia.log');
    const size = fs.statSync(logPath).size;
    const from = Math.max(size < startSize ? 0 : startSize, size - 64 * 1024);
    const buf = Buffer.alloc(size - from);
    const fd = fs.openSync(logPath, 'r');
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-15).join('\n');
  } catch (e) {
    return '';
  }
}

function showXeniaError(xeniaDir, startSize, reason) {
  const tail = xeniaLogTail(xeniaDir, startSize);
  dialog.showErrorBox(
    'Xenia',
    reason + '\n\n' + (tail || 'More details: dashboard-debug.txt in the xenia folder.')
  );
}

// Lists the files in a folder (names, sizes, times) for the debug file, to see where Xenia keeps them
function listTree(dir, maxDepth, depth = 0, out = [], max = 300) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of ents) {
    if (out.length >= max) break;
    const p = path.join(dir, ent.name);
    let info = '';
    try {
      const st = fs.statSync(p);
      info = (ent.isDirectory() ? 'DIR' : st.size + ' bytes') + '  ' + new Date(st.mtimeMs).toISOString();
    } catch (e) {}
    out.push('  '.repeat(depth) + ent.name + '  ' + info);
    if (ent.isDirectory() && depth < maxDepth) listTree(p, maxDepth, depth + 1, out, max);
  }
  return out;
}

// Closes Xenia completely: this process, then any Xenia left running, and waits until they are gone
function killXenia(pid) {
  const run = (args) => new Promise((resolve) => {
    const tk = spawn('taskkill', args, { windowsHide: true });
    tk.on('close', resolve);
    tk.on('error', resolve);
  });
  return run(['/PID', String(pid), '/T', '/F'])
    .then(() => run(['/IM', 'xenia_canary.exe', '/F']))
    .then(() => run(['/IM', 'xenia.exe', '/F']))
    .then(() => new Promise((r) => setTimeout(r, 800)));
}

// ---------- saved "new title" per game ----------
// Xenia's new-title file for a game is kept per game, so the next start can load the game's own
// title directly and skip the first dialog. The key changes when the ISO file changes.
function titleCacheDir(gamePath) {
  let st = null;
  try { st = fs.statSync(gamePath); } catch (e) {}
  const id = gamePath + '|' + (st ? st.size + '|' + Math.round(st.mtimeMs) : '');
  const key = crypto.createHash('sha1').update(id).digest('hex').slice(0, 16);
  return path.join(app.getPath('userData'), 'title-cache', key);
}

function saveTitleCache(gamePath, xeniaDir, files) {
  const dir = titleCacheDir(gamePath);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const f of files) {
    const dst = path.join(dir, path.relative(xeniaDir, f));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(f, dst);
  }
  fs.writeFileSync(path.join(dir, 'game.txt'), gamePath);
}

// Copies the saved files back into the Xenia folder. Returns false when nothing is saved.
function restoreTitleCache(gamePath, xeniaDir) {
  const dir = titleCacheDir(gamePath);
  const marker = path.join(dir, 'game.txt');
  const files = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of ents) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile() && p !== marker) files.push(p);
    }
  };
  walk(dir);
  if (!files.length) return false;
  for (const f of files) {
    const dst = path.join(xeniaDir, path.relative(dir, f));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(f, dst);
  }
  return true;
}

function clearTitleCache(gamePath) {
  try { fs.rmSync(titleCacheDir(gamePath), { recursive: true, force: true }); } catch (e) {}
}

async function launchXbox360(gamePath, gname, run = { fails: 0, switches: 0, noTitle: 0, withPath: true, cacheSaved: false, fresh: true }) {
  gameRunning = true;
  gameState.launching.add(gamePath);
  const xenia = await getXeniaExe();
  if (!xenia) {
    abortLaunch(gamePath);
    dialog.showErrorBox(
      'Xenia',
      'xenia.exe was not found.\n\nCopy Xenia (xenia.exe or xenia_canary.exe with all of its files) ' +
        'into the "xenia" folder next to x360launcher.exe, or choose it with Ctrl+Shift+X.'
    );
    return;
  }

  const pr = prefs();
  const xeniaDir = path.dirname(xenia);

  // A fresh start from the game list first clears new-title files left by an earlier session,
  // then starts from the saved title of this game when there is one
  let withPath = run.withPath;
  let fromCache = false;
  if (run.fresh) {
    for (const f of findPendingTitle(xeniaDir, 0)) {
      try { fs.rmSync(f, { force: true }); } catch (e) {}
    }
    if (withPath && restoreTitleCache(gamePath, xeniaDir)) {
      withPath = false;
      fromCache = true;
    }
  }

  const logStart = logSizeOf(xeniaDir);
  const args = withPath ? [...XENIA_ARGS, gamePath] : [...XENIA_ARGS];
  const proc = spawn(xenia, args, {
    cwd: xeniaDir, // Xenia reads its config and writes xenia.log next to the exe
  });
  xeniaProc = proc;
  gameState.running.add(gamePath);

  const dbg = (line) => {
    try {
      fs.appendFileSync(
        path.join(xeniaDir, 'dashboard-debug.txt'),
        new Date().toISOString() + ' ' + line.replace(/\r/g, '') + '\n'
      );
    } catch (e) {}
  };
  dbg('--- start fails=' + run.fails + ' switches=' + run.switches + ' noTitle=' + run.noTitle +
    ' withPath=' + withPath + ' fromCache=' + fromCache + ' ' + gamePath);

  const dumpFiles = (why) => {
    dbg('--- files in xenia folder (' + why + ')');
    for (const l of listTree(xeniaDir, 4)) dbg(l);
    dbg('--- files in app data folder (' + why + ')');
    for (const l of listTree(app.getPath('userData'), 0)) dbg(l);
    for (const f of findPendingTitle(xeniaDir, 0)) {
      try {
        const buf = fs.readFileSync(f);
        dbg('--- readable text in ' + path.relative(xeniaDir, f) + ' (' + buf.length + ' bytes):');
        for (const t of readableStrings(buf)) dbg('    ' + t);
      } catch (e) {}
    }
  };

  let restartKind = null; // 'failed' or 'restart' once a new start has been requested
  let switchAt = 0;       // time Xenia reported a title switch
  let killing = null;

  // Closes Xenia the normal way (like the X button), so Xenia can save the new title first.
  // Force-closes it only if it is still open after 20 seconds.
  const closeXenia = () => new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    const tk = spawn('taskkill', ['/PID', String(proc.pid), '/T'], { windowsHide: true });
    tk.on('error', () => {});
    tk.on('close', () => {});
    const timer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        killXenia(proc.pid).then(resolve);
      } else {
        resolve();
      }
    }, 20000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  const stopForRestart = (kind) => {
    if (restartKind) return;
    restartKind = kind;
    dbg('--- closing Xenia to start again: ' + kind);
    if (winWatch) {
      try { winWatch.kill(); } catch (e) {}
      winWatch = null;
    }
    killing = kind === 'restart' ? closeXenia() : killXenia(proc.pid);
  };

  const onEvent = (kind) => {
    if (restartKind) return;
    if (kind === 'failed') {
      stopForRestart('failed');
      return;
    }
    // The dialog "Launching new title" is shown at this point and waits for the user,
    // so Xenia has to be closed and started again.
    if (switchAt) return;
    switchAt = Date.now();
    dumpFiles('title switch seen');
    stopForRestart('restart');
  };

  const stopLog = watchXeniaLog(xeniaDir, logStart, onEvent, (t) => dbg('LOG: ' + t));
  // Xenia's console output is read too, in case the message is not written to the log
  const onOutput = (d) => {
    const txt = d.toString();
    dbg('OUT: ' + txt);
    if (XENIA_FAIL_TEXT.test(txt)) onEvent('failed');
    if (XENIA_RESTART_TEXT.test(txt)) onEvent('restart');
  };
  if (proc.stdout) proc.stdout.on('data', onOutput);
  if (proc.stderr) proc.stderr.on('data', onOutput);

  proc.on('error', (err) => {
    xeniaProc = null;
    stopLog.stop();
    abortLaunch(gamePath);
    dialog.showErrorBox('Xenia', 'اجرای Xenia ناموفق بود:\n' + err.message);
  });

  proc.on('exit', (code) => {
    xeniaProc = null;
    stopLog.flush(); // read what Xenia wrote just before it quit
    stopLog.stop();

    if (!restartKind) {
      const opened = gameState.open.has(gamePath);
      if (fromCache && !opened) {
        // The saved title did not start the game: forget it and start from the game file
        dbg('--- saved title did not start, starting from the game file');
        clearTitleCache(gamePath);
        clearLaunchData(xeniaDir);
        if (winWatch) {
          try { winWatch.kill(); } catch (e) {}
          winWatch = null;
        }
        launchXbox360(gamePath, gname, {
          fails: run.fails + 1, switches: run.switches, noTitle: run.noTitle, withPath: true, cacheSaved: false,
        });
        return;
      }
      endGame(gamePath, pr);
      if (!opened && code) {
        showXeniaError(xeniaDir, logStart, 'Xenia closed before the game started (exit code ' + code + ').');
      }
      return;
    }

    if (switchAt) dumpFiles('Xenia closed after title switch');
    const kind = restartKind;
    if (winWatch) {
      try { winWatch.kill(); } catch (e) {}
      winWatch = null;
    }
    Promise.resolve(killing).then(() => {
      if (kind === 'failed') clearLaunchData(xeniaDir);
      const pending = kind === 'restart' ? findPendingTitle(xeniaDir, switchAt - 5000) : [];
      dbg('--- new title files found: ' + pending.length);

      let next;
      if (kind === 'failed') {
        if (fromCache) clearTitleCache(gamePath);
        next = { fails: run.fails + 1, switches: run.switches, noTitle: run.noTitle, withPath: true, cacheSaved: false };
      } else if (fromCache) {
        // The saved title led to another title switch, so it is not usable: start from the game file
        dbg('--- saved title is not usable, starting from the game file');
        clearTitleCache(gamePath);
        clearLaunchData(xeniaDir);
        next = { fails: run.fails, switches: run.switches + 1, noTitle: run.noTitle, withPath: true, cacheSaved: false };
      } else if (pending.length) {
        // Xenia saved the new title: keep it for this game, then start without the game path
        if (!run.cacheSaved) saveTitleCache(gamePath, xeniaDir, pending);
        next = { fails: run.fails, switches: run.switches + 1, noTitle: run.noTitle, withPath: false, cacheSaved: true };
      } else {
        next = { fails: run.fails, switches: run.switches + 1, noTitle: run.noTitle + 1, withPath: true, cacheSaved: run.cacheSaved };
      }

      if (next.fails > XENIA_MAX_FAILS) {
        endGame(gamePath, pr);
        showXeniaError(xeniaDir, logStart, 'Xenia could not load this game.');
        return;
      }
      if (next.noTitle > 1) {
        endGame(gamePath, pr);
        showXeniaError(xeniaDir, logStart, 'Xenia asked for a new title but did not save one, so the game cannot continue.');
        return;
      }
      if (next.switches > XENIA_MAX_SWITCHES) {
        endGame(gamePath, pr);
        return;
      }
      launchXbox360(gamePath, gname, next);
    });
  });

  watchGameWindow({
    path: gamePath,
    name: gname,
    pr,
    pid: proc.pid,
    procName: path.parse(xenia).name,
  });
}

function launchPc(gamePath, gname) {
  gameRunning = true;
  const pr = prefs();
  gameState.launching.add(gamePath);

  if (/\.lnk$/i.test(gamePath)) {
    // Windows opens the shortcut; its exit cannot be tracked, so the game is
    // found through the exe the shortcut points to
    let target = '';
    try { target = shell.readShortcutLink(gamePath).target || ''; } catch (e) {}
    shell.openPath(gamePath);
    gameRunning = false;
    if (target) {
      watchGameWindow({ path: gamePath, name: gname, pr, pid: 0, procName: path.parse(target).name });
    } else {
      setTimeout(() => gameOpened({ path: gamePath, name: gname, pr }), 8000);
    }
    return;
  }

  const child = spawn(gamePath, [], {
    cwd: path.dirname(gamePath), // start from its own folder so data files are found
    stdio: 'ignore',
  });
  gameState.running.add(gamePath);
  child.on('error', (err) => {
    abortLaunch(gamePath);
    dialog.showErrorBox('Launch failed', err.message);
  });
  child.on('exit', () => endGame(gamePath, pr));

  watchGameWindow({
    path: gamePath,
    name: gname,
    pr,
    pid: child.pid,
    procName: path.parse(gamePath).name,
  });
}

// ---------- IPC (called from preload) ----------
ipcMain.on('launch-game', (_e, gamePath, name) => {
  if (typeof gamePath !== 'string' || !fs.existsSync(gamePath)) return;
  if (gameRunning) return;

  const gname = typeof name === 'string' && name ? name.slice(0, 40) : path.parse(gamePath).name;
  if (isXbox360Image(gamePath)) {
    launchXbox360(gamePath, gname);
  } else {
    launchPc(gamePath, gname);
  }
});

// Large assets (avatar models, boot video, logo) live in assets/ next to index.html.
// The renderer can only read the names listed here.
const ASSET_NAMES = new Set(['avatar.glb', 'avatar_f.glb']);
// Synchronous variant, used at startup so the avatar is ready before the first screen is drawn.
ipcMain.on('read-asset-sync', (e, name) => {
  try {
    if (typeof name !== 'string' || !ASSET_NAMES.has(name)) throw new Error('asset not allowed');
    e.returnValue = fs.readFileSync(path.join(__dirname, 'assets', name));
  } catch (err) {
    console.error(err);
    e.returnValue = null;
  }
});
// ---------- updates ----------
// Detection: electron-updater reads latest.yml (or win7.yml) from the GitHub Release.
// Download: the installer comes as a RAR from the same Release (tag v<version>), is unpacked
// in the temp folder with node-unrar-js, and the setup .exe inside it is started when the user
// chooses "Restart to install". The user's data folder is not touched by the installer.
const UPDATE_OWNER = 'Rycroamin';
const UPDATE_REPO = 'x360launcher';
const UPDATE_WIN10 = { rar: 'x360launcher-win10-11.rar', setup: 'x360launcher-setup.exe' };
const UPDATE_WIN7 = { rar: 'x360launcher-win7.rar', setup: 'x360launcher-win7-setup.exe' };

let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { /* not installed yet */ }
let updateState = { status: 'idle', info: '', percent: 0 };
let pendingSetup = null; // full path of the extracted setup .exe, ready to start
let updateBusy = false;

function sendUpdate(patch) {
  updateState = Object.assign({}, updateState, patch);
  BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('update-status', updateState));
}

/* Windows 7 (kernel 6.1), 8 (6.2) and 8.1 (6.3) use the win7 feed and the win7 RAR */
function isWin7Family() { return /^6\.[123]\./.test(require('os').release()); }

/* GitHub release downloads redirect to a CDN host, so follow the redirects by hand */
function httpsGetFollow(url, redirects, onResponse, onError) {
  const https = require('https');
  const req = https.get(url, { headers: { 'User-Agent': 'x360launcher-updater' } }, (res) => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      if (redirects > 8) return onError(new Error('too many redirects'));
      return httpsGetFollow(new URL(res.headers.location, url).toString(), redirects + 1, onResponse, onError);
    }
    onResponse(res);
  });
  req.on('error', onError);
}

function downloadRar(version) {
  return new Promise((resolve, reject) => {
    const spec = isWin7Family() ? UPDATE_WIN7 : UPDATE_WIN10;
    const url = 'https://github.com/' + UPDATE_OWNER + '/' + UPDATE_REPO +
      '/releases/download/v' + version + '/' + spec.rar;
    const dir = path.join(app.getPath('temp'), 'x360launcher-update-' + version);
    fs.mkdirSync(dir, { recursive: true });
    const rarPath = path.join(dir, spec.rar);
    httpsGetFollow(url, 0, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('download failed: HTTP ' + res.statusCode)); }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      let lastPct = -1;
      const out = fs.createWriteStream(rarPath);
      res.on('data', (chunk) => {
        got += chunk.length;
        if (total) {
          const pct = Math.round(got * 100 / total);
          if (pct !== lastPct) { lastPct = pct; sendUpdate({ status: 'downloading', percent: pct }); }
        }
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => resolve({ rarPath, dir, spec }));
      res.pipe(out);
    }, reject);
  });
}

async function extractSetup(rarPath, dir, spec) {
  const unrar = await import('node-unrar-js');
  const extractor = await unrar.createExtractorFromFile({ filepath: rarPath });
  const result = extractor.extract({ files: [spec.setup] });
  const items = [...result.files];
  const item = items.find((f) => f.fileHeader && f.fileHeader.name === spec.setup);
  if (!item || !item.extraction) throw new Error(spec.setup + ' is not inside the update archive');
  const setupPath = path.join(dir, spec.setup);
  fs.writeFileSync(setupPath, Buffer.from(item.extraction));
  return setupPath;
}

async function handleUpdateAvailable(version) {
  if (updateBusy) return;
  updateBusy = true;
  try {
    sendUpdate({ status: 'downloading', percent: 0, info: version });
    const { rarPath, dir, spec } = await downloadRar(version);
    pendingSetup = await extractSetup(rarPath, dir, spec);
    try { fs.unlinkSync(rarPath); } catch (e) { /* not important */ }
    sendUpdate({ status: 'ready', info: version, percent: 100 });
  } catch (e) {
    pendingSetup = null;
    sendUpdate({ status: 'error', info: String((e && e.message) || e).slice(0, 80) });
  } finally {
    updateBusy = false;
  }
}

function setupUpdater() {
  if (!autoUpdater || !app.isPackaged) { updateState = { status: 'unavailable', info: '', percent: 0 }; return; }
  autoUpdater.autoDownload = false; // the RAR is downloaded by handleUpdateAvailable
  autoUpdater.autoInstallOnAppQuit = false;
  if (isWin7Family()) autoUpdater.channel = 'win7';
  autoUpdater.on('checking-for-update', () => sendUpdate({ status: 'checking' }));
  autoUpdater.on('update-available', (i) => {
    sendUpdate({ status: 'available', info: i.version });
    handleUpdateAvailable(i.version);
  });
  autoUpdater.on('update-not-available', () => sendUpdate({ status: 'latest' }));
  autoUpdater.on('error', (e) => sendUpdate({ status: 'error', info: String((e && e.message) || e).slice(0, 80) }));
}

async function checkUpdates() {
  if (!autoUpdater || !app.isPackaged) return updateState;
  try { await autoUpdater.checkForUpdates(); }
  catch (e) { sendUpdate({ status: 'error', info: String((e && e.message) || e).slice(0, 80) }); }
  return updateState;
}

ipcMain.handle('update-state', () => updateState);
ipcMain.handle('update-check', () => checkUpdates());
ipcMain.handle('update-install', () => {
  if (updateState.status !== 'ready' || !pendingSetup || !fs.existsSync(pendingSetup)) return;
  // The installer runs as its own process; the launcher closes so the installer can replace its files.
  require('child_process').spawn(pendingSetup, [], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => app.quit(), 500);
});

ipcMain.handle('app-version', () => app.getVersion());
ipcMain.handle('os-user', () => require('os').userInfo().username);
ipcMain.handle('read-asset', async (_e, name) => {
  if (typeof name !== 'string' || !ASSET_NAMES.has(name)) throw new Error('asset not allowed: ' + name);
  return fs.promises.readFile(path.join(__dirname, 'assets', name));
});

ipcMain.handle('pick-game', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: 'فایل بازی را انتخاب کنید',
    properties: ['openFile'],
    filters: [
      { name: 'Games', extensions: ['iso', 'xex', 'exe', 'lnk'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return r.canceled ? null : r.filePaths[0];
});

// ---- Comics: .cbz / .zip files are read in place, page by page (no copy in memory) ----
const IMG_RE = /\.(jpe?g|png|gif|webp|bmp|avif)$/i;
const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', avif: 'image/avif', cbz: 'application/vnd.comicbook+zip', zip: 'application/zip',
};

async function zipCentralDirectory(fh, size) {
  const tailLen = Math.min(size, 65557);
  const tail = Buffer.alloc(tailLen);
  await fh.read(tail, 0, tailLen, size - tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOff = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    // Zip64: the real values are in the Zip64 end record
    const li = eocd - 20;
    if (li < 0 || tail.readUInt32LE(li) !== 0x07064b50) throw new Error('zip64 locator missing');
    const z64Off = Number(tail.readBigUInt64LE(li + 8));
    const z = Buffer.alloc(56);
    await fh.read(z, 0, 56, z64Off);
    if (z.readUInt32LE(0) !== 0x06064b50) throw new Error('zip64 record missing');
    count = Number(z.readBigUInt64LE(32));
    cdSize = Number(z.readBigUInt64LE(40));
    cdOff = Number(z.readBigUInt64LE(48));
  }
  const cd = Buffer.alloc(cdSize);
  await fh.read(cd, 0, cdSize, cdOff);
  const out = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= cd.length; n++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const method = cd.readUInt16LE(p + 10);
    let csize = cd.readUInt32LE(p + 20);
    let usize = cd.readUInt32LE(p + 24);
    let loff = cd.readUInt32LE(p + 42);
    const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
    const name = cd.toString('utf8', p + 46, p + 46 + nlen);
    let x = p + 46 + nlen;
    const xend = x + xlen;
    while (x + 4 <= xend) {
      const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
        if (loff === 0xffffffff) { loff = Number(cd.readBigUInt64LE(q)); q += 8; }
      }
      x += 4 + len;
    }
    out.push({ name, method, csize, loff });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

async function zipEntryBytes(fh, e) {
  const lh = Buffer.alloc(30);
  await fh.read(lh, 0, 30, e.loff);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error('bad zip entry');
  const start = e.loff + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  const raw = Buffer.alloc(e.csize);
  await fh.read(raw, 0, e.csize, start);
  if (e.method === 0) return raw;
  if (e.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('unsupported compression');
}

function isComicPath(p) {
  return typeof p === 'string' && /\.(cbz|zip)$/i.test(p);
}

ipcMain.handle('pick-comics', async () => {
  const r = await dialog.showOpenDialog(mainWin, {
    title: 'Choose comics (CBZ / ZIP)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Comics', extensions: ['cbz', 'zip'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('comic-index', async (_e, filePath) => {
  if (!isComicPath(filePath)) throw new Error('not a comic file');
  const fh = await fs.promises.open(filePath, 'r');
  try {
    const st = await fh.stat();
    const all = await zipCentralDirectory(fh, st.size);
    const pages = all
      .filter((e) => IMG_RE.test(e.name) && !/(^|\/)__MACOSX\//.test(e.name) && !/(^|\/)\./.test(e.name))
      .map((e) => ({ name: e.name, method: e.method, csize: e.csize, loff: e.loff }));
    return { pages };
  } finally {
    await fh.close();
  }
});

ipcMain.handle('comic-page', async (_e, filePath, entry) => {
  if (!isComicPath(filePath)) throw new Error('not a comic file');
  const e = {
    method: Number(entry && entry.method), csize: Number(entry && entry.csize), loff: Number(entry && entry.loff),
  };
  if (![e.method, e.csize, e.loff].every(Number.isFinite)) throw new Error('bad page entry');
  const fh = await fs.promises.open(filePath, 'r');
  try {
    return await zipEntryBytes(fh, e);
  } finally {
    await fh.close();
  }
});

// Files for <input type="file"> (background pictures, etc.) picked with a native dialog
ipcMain.handle('pick-files', async (_e, opts) => {
  const accept = String((opts && opts.accept) || '');
  const exts = [];
  accept.split(',').map((t) => t.trim()).forEach((t) => {
    if (t.startsWith('.')) exts.push(t.slice(1).toLowerCase());
    else if (t.startsWith('image/')) exts.push('png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif');
  });
  const filters = [];
  if (exts.length) filters.push({ name: 'Files', extensions: [...new Set(exts)] });
  filters.push({ name: 'All files', extensions: ['*'] });
  const r = await dialog.showOpenDialog(mainWin, {
    properties: ['openFile', ...(opts && opts.multiple ? ['multiSelections'] : [])],
    filters,
  });
  if (r.canceled) return [];
  return r.filePaths.slice(0, 20).map((p) => ({
    name: path.basename(p),
    type: MIME_BY_EXT[path.extname(p).slice(1).toLowerCase()] || 'application/octet-stream',
    data: fs.readFileSync(p),
  }));
});

ipcMain.handle('game-icon', async (_e, gamePath) => {
  if (typeof gamePath !== 'string' || !/\.exe$/i.test(gamePath)) return null;
  try {
    const img = await app.getFileIcon(gamePath, { size: 'large' });
    return img.toDataURL();
  } catch {
    return null;
  }
});

ipcMain.on('open-url', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
    shell.openExternal(url);
  }
});

// ---------- display settings ----------
ipcMain.handle('displays', () =>
  sortedDisplays().map((d, i) => ({
    index: i,
    primary: i === 0,
    width: d.bounds.width,
    height: d.bounds.height,
  }))
);

ipcMain.on('set-display-prefs', (_e, p) => {
  if (!p || typeof p !== 'object') return;
  const s = loadSettings();
  const before = prefs();
  s.display = {
    dash: clampInt(p.dash, 0, 7, 0),
    game: clampInt(p.game, 0, 7, 0),
    mode: clampInt(p.mode, 0, 2, 0),
    card: p.card ? 1 : 0,
  };
  saveSettings(s);
  // Apply the dashboard screen immediately when it changes and no game is running
  if (!gameRunning && s.display.dash !== before.dash) {
    placeDashboard(displayAt(s.display.dash));
  }
});

// ---------- Bluetooth ----------
// Lists Bluetooth devices. "active" means the device is enabled and present.
ipcMain.handle('bt-list', async () => {
  const script =
    "Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | " +
    "Where-Object { $_.InstanceId -like 'BTHENUM*' } | " +
    'Select-Object InstanceId,FriendlyName,Status | ConvertTo-Json -Compress';
  const r = await runPs(script);
  if (r.code !== 0 && !r.out.trim()) {
    return { devices: [], error: 'Bluetooth list is not available' };
  }
  let arr;
  try {
    const j = JSON.parse(r.out.trim() || '[]');
    arr = Array.isArray(j) ? j : [j];
  } catch {
    return { devices: [], error: 'Could not read the device list' };
  }
  const devices = arr
    .filter((x) => x && x.InstanceId)
    .map((x) => ({
      id: String(x.InstanceId),
      name: x.FriendlyName || 'Bluetooth device',
      active: x.Status === 'OK',
    }));
  return { devices };
});

// Turn on / turn off / forget a device. These need administrator rights, so Windows
// shows a UAC prompt for the action. The result is checked by listing devices again.
ipcMain.handle('bt-action', async (_e, id, action) => {
  if (typeof id !== 'string' || !/^BTHENUM[\\A-Za-z0-9_&{}.\-:+]+$/.test(id)) {
    return { ok: false, error: 'Bad device id' };
  }
  let inner;
  if (action === 'enable') inner = `Enable-PnpDevice -InstanceId '${id}' -Confirm:$false`;
  else if (action === 'disable') inner = `Disable-PnpDevice -InstanceId '${id}' -Confirm:$false`;
  else if (action === 'forget') inner = `pnputil /remove-device '${id}'`;
  else return { ok: false, error: 'Bad action' };

  const outer =
    `$p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden ` +
    `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${toEncoded(inner)}'; ` +
    'exit $p.ExitCode';
  const r = await runPs(outer, 180000);
  if (r.code !== 0) {
    return { ok: false, error: 'Permission was denied or the action failed' };
  }
  return { ok: true };
});

// Opens Windows' own Bluetooth page, where pairing has to be done
ipcMain.on('bt-pair', () => {
  shell.openExternal('ms-settings:bluetooth');
});

// Loading screen state (see gameState above)
ipcMain.handle('state', () => stateSnapshot());

// Turn off: the dashboard plays its exit animation first, then asks to close
ipcMain.on('quit-app', () => app.quit());

// Wi-Fi: the network this PC is on (the modem's name) and the networks around it
ipcMain.handle('wifi', async () => {
  const script =
    "netsh wlan show interfaces; Write-Output '|||'; netsh wlan show networks mode=bssid; Write-Output '|||'; " +
    "Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Up' -and $_.MediaType -eq '802.3' } | Select-Object -First 1 -ExpandProperty Name";
  const r = await runPs(script, 20000);
  const parts = r.out.split('|||');
  const ifaceTxt = parts[0] || '';
  const netTxt = parts[1] || '';
  const wired = (parts[2] || '').trim();

  const kv = {};
  for (const line of ifaceTxt.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:]+?)\s*:\s*(.*)$/);
    if (m) kv[m[1].trim().toLowerCase()] = m[2].trim();
  }
  const ssid = kv.ssid || ''; // netsh shows an SSID only while connected
  const signal = parseInt(kv.signal, 10);

  const found = [];
  let cur = null;
  for (const line of netTxt.split(/\r?\n/)) {
    const h = line.match(/^\s*SSID\s+\d+\s*:\s*(.*)$/i);
    if (h) {
      cur = { ssid: h[1].trim(), signal: null, auth: '' };
      if (cur.ssid) found.push(cur);
      continue;
    }
    const m = line.match(/^\s*([^:]+?)\s*:\s*(.*)$/);
    if (!cur || !m) continue;
    const k = m[1].trim().toLowerCase();
    if (k === 'signal' && cur.signal === null) cur.signal = parseInt(m[2], 10) || 0;
    if (k === 'authentication' && !cur.auth) cur.auth = m[2].trim();
  }

  const seen = new Set();
  const networks = [];
  for (const n of found) {
    if (seen.has(n.ssid)) continue;
    seen.add(n.ssid);
    networks.push({ ssid: n.ssid, signal: n.signal || 0, auth: n.auth, connected: n.ssid === ssid });
  }
  networks.sort((a, b) => (b.connected - a.connected) || (b.signal - a.signal));

  if (!ssid && !networks.length && !kv.name) {
    return { ok: false, connected: false, ethernet: wired, error: 'Wi-Fi is not available on this PC' };
  }
  return {
    ok: true,
    connected: !!ssid,
    ssid,
    signal: isNaN(signal) ? null : signal,
    radio: kv['radio type'] || '',
    ethernet: wired,
    networks,
  };
});

// ---------- app lifecycle ----------
// Links that open a new window from inside the Bing tab load in that same tab
app.on('web-contents-created', (_e, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) contents.loadURL(url).catch(() => {});
    return { action: 'deny' };
  });
});

app.whenReady().then(async () => {
  if (KEEP_DATA_ACROSS_BUILDS) {
    // data is shared, so drop the browser's HTTP and code caches when the build changed
    const stamp = path.join(app.getPath('userData'), 'build-id.txt');
    const id = currentBuildId();
    let prev = '';
    try { prev = fs.readFileSync(stamp, 'utf8'); } catch (e) {}
    if (prev !== id) {
      try { await session.defaultSession.clearCache(); } catch (e) { console.error(e); }
      try { await session.defaultSession.clearCodeCaches({}); } catch (e) { console.error(e); }
      try { fs.writeFileSync(stamp, id); } catch (e) {}
    }
  }
  Menu.setApplicationMenu(null); // no menu bar at all
  createWindow();
  setupUpdater();
  if (app.isPackaged) setTimeout(() => checkUpdates(), 8000); // quiet check shortly after start

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (xeniaProc) xeniaProc.kill();
  if (process.platform !== 'darwin') app.quit();
});
