module.exports = function (RED) {
    const AirTunes  = require('airtunes2');
    const { spawn } = require('child_process');
    const os        = require('os');
    const fs        = require('fs');
    const path      = require('path');
    const crypto    = require('crypto');

    // Computed once at module load — avoids repeated syscalls on every message
    const IS_DARWIN  = os.platform() === 'darwin';
    const SYS_TMPDIR = os.tmpdir();

    // Shared ffmpeg output args — one array instance reused across all spawns
    const FFMPEG_OUT = ['-f', 's16le', '-ar', '44100', '-ac', '2', 'pipe:1'];

    function AirPlayNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.configNode = RED.nodes.getNode(config.device);
        node.filePath   = config.filePath   || '';
        node.mode       = config.mode       || 'file';
        node.ttsText    = config.ttsText    || '';
        node.ttsVoice   = config.ttsVoice   || '';
        node.ttsTempDir = config.ttsTempDir || '';
        node.cacheDir      = config.cacheDir      || '';
        const dv = parseInt(config.defaultVolume, 10);
        node.defaultVolume = isNaN(dv) ? null : dv;

        let currentAirtunes  = null;
        let currentFfmpeg    = null;
        let currentTtsProc   = null;
        let connectionTimer  = null;  // AirPlay connection watchdog
        let sessionId        = 0;

        // Per-node caches — avoid repeated computation, cleared on node close
        const cachePathMap  = new Map(); // "<cacheDir>\0<filePath>" → .pcm path
        const confirmedDirs = new Set(); // cacheDir paths already verified to exist
        let   tmpCounter    = 0;         // monotonic counter for temp file names (no crypto needed)

        // ── Cleanup ────────────────────────────────────────────────────────

        function stopPlayback() {
            if (connectionTimer) { clearTimeout(connectionTimer); connectionTimer = null; }
            if (!currentAirtunes && !currentFfmpeg && !currentTtsProc) return;
            if (currentTtsProc) {
                try { currentTtsProc.kill('SIGTERM'); } catch (_) {}
                currentTtsProc = null;
            }
            if (currentFfmpeg) {
                try { currentFfmpeg.kill('SIGTERM'); } catch (_) {}
                currentFfmpeg = null;
            }
            if (currentAirtunes) {
                try { currentAirtunes.stopAll(); } catch (_) {}
                currentAirtunes = null;
            }
            node.status({});
        }

        // ── TTS command builder ────────────────────────────────────────────

        function buildTtsCmd(voice) {
            if (IS_DARWIN) {
                const args = voice ? ['-v', voice] : [];
                return { cmd: 'say', args, useTempFile: true, hint: '"say" is built-in on macOS' };
            } else {
                const args = voice ? ['--stdout', '-v', voice] : ['--stdout'];
                return { cmd: 'espeak', args, useTempFile: false, ffmpegInputFmt: [], hint: 'sudo apt install espeak' };
            }
        }

        // ── MP3 cache helpers ──────────────────────────────────────────────

        function getCachePath(filePath, cacheDir) {
            const key = cacheDir + '\0' + filePath;
            let p = cachePathMap.get(key);
            if (!p) {
                // Hash by basename only — stable even if parent directory is renamed/moved
                p = path.join(cacheDir, crypto.createHash('md5').update(path.basename(filePath)).digest('hex') + '.pcm');
                cachePathMap.set(key, p);
            }
            return p;
        }

        function getCacheInfo(filePath, cacheDir) {
            if (!cacheDir) return null;
            try {
                const cachePath = getCachePath(filePath, cacheDir);
                const cs = fs.statSync(cachePath);
                if (cs.size === 0) return null; // incomplete/failed cache file — ignore
                // Cache has data — use it unless source still exists AND is newer
                try {
                    const ss = fs.statSync(filePath);
                    if (ss.mtimeMs > cs.mtimeMs) return null; // source modified, re-encode
                } catch (_) {
                    // source file gone — use existing cache anyway
                }
                return { path: cachePath, size: cs.size };
            } catch (_) {}
            return null;
        }

        function ensureCacheDir(cacheDir) {
            if (confirmedDirs.has(cacheDir)) return true;
            try {
                fs.mkdirSync(cacheDir, { recursive: true });
                confirmedDirs.add(cacheDir);
                return true;
            } catch (err) {
                node.warn('Cache dir not writable: ' + err.message);
                return false;
            }
        }

        // ── Core playback ──────────────────────────────────────────────────

        function startPlayback(options, onDone) {
            const airtunes = new AirTunes();
            currentAirtunes = airtunes;

            const effectiveCacheDir = options.cacheDir;  // already resolved from input handler; empty string disables caching

            // macOS TTS: start 'say' immediately in parallel with AirPlay handshake
            let tts        = null;
            let tempFile   = null;
            let ttsReady   = false;
            let onTtsReady = null;

            if (options.type === 'tts') {
                tts = buildTtsCmd(options.voice);
                if (tts.useTempFile) {
                    const tempDir = node.ttsTempDir || SYS_TMPDIR;
                    tempFile = path.join(tempDir, 'tts-' + process.pid + '-' + (++tmpCounter) + '.aiff');
                    const ttsProc = spawn(tts.cmd, tts.args.concat(['-o', tempFile, options.text]),
                        { stdio: ['ignore', 'ignore', 'pipe'] });
                    currentTtsProc = ttsProc;
                    ttsProc.stderr.on('data', (d) => node.warn('TTS: ' + d.toString().trim()));
                    ttsProc.on('error', (err) => {
                        onTtsReady = null; // prevent spawnFfmpegFromFile from running if AirPlay connects later
                        node.error('TTS error: ' + err.message + ' — ' + tts.hint);
                        node.status({ fill: 'red', shape: 'dot', text: 'TTS error' });
                        if (onDone) onDone(err);
                    });
                    ttsProc.on('close', () => {
                        if (currentTtsProc === ttsProc) currentTtsProc = null;
                        ttsReady = true;
                        if (onTtsReady) { onTtsReady(); onTtsReady = null; }
                    });
                }
            }

            airtunes.add(node.configNode.host, { port: node.configNode.port, volume: options.volume });

            // Watchdog: if device never responds, release socket and resources
            connectionTimer = setTimeout(() => {
                if (currentAirtunes !== airtunes) return;
                node.warn('AirPlay connection timeout — device unreachable');
                node.status({ fill: 'red', shape: 'dot', text: 'timeout' });
                try { airtunes.stopAll(); } catch (_) {}
                currentAirtunes = null;
                if (onDone) onDone(new Error('timeout'));
            }, 10000);

            airtunes.on('device', (deviceHost, deviceStatus) => {
                if (currentAirtunes !== airtunes) return;
                clearTimeout(connectionTimer); connectionTimer = null;

                if (deviceStatus === 'ready') {
                    node.status({ fill: 'green', shape: 'dot', text: 'playing' });

                    function setupFfmpeg(ffmpeg) {
                        currentFfmpeg = ffmpeg;
                        ffmpeg.stdout.pipe(airtunes, { end: false });
                        ffmpeg.on('error', (err) => {
                            node.error('ffmpeg error: ' + err.message);
                            node.status({ fill: 'red', shape: 'dot', text: 'ffmpeg error' });
                            if (onDone) onDone(err);
                        });
                        ffmpeg.on('close', () => {
                            if (currentAirtunes === airtunes) airtunes.end();
                        });
                    }

                    if (options.type === 'file') {
                        const cacheInfo = getCacheInfo(options.filePath, effectiveCacheDir);
                        if (cacheInfo) {
                            // Cache hit: skip ffmpeg, stream PCM directly
                            node.status({ fill: 'blue', shape: 'dot', text: 'playing (cached)' });
                            const rs = fs.createReadStream(cacheInfo.path, { highWaterMark: 256 * 1024 });
                            rs.pipe(airtunes, { end: false });
                            currentFfmpeg = { kill: () => rs.destroy() };
                            rs.on('error', (err) => {
                                node.error('Cache read error: ' + err.message);
                                node.status({ fill: 'red', shape: 'dot', text: 'cache error' });
                                if (onDone) onDone(err);
                            });
                            rs.on('close', () => {
                                if (currentAirtunes === airtunes) airtunes.end();
                            });
                        } else {

                            // -nostdin: prevents ffmpeg polling stdin fd on Pi (saves CPU)
                            const ffmpeg = spawn('ffmpeg',
                                ['-nostdin', '-i', options.filePath].concat(FFMPEG_OUT),
                                { stdio: ['ignore', 'pipe', 'ignore'] });
                            if (effectiveCacheDir && ensureCacheDir(effectiveCacheDir)) {
                                // Write to a unique tmp file, rename to final on success.
                                // Prevents a killed session from deleting a concurrent session's cache.
                                const cacheFinal = getCachePath(options.filePath, effectiveCacheDir);
                                const cacheTmp   = cacheFinal + '.' + (++tmpCounter) + '.tmp';
                                const ws = fs.createWriteStream(cacheTmp);
                                ws.on('error', (err) => node.warn('Cache write error: ' + err.message));
                                ffmpeg.stdout.pipe(ws);
                                ffmpeg.on('close', (code) => {
                                    if (code === 0) {
                                        try { fs.renameSync(cacheTmp, cacheFinal); } catch (_) {}
                                    } else {
                                        try { fs.unlinkSync(cacheTmp); } catch (_) {}
                                    }
                                });
                            }
                            setupFfmpeg(ffmpeg);
                        }

                    } else if (tts.useTempFile) {
                        function spawnFfmpegFromFile() {
                            if (currentAirtunes !== airtunes) {
                                try { fs.unlinkSync(tempFile); } catch (_) {}
                                return;
                            }
                            const ffmpeg = spawn('ffmpeg',
                                ['-nostdin', '-i', tempFile].concat(FFMPEG_OUT),
                                { stdio: ['ignore', 'pipe', 'ignore'] });
                            setupFfmpeg(ffmpeg);
                            ffmpeg.on('close', () => { try { fs.unlinkSync(tempFile); } catch (_) {} });
                        }
                        if (ttsReady) spawnFfmpegFromFile();
                        else onTtsReady = spawnFfmpegFromFile;

                    } else {
                        const ttsProc = spawn(tts.cmd, tts.args.concat([options.text]),
                            { stdio: ['ignore', 'pipe', 'pipe'] });
                        currentTtsProc = ttsProc;
                        ttsProc.stderr.on('data', (d) => node.warn('TTS: ' + d.toString().trim()));
                        const ffmpeg = spawn('ffmpeg',
                            ['-nostdin'].concat(tts.ffmpegInputFmt, ['-i', 'pipe:0'], FFMPEG_OUT),
                            { stdio: ['pipe', 'pipe', 'ignore'] });
                        ttsProc.stdout.pipe(ffmpeg.stdin);
                        ttsProc.on('error', (err) => {
                            node.error('TTS error: ' + err.message + ' — ' + tts.hint);
                            node.status({ fill: 'red', shape: 'dot', text: 'TTS error' });
                            try { ffmpeg.stdin.end(); } catch (_) {}
                        });
                        ttsProc.on('close', () => {
                            try { ffmpeg.stdin.end(); } catch (_) {}
                            if (currentTtsProc === ttsProc) currentTtsProc = null;
                        });
                        setupFfmpeg(ffmpeg);
                    }

                } else if (deviceStatus === 'error' || deviceStatus === 'failed') {
                    node.error('Device ' + deviceHost + ' reported: ' + deviceStatus);
                    node.status({ fill: 'red', shape: 'dot', text: deviceStatus });
                    currentAirtunes = null;
                    if (onDone) onDone(new Error(deviceStatus));
                }
            });

            let endTimerSet = false;
            airtunes.on('buffer', (bufStatus) => {
                if (bufStatus === 'end' && currentAirtunes === airtunes && !endTimerSet) {
                    endTimerSet = true;
                    setTimeout(() => {
                        if (currentAirtunes !== airtunes) return;
                        try { airtunes.stopAll(); } catch (_) {}
                        currentAirtunes = null;
                        currentFfmpeg   = null;
                        currentTtsProc  = null;
                        node.status({ fill: 'grey', shape: 'dot', text: 'done' });
                        if (onDone) onDone(null, options.meta);
                    }, 3000);
                }
            });

            airtunes.on('error', (err) => {
                clearTimeout(connectionTimer); connectionTimer = null;
                node.error('AirTunes error: ' + (err.message || err));
                node.status({ fill: 'red', shape: 'dot', text: 'error' });
                if (currentAirtunes === airtunes) currentAirtunes = null;
                if (onDone) onDone(err);
            });
        }

        // ── Input handler ──────────────────────────────────────────────────

        node.on('input', function (msg) {
            if (msg.stop === true || msg.payload === 'stop') {
                stopPlayback();
                return;
            }

            if (!node.configNode) {
                node.error('No AirTunes config node selected');
                node.status({ fill: 'red', shape: 'dot', text: 'no config' });
                return;
            }

            const mode     = msg.mode   || node.mode;
            const volume   = msg.volume !== undefined ? (msg.volume | 0) : (node.defaultVolume !== null ? node.defaultVolume : node.configNode.volume);
            const voice    = msg.voice  || node.ttsVoice || '';
            const cacheDir = msg.cacheFolder !== undefined ? msg.cacheFolder : node.cacheDir;

            stopPlayback();
            const sid = ++sessionId;

            function onDone(err, meta) {
                if (sessionId !== sid || err) return;
                node.send({
                    payload: 'ok',
                    status:  'done',
                    mode,
                    source: mode === 'tts' ? (meta && meta.text) : (meta && meta.filePath)
                });
            }

            if (mode === 'tts') {
                const text = (typeof msg.payload === 'string' && msg.payload !== 'stop' ? msg.payload : null)
                    || msg.text || node.ttsText;
                if (!text) {
                    node.error('No text for TTS — set msg.payload, msg.text, or configure on the node');
                    node.status({ fill: 'red', shape: 'dot', text: 'no text' });
                    return;
                }
                node.status({ fill: 'yellow', shape: 'dot', text: 'connecting…' });
                startPlayback({ type: 'tts', text, voice, volume, meta: { text } }, onDone);

            } else {
                const filePath = msg.filePath || node.filePath;
                if (!filePath) {
                    node.error('No file path — set msg.filePath or configure on the node');
                    node.status({ fill: 'red', shape: 'dot', text: 'no file path' });
                    return;
                }
                // Validate early — before opening the AirPlay connection
                try { fs.accessSync(filePath, fs.constants.R_OK); } catch (_) {
                    node.error('File not found or not readable: ' + filePath);
                    node.status({ fill: 'red', shape: 'dot', text: 'file not found' });
                    return;
                }
                node.status({ fill: 'yellow', shape: 'dot', text: 'connecting…' });
                startPlayback({ type: 'file', filePath, volume, meta: { filePath }, cacheDir }, onDone);
            }
        });

        node.on('close', function (done) {
            stopPlayback();
            cachePathMap.clear();
            confirmedDirs.clear();
            done();
        });
    }

    RED.nodes.registerType('airplay', AirPlayNode);
};

