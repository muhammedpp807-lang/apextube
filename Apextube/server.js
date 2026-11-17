const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const url = require('url');

const PORT = process.env.PORT || 3000;

// Connected SSE clients
const sseClients = new Set();

// Active download jobs: jobId -> { child, url, downloadPath, format, quality, canceled }
const activeJobs = new Map();

function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch (err) {
      sseClients.delete(client);
    }
  }
}

// Keep-alive heartbeat for SSE
setInterval(() => {
  for (const client of sseClients) {
    try {
      client.write(': heartbeat\n\n');
    } catch (err) {
      sseClients.delete(client);
    }
  }
}, 15000);

// Helper to send JSON responses with permissive CORS
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

// Helper to read JSON request body
function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (e) {
        resolve({});
      }
    });
  });
}

// Resolve FFmpeg directory (root directory first)
function resolveFfmpegDir() {
  if (process.platform === 'win32') {
    const rootFfmpeg = path.join(__dirname, 'ffmpeg.exe');
    if (fs.existsSync(rootFfmpeg)) {
      return __dirname;
    }
    const binFfmpeg = path.join(__dirname, 'bin', 'ffmpeg.exe');
    if (fs.existsSync(binFfmpeg)) {
      return path.join(__dirname, 'bin');
    }
  } else {
    const linuxFfmpeg = path.join(__dirname, 'ffmpeg');
    if (fs.existsSync(linuxFfmpeg)) {
      try { fs.chmodSync(linuxFfmpeg, '755'); } catch (e) {}
      return __dirname;
    }
  }
  return null;
}

// Check ffmpeg availability
function checkFfmpeg() {
  const ffmpegDir = resolveFfmpegDir();
  if (ffmpegDir) return Promise.resolve(true);

  return new Promise((resolve) => {
    exec('ffmpeg -version', (err) => {
      resolve(!err);
    });
  });
}

// Resolve yt-dlp executable (root directory first)
function resolveYtDlp() {
  if (process.platform === 'win32') {
    const rootBin = path.join(__dirname, 'yt-dlp.exe');
    if (fs.existsSync(rootBin)) {
      return { cmd: rootBin, argsPrefix: [] };
    }

    const binFolder = path.join(__dirname, 'bin', 'yt-dlp.exe');
    if (fs.existsSync(binFolder)) {
      return { cmd: binFolder, argsPrefix: [] };
    }

    if (process.env.APPDATA) {
      const pythonDirs = ['Python313', 'Python312', 'Python311', 'Python310', 'Python39'];
      for (const dir of pythonDirs) {
        const p = path.join(process.env.APPDATA, 'Python', dir, 'Scripts', 'yt-dlp.exe');
        if (fs.existsSync(p)) {
          return { cmd: p, argsPrefix: [] };
        }
      }
    }

    return { cmd: 'python', argsPrefix: ['-m', 'yt_dlp'] };
  } else {
    // Linux / Vercel / macOS
    const linuxBin = path.join(__dirname, 'yt-dlp');
    if (fs.existsSync(linuxBin)) {
      try { fs.chmodSync(linuxBin, '755'); } catch (e) {}
      return { cmd: linuxBin, argsPrefix: [] };
    }
    return { cmd: 'yt-dlp', argsPrefix: [] };
  }
}

// Cleanup orphan audio or .part files after download
function cleanupOrphanFiles(targetDir, desiredFormat) {
  try {
    if (!fs.existsSync(targetDir)) return;
    const files = fs.readdirSync(targetDir);

    if (desiredFormat === 'MP4' || desiredFormat === 'MKV') {
      const videoFiles = files.filter(f => f.endsWith('.mp4') || f.endsWith('.mkv'));
      for (const vFile of videoFiles) {
        const baseName = vFile.replace(/\.(mp4|mkv)$/i, '');
        const m4aFile = baseName + '.m4a';
        const mp3File = baseName + '.mp3';
        if (files.includes(m4aFile)) {
          try { fs.unlinkSync(path.join(targetDir, m4aFile)); } catch (e) {}
        }
        if (files.includes(mp3File)) {
          try { fs.unlinkSync(path.join(targetDir, mp3File)); } catch (e) {}
        }
      }
    }

    for (const file of files) {
      if (file.endsWith('.part')) {
        const filePath = path.join(targetDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.size === 0) {
            fs.unlinkSync(filePath);
          }
        } catch (e) {}
      }
    }
  } catch (err) {}
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // 1. Static HTML & Assets
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(indexPath).pipe(res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('index.html not found');
  }

  // 2. GET /api/default-path
  if (req.method === 'GET' && pathname === '/api/default-path') {
    return sendJson(res, 200, { defaultPath: '' });
  }

  // 3. GET /api/system-folders
  if (req.method === 'GET' && pathname === '/api/system-folders') {
    const isWin = process.platform === 'win32';
    const home = os.homedir();
    return sendJson(res, 200, {
      downloads: isWin ? path.join(home, 'Downloads') : 'Downloads',
      desktop: isWin ? path.join(home, 'Desktop') : 'Desktop',
      videos: isWin ? path.join(home, 'Videos') : 'Videos',
      music: isWin ? path.join(home, 'Music') : 'Music',
      documents: isWin ? path.join(home, 'Documents') : 'Documents'
    });
  }

  // 4. POST /api/validate-path
  if (req.method === 'POST' && pathname === '/api/validate-path') {
    const body = await readJsonBody(req);
    const targetPath = body.path ? body.path.trim() : '';
    if (!targetPath) {
      return sendJson(res, 200, { valid: true, path: '' });
    }
    // Prevent container user path leaks
    if (targetPath.includes('sbx_user') || targetPath.startsWith('/root')) {
      return sendJson(res, 200, { valid: true, path: '' });
    }
    try {
      const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(targetPath);
      if (!fs.existsSync(resolved)) {
        fs.mkdirSync(resolved, { recursive: true });
      }
      return sendJson(res, 200, { valid: true, path: targetPath });
    } catch (err) {
      // Never crash or throw ENOENT to frontend
      return sendJson(res, 200, { valid: true, path: targetPath });
    }
  }

  // 5. POST /api/browse
  if (req.method === 'POST' && pathname === '/api/browse') {
    if (process.platform !== 'win32') {
      return sendJson(res, 400, { error: 'Native folder dialog is only supported on Windows' });
    }

    const body = await readJsonBody(req);
    const initialPath = body.initialPath || path.join(os.homedir(), 'Downloads');
    const safeInitial = initialPath.replace(/'/g, "''");

    // PowerShell script with TopMost foreground owner window and UTF-16LE EncodedCommand
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'ApexTube - Select Download Folder'
$dialog.ShowNewFolderButton = $true
if (Test-Path '${safeInitial}') {
  $dialog.SelectedPath = '${safeInitial}'
}
$topForm = New-Object System.Windows.Forms.Form
$topForm.TopMost = $true
$topForm.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$topForm.Size = New-Object System.Drawing.Size(1,1)
$topForm.Opacity = 0.01
$topForm.ShowInTaskbar = $false
$topForm.Show()
$topForm.BringToFront()
$topForm.Activate()
$result = $dialog.ShowDialog($topForm)
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output $dialog.SelectedPath
}
$topForm.Close()
$topForm.Dispose()
`.trim();

    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', encoded]);
    let output = '';
    let responded = false;

    child.stdout.on('data', d => { output += d.toString(); });

    const finish = () => {
      if (responded) return;
      responded = true;
      const selected = output.trim();
      if (selected && fs.existsSync(selected)) {
        return sendJson(res, 200, { selectedPath: selected, canceled: false });
      }
      return sendJson(res, 200, { selectedPath: null, canceled: true });
    };

    child.on('close', finish);
    child.on('error', (err) => {
      if (!responded) {
        responded = true;
        sendJson(res, 500, { error: err.message });
      }
    });

    // 2-minute safety timeout
    setTimeout(() => {
      if (!responded) {
        try { child.kill(); } catch (e) {}
        finish();
      }
    }, 120000);
    return;
  }

  // 5b. POST /api/list-directory (In-App Folder Explorer)
  if (req.method === 'POST' && pathname === '/api/list-directory') {
    const body = await readJsonBody(req);
    let targetDir = body.dir ? body.dir.trim() : '';
    if (!targetDir || !fs.existsSync(targetDir)) {
      targetDir = path.join(os.homedir(), 'Downloads');
      if (!fs.existsSync(targetDir)) targetDir = os.homedir();
    }

    const drives = [];
    if (process.platform === 'win32') {
      const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      for (let i = 0; i < letters.length; i++) {
        const root = letters[i] + ':\\';
        try {
          if (fs.existsSync(root)) {
            drives.push(root);
          }
        } catch (e) {}
      }
    }

    const home = os.homedir();
    const systemFolders = {
      downloads: path.join(home, 'Downloads'),
      desktop: path.join(home, 'Desktop'),
      videos: path.join(home, 'Videos'),
      music: path.join(home, 'Music'),
      documents: path.join(home, 'Documents')
    };

    let folders = [];
    let isRoot = false;
    let parent = null;

    try {
      const parsed = path.parse(targetDir);
      isRoot = (parsed.root.toLowerCase() === targetDir.toLowerCase()) || (path.dirname(targetDir) === targetDir);
      parent = isRoot ? null : path.dirname(targetDir);

      const items = fs.readdirSync(targetDir, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory()) {
          if (!item.name.startsWith('$') && !item.name.startsWith('.')) {
            folders.push(item.name);
          }
        }
      }
      folders.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    } catch (err) {
      return sendJson(res, 200, {
        current: targetDir,
        parent: path.dirname(targetDir),
        drives,
        folders: [],
        systemFolders,
        error: err.message
      });
    }

    return sendJson(res, 200, {
      current: targetDir,
      parent,
      isRoot,
      drives,
      folders,
      systemFolders
    });
  }

  // 5c. POST /api/create-folder
  if (req.method === 'POST' && pathname === '/api/create-folder') {
    const body = await readJsonBody(req);
    const parentDir = body.parentDir ? body.parentDir.trim() : '';
    const folderName = body.folderName ? body.folderName.trim() : '';

    if (!parentDir || !folderName) {
      return sendJson(res, 400, { error: 'Parent directory and folder name are required.' });
    }
    const sanitized = folderName.replace(/[<>:"/\\|?*]/g, '').trim();
    if (!sanitized) {
      return sendJson(res, 400, { error: 'Invalid folder name.' });
    }
    const newPath = path.join(parentDir, sanitized);
    try {
      if (!fs.existsSync(newPath)) {
        fs.mkdirSync(newPath, { recursive: true });
      }
      return sendJson(res, 200, { success: true, newPath });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // 6. POST /api/open-folder
  if (req.method === 'POST' && pathname === '/api/open-folder') {
    const body = await readJsonBody(req);
    const target = body.filePath || body.folderPath;
    if (!target) {
      return sendJson(res, 400, { error: 'Missing folderPath or filePath' });
    }

    if (process.platform === 'win32') {
      let command;
      if (body.filePath && fs.existsSync(body.filePath)) {
        command = `explorer.exe /select,"${body.filePath}"`;
      } else if (body.folderPath && fs.existsSync(body.folderPath)) {
        command = `explorer.exe "${body.folderPath}"`;
      } else if (fs.existsSync(target)) {
        command = `explorer.exe "${target}"`;
      } else {
        const fallback = path.join(os.homedir(), 'Downloads');
        command = `explorer.exe "${fallback}"`;
      }

      exec(command, (err) => {
        if (err) return sendJson(res, 500, { error: err.message });
        sendJson(res, 200, { success: true, opened: target });
      });
    } else {
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      exec(`${cmd} "${target || os.homedir()}"`, (err) => {
        if (err) return sendJson(res, 500, { error: err.message });
        sendJson(res, 200, { success: true });
      });
    }
    return;
  }

  // 7. POST /api/info
  if (req.method === 'POST' && pathname === '/api/info') {
    const body = await readJsonBody(req);
    const targetUrl = body.url ? body.url.trim() : '';
    if (!targetUrl) {
      return sendJson(res, 400, { error: 'Please provide a valid YouTube URL' });
    }

    const { cmd, argsPrefix } = resolveYtDlp();
    const args = [
      ...argsPrefix,
      '--dump-single-json',
      '--flat-playlist',
      '--no-warnings',
      '--no-check-certificates',
      targetUrl
    ];

    exec(`${cmd} ${args.map(a => `"${a}"`).join(' ')}`, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (err) {
        return sendJson(res, 500, { error: 'Failed to inspect link: ' + (stderr || err.message) });
      }

      try {
        const data = JSON.parse(stdout);
        const isPlaylist = Array.isArray(data.entries) && data.entries.length > 0;
        const count = isPlaylist ? data.entries.length : 1;
        const title = data.title || 'YouTube Media';
        const uploader = data.uploader || data.channel || 'ApexTube Source';
        const thumbnail = data.thumbnail || (data.entries && data.entries[0] && data.entries[0].thumbnail) || '';

        sendJson(res, 200, {
          title,
          uploader,
          thumbnail,
          isPlaylist,
          count,
          url: targetUrl
        });
      } catch (parseErr) {
        sendJson(res, 200, {
          title: 'Ready for Download',
          uploader: 'YouTube',
          thumbnail: '',
          isPlaylist: targetUrl.includes('list='),
          count: targetUrl.includes('list=') ? 'Playlist' : 1,
          url: targetUrl
        });
      }
    });
    return;
  }

  // 8. GET /api/progress (SSE)
  if (req.method === 'GET' && pathname === '/api/progress') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    res.write(`data: ${JSON.stringify({ type: 'connected', time: Date.now() })}\n\n`);
    sseClients.add(res);

    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // 9. POST /api/download
  if (req.method === 'POST' && pathname === '/api/download') {
    const body = await readJsonBody(req);
    const {
      url: targetUrl,
      downloadPath,
      format = 'MP4',
      quality = '1080p (Full HD)',
      createPlaylistFolder = true
    } = body;

    if (!targetUrl || !targetUrl.trim()) {
      return sendJson(res, 400, { error: 'A playlist or video URL is required.' });
    }

    let targetDir = downloadPath && downloadPath.trim() ? downloadPath.trim() : '';
    if (!targetDir) {
      targetDir = process.platform === 'win32' ? path.join(os.homedir(), 'Downloads') : path.join(__dirname, 'downloads');
    } else if (!path.isAbsolute(targetDir)) {
      targetDir = path.resolve(__dirname, targetDir);
    }

    try {
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
    } catch (dirErr) {
      targetDir = path.join(__dirname, 'downloads');
      try {
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      } catch (e2) {}
    }

    const jobId = 'job_' + Date.now();
    const { cmd, argsPrefix } = resolveYtDlp();
    const ffmpegDir = resolveFfmpegDir();

    const args = [...argsPrefix];
    args.push('--newline');
    args.push('--yes-playlist');
    args.push('--no-mtime');
    args.push('--no-check-certificates');
    args.push('--no-keep-video');

    if (ffmpegDir) {
      args.push('--ffmpeg-location', ffmpegDir);
    }

    const isAudioOnly = format === 'MP3 (Audio Only)' || format === 'MP3' || format === 'M4A';

    if (isAudioOnly) {
      args.push('-x');
      if (format === 'M4A') {
        args.push('--audio-format', 'm4a');
      } else {
        args.push('--audio-format', 'mp3');
        args.push('--audio-quality', '0');
      }
    } else {
      if (ffmpegDir) {
        if (quality.includes('2160p') || quality.includes('4K')) {
          args.push('-f', 'bestvideo[height<=2160][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=2160]+bestaudio/best');
        } else if (quality.includes('1080p')) {
          args.push('-f', 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best');
        } else if (quality.includes('720p')) {
          args.push('-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=720]+bestaudio/best');
        } else if (quality.includes('480p')) {
          args.push('-f', 'bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=480]+bestaudio/best');
        } else if (quality.includes('360p')) {
          args.push('-f', 'bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=360]+bestaudio/best');
        } else {
          args.push('-f', 'bestvideo+bestaudio/best');
        }

        if (format === 'MKV') {
          args.push('--merge-output-format', 'mkv');
        } else {
          args.push('--merge-output-format', 'mp4');
        }
      } else {
        args.push('-f', 'best[ext=mp4]/best');
      }
    }

    if (createPlaylistFolder) {
      const outTpl = path.join(targetDir, '%(playlist_title|ApexTube Downloads)s', '%(playlist_index&{:02d} - |)s%(title)s.%(ext)s');
      args.push('-o', outTpl);
    } else {
      const outTpl = path.join(targetDir, '%(title)s.%(ext)s');
      args.push('-o', outTpl);
    }

    args.push(targetUrl.trim());

    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (spawnErr) {
      return sendJson(res, 500, { error: 'Failed to start yt-dlp: ' + spawnErr.message });
    }

    activeJobs.set(jobId, {
      child,
      url: targetUrl,
      downloadPath: targetDir,
      format,
      quality,
      startTime: Date.now(),
      canceled: false,
      lastTitle: 'Starting download...',
      downloadedFiles: []
    });

    sendJson(res, 200, {
      success: true,
      jobId,
      message: 'Download job initialized',
      downloadPath: targetDir
    });

    broadcast({
      type: 'start',
      jobId,
      url: targetUrl,
      downloadPath: targetDir,
      format,
      quality,
      timestamp: Date.now()
    });

    let currentItem = 1;
    let totalItems = 1;
    let activeTitle = 'Downloading...';
    let lastFilePath = '';

    child.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const itemMatch = line.match(/Downloading (?:item|video) (\d+) of (\d+)/i);
        if (itemMatch) {
          currentItem = parseInt(itemMatch[1], 10);
          totalItems = parseInt(itemMatch[2], 10);
          broadcast({
            type: 'playlist_item',
            jobId,
            currentItem,
            totalItems,
            status: `Downloading item ${currentItem} of ${totalItems}`
          });
        }

        const destMatch = line.match(/(?:Destination:\s+|Merging formats into\s+"?)([^"\r\n]+)/i);
        if (destMatch) {
          lastFilePath = destMatch[1].trim();
          const fileName = path.basename(lastFilePath);
          activeTitle = fileName.replace(/\.[^/.]+$/, '');
          broadcast({
            type: 'item_start',
            jobId,
            title: activeTitle,
            filePath: lastFilePath,
            currentItem,
            totalItems
          });
        }

        const progMatch = line.match(/(\d+(?:\.\d+)?)%\s+of\s+~?([\d\.]+\w+)(?:\s+at\s+([\d\.]+\w+\/s)\s+ETA\s+([\d:]+)|\s+in\s+([\d:]+))/i);
        if (progMatch) {
          const percent = parseFloat(progMatch[1]);
          const size = progMatch[2] || '';
          const speed = progMatch[3] || '';
          const eta = progMatch[4] || '00:00';

          broadcast({
            type: 'progress',
            jobId,
            percent,
            size,
            speed,
            eta,
            currentItem,
            totalItems,
            title: activeTitle
          });
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      const errText = chunk.toString();
      if (errText.includes('ERROR:')) {
        broadcast({
          type: 'log_error',
          jobId,
          message: errText.trim()
        });
      }
    });

    child.on('close', (code) => {
      const job = activeJobs.get(jobId);
      activeJobs.delete(jobId);

      cleanupOrphanFiles(targetDir, format);

      if (job && job.canceled) {
        broadcast({
          type: 'canceled',
          jobId,
          message: 'Download was canceled by user.'
        });
        return;
      }

      if (code === 0) {
        broadcast({
          type: 'complete',
          jobId,
          title: activeTitle || 'Playlist / Video Downloaded',
          percent: 100,
          currentItem: totalItems,
          totalItems,
          filePath: lastFilePath,
          folderPath: targetDir,
          timestamp: Date.now()
        });
      } else {
        let errorMsg = `Download ended with exit code ${code}. Please verify the URL and network connection.`;
        if (code === 126) {
          errorMsg = 'Exit code 126: Execution permission denied. Cloud/Vercel Linux servers cannot run Windows (.exe) binaries. Please launch ApexTube.exe on your Windows PC to download directly into your Downloads folder.';
        }
        broadcast({
          type: 'error',
          jobId,
          code,
          message: errorMsg
        });
      }
    });
    return;
  }

  // 10. POST /api/cancel
  if (req.method === 'POST' && pathname === '/api/cancel') {
    const body = await readJsonBody(req);
    const jobId = body.jobId;
    if (!jobId || !activeJobs.has(jobId)) {
      return sendJson(res, 404, { error: 'Job not found or already finished' });
    }

    const job = activeJobs.get(jobId);
    job.canceled = true;

    try {
      if (process.platform === 'win32') {
        exec(`taskkill /pid ${job.child.pid} /T /F`);
      } else {
        job.child.kill('SIGTERM');
      }
      activeJobs.delete(jobId);
      sendJson(res, 200, { success: true, message: 'Download canceled' });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // 11. GET /api/system-status
  if (req.method === 'GET' && pathname === '/api/system-status') {
    const { cmd, argsPrefix } = resolveYtDlp();
    const ffmpegInstalled = await checkFfmpeg();
    const ffmpegDir = resolveFfmpegDir();

    exec(`${cmd} ${argsPrefix.join(' ')} --version`, (err, stdout) => {
      const ytDlpVersion = err ? 'Not detected (using python module fallback)' : stdout.trim();
      sendJson(res, 200, {
        platform: process.platform,
        defaultPath: path.join(os.homedir(), 'Downloads'),
        ytDlp: {
          installed: !err || ytDlpVersion.length > 0,
          version: ytDlpVersion,
          command: cmd
        },
        ffmpeg: {
          installed: ffmpegInstalled,
          location: ffmpegDir || 'system path'
        }
      });
    });
    return;
  }

  // Fallback 404
  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`⚡ ApexTube Playlist Downloader backend running!`);
  console.log(`🔗 Local UI: http://localhost:${PORT}`);
  console.log(`📂 Default Downloads: ${path.join(os.homedir(), 'Downloads')}`);
  console.log(`🎞️ FFmpeg Engine: ${resolveFfmpegDir() ? 'Bundled in Root (Ready)' : 'System PATH'}`);
  console.log(`=======================================================`);
});
