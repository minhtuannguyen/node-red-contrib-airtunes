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
    const FFMPEG_OUT        = ['-f', 's16le', '-ar', '44100', '-ac', '2', 'pipe:1'];
    const ESPEAK_INPUT_FMT  = [];  // espeak outputs WAV directly to stdout — no extra ffmpeg input flags needed
    const R_OK              = fs.constants.R_OK;  // cached once — avoids property lookup on every input message
    const PIPE_NO_END       = { end: false };     // reused across all .pipe() calls — avoids 2 object allocations per play
    const PID               = process.pid;        // cached at module load — avoids property lookup in TTS hot path

    // Pre-built TTS command descriptors — avoids object + array allocation per TTS play
    const SAY_DEFAULT   = { cmd: 'say',    args: [],           useTempFile: true,  ffmpegInputFmt: null,            hint: '"say" is built-in on macOS' };
    const ESPEAK_DEFAULT= { cmd: 'espeak', args: ['--stdout'], useTempFile: false, ffmpegInputFmt: ESPEAK_INPUT_FMT, hint: 'sudo apt install espeak' };

    // Pre-built node.status payloads — avoids object allocation on every status update
    const ST_CONNECTING = { fill: 'yellow', shape: 'dot', text: 'connecting…' };
    const ST_PLAYING    = { fill: 'green',  shape: 'dot', text: 'playing' };
    const ST_CACHED     = { fill: 'blue',   shape: 'dot', text: 'playing (cached)' };
    const ST_DONE       = { fill: 'grey',   shape: 'dot',  text: 'done' };
    const ST_STOPPED    = { fill: 'grey',   shape: 'ring', text: 'stopped' };
    const ST_TIMEOUT    = { fill: 'red',    shape: 'dot', text: 'timeout' };
    const ST_NO_CONFIG  = { fill: 'red',    shape: 'dot', text: 'no config' };
    const ST_NO_TEXT    = { fill: 'red',    shape: 'dot', text: 'no text' };
    const ST_NO_FILE    = { fill: 'red',    shape: 'dot', text: 'no file path' };
    const ST_NOT_FOUND  = { fill: 'red',    shape: 'dot', text: 'file not found' };
    const ST_TTS_ERR    = { fill: 'red',    shape: 'dot', text: 'TTS error' };
    const ST_FFMPEG_ERR = { fill: 'red',    shape: 'dot', text: 'ffmpeg error' };
    const ST_CACHE_ERR  = { fill: 'red',    shape: 'dot', text: 'cache error' };
    const ST_AIRT_ERR   = { fill: 'red',    shape: 'dot', text: 'error' };
    const ST_CLEAR      = {};

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

        // Cache config-node values — avoids repeated property chain lookups per message
        const devHost   = node.configNode ? node.configNode.host   : '';
        const devPort   = node.configNode ? node.configNode.port   : 7000;
        const devVolume = node.configNode ? node.configNode.volume : 50;

        let currentAirtunes  = null;
        let currentFfmpeg    = null;
        let currentTtsProc   = null;
        let connectionTimer  = null;  // AirPlay connection watchdog
        let sessionId        = 0;

        // Per-node caches — avoid repeated computation, cleared on node close
        const cachePathMap  = new Map(); // "<cacheDir>\0<filePath>" → .pcm path
        const confirmedDirs = new Set(); // cacheDir paths already verified to exist
        let   tmpCounter    = 0;         // monotonic counter for temp file names (no crypto needed)

        // Evict oldest entries when Map grows too large (long-running Pi with many files)
        function trimCachePathMap() {
            if (cachePathMap.size <= 500) return;
            let n = 100;
            for (const k of cachePathMap.keys()) {
                cachePathMap.delete(k);
                if (--n === 0) break;
            }
        }

        // ── Cleanup ────────────────────────────────────────────────────────

        function stopPlayback(silent) {
            if (connectionTimer) { clearTimeout(connectionTimer); connectionTimer = null; }
            if (!currentAirtunes && !currentFfmpeg && !currentTtsProc) return false;
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
                try { currentAirtunes.removeAllListeners(); } catch (_) {}  // release closure refs held by event listeners
                currentAirtunes = null;
            }
            if (!silent) node.status(ST_CLEAR);
            return true;
        }

        // ── TTS command builder ────────────────────────────────────────────

        function buildTtsCmd(voice) {
            if (IS_DARWIN) {
                if (!voice) return SAY_DEFAULT;
                return { cmd: 'say', args: ['-v', voice], useTempFile: true, ffmpegInputFmt: null, hint: SAY_DEFAULT.hint };
            } else {
                if (!voice) return ESPEAK_DEFAULT;
                return { cmd: 'espeak', args: ['--stdout', '-v', voice], useTempFile: false, ffmpegInputFmt: ESPEAK_INPUT_FMT, hint: ESPEAK_DEFAULT.hint };
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
                trimCachePathMap();
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
                return cachePath;
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
            const isTts = options.type === 'tts';  // hoist: avoids repeated string comparison

            const effectiveCacheDir = options.cacheDir;  // already resolved from input handler; empty string disables caching

            // macOS TTS: start 'say' immediately in parallel with AirPlay handshake
            let tts        = null;
            let tempFile   = null;
            let ttsReady   = false;
            let onTtsReady = null;

            if (isTts) {
                tts = buildTtsCmd(options.voice);
                if (tts.useTempFile) {
                    const tempDir = node.ttsTempDir || SYS_TMPDIR;
                    tempFile = path.join(tempDir, 'tts-' + PID + '-' + (++tmpCounter) + '.aiff');
                    const ttsProc = spawn(tts.cmd, [...tts.args, '-o', tempFile, options.text],
                        { stdio: ['ignore', 'ignore', 'pipe'] });
                    currentTtsProc = ttsProc;
                    ttsProc.stderr.on('data', (d) => node.warn('TTS: ' + d.toString().trim()));
                    ttsProc.on('error', (err) => {
                        onTtsReady = null; // prevent spawnFfmpegFromFile from running if AirPlay connects later
                        node.error('TTS error: ' + err.message + ' — ' + tts.hint);
                        node.status(ST_TTS_ERR);
                        if (onDone) onDone(err);
                    });
                    ttsProc.on('close', () => {
                        if (currentTtsProc === ttsProc) currentTtsProc = null;
                        ttsReady = true;
                        if (onTtsReady) { onTtsReady(); onTtsReady = null; }
                    });
                }
            }

            airtunes.add(devHost, { port: devPort, volume: options.volume });

            // Watchdog: if device never responds, release socket and resources
            connectionTimer = setTimeout(() => {
                if (currentAirtunes !== airtunes) return;
                node.warn('AirPlay connection timeout — device unreachable');
                node.status(ST_TIMEOUT);
                try { airtunes.stopAll(); } catch (_) {}
                try { airtunes.removeAllListeners(); } catch (_) {}
                currentAirtunes = null;
                if (onDone) onDone(new Error('timeout'));
            }, 10000);

            airtunes.on('device', (deviceHost, deviceStatus) => {
                if (currentAirtunes !== airtunes) return;
                clearTimeout(connectionTimer); connectionTimer = null;

                if (deviceStatus === 'ready') {
                    node.status(ST_PLAYING);

                    function setupFfmpeg(ffmpeg) {
                        currentFfmpeg = ffmpeg;
                        ffmpeg.stdout.pipe(airtunes, PIPE_NO_END);
                        ffmpeg.on('error', (err) => {
                            node.error('ffmpeg error: ' + err.message);
                            node.status(ST_FFMPEG_ERR);
                            if (onDone) onDone(err);
                        });
                        ffmpeg.on('close', () => {
                            if (currentAirtunes === airtunes) airtunes.end();
                        });
                    }

                    if (!isTts) {
                        const cachePath = getCacheInfo(options.filePath, effectiveCacheDir);
                        if (cachePath) {
                            // Cache hit: skip ffmpeg, stream PCM directly
                            node.status(ST_CACHED);
                            const rs = fs.createReadStream(cachePath, { highWaterMark: 256 * 1024 });
                            rs.pipe(airtunes, PIPE_NO_END);
                            currentFfmpeg = { kill: () => rs.destroy() };
                            rs.on('error', (err) => {
                                node.error('Cache read error: ' + err.message);
                                node.status(ST_CACHE_ERR);
                                if (onDone) onDone(err);
                            });
                            rs.on('close', () => {
                                if (currentAirtunes === airtunes) airtunes.end();
                            });
                        } else {
                            // -nostdin: prevents ffmpeg polling stdin fd on Pi (saves CPU)
                            const ffmpeg = spawn('ffmpeg',
                                ['-nostdin', '-i', options.filePath, ...FFMPEG_OUT],
                                { stdio: ['ignore', 'pipe', 'ignore'] });
                            if (effectiveCacheDir && ensureCacheDir(effectiveCacheDir)) {
                                // Write to a unique tmp file, rename to final on success.
                                // Prevents a killed session from deleting a concurrent session's cache.
                                const cacheFinal = getCachePath(options.filePath, effectiveCacheDir);
                                const cacheTmp   = cacheFinal + '.' + (++tmpCounter) + '.tmp';
                                const ws = fs.createWriteStream(cacheTmp, { highWaterMark: 256 * 1024 });
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
                                ['-nostdin', '-i', tempFile, ...FFMPEG_OUT],
                                { stdio: ['ignore', 'pipe', 'ignore'] });
                            setupFfmpeg(ffmpeg);
                            ffmpeg.on('close', () => { try { fs.unlinkSync(tempFile); } catch (_) {} });
                        }
                        if (ttsReady) spawnFfmpegFromFile();
                        else onTtsReady = spawnFfmpegFromFile;

                    } else {
                        const ttsProc = spawn(tts.cmd, [...tts.args, options.text],
                            { stdio: ['ignore', 'pipe', 'pipe'] });
                        currentTtsProc = ttsProc;
                        ttsProc.stderr.on('data', (d) => node.warn('TTS: ' + d.toString().trim()));
                        const ffmpeg = spawn('ffmpeg',
                            ['-nostdin', ...tts.ffmpegInputFmt, '-i', 'pipe:0', ...FFMPEG_OUT],
                            { stdio: ['pipe', 'pipe', 'ignore'] });
                        ttsProc.stdout.pipe(ffmpeg.stdin);
                        ttsProc.on('error', (err) => {
                            node.error('TTS error: ' + err.message + ' — ' + tts.hint);
                            node.status(ST_TTS_ERR);
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
                    node.status(ST_AIRT_ERR);
                    try { airtunes.stopAll(); } catch (_) {}
                    try { airtunes.removeAllListeners(); } catch (_) {}
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
                        try { airtunes.removeAllListeners(); } catch (_) {}
                        currentAirtunes = null;
                        currentFfmpeg   = null;
                        currentTtsProc  = null;
                        node.status(ST_DONE);
                        if (onDone) onDone(null, isTts ? options.text : options.filePath);
                    }, 3000);
                }
            });

            airtunes.on('error', (err) => {
                clearTimeout(connectionTimer); connectionTimer = null;
                node.error('AirTunes error: ' + (err.message || err));
                node.status(ST_AIRT_ERR);
                if (currentAirtunes === airtunes) {
                    try { airtunes.removeAllListeners(); } catch (_) {}
                    currentAirtunes = null;
                }
                if (onDone) onDone(err);
            });
        }

        // ── Input handler ──────────────────────────────────────────────────

        node.on('input', function (msg) {
            if (msg.stop === true || msg.payload === 'stop') {
                const wasStopped = stopPlayback();
                if (wasStopped) {
                    node.status(ST_STOPPED);
                    node.send({ payload: 'stopped', status: 'stopped' });
                }
                return;
            }

            if (!node.configNode) {
                node.error('No AirTunes config node selected');
                node.status(ST_NO_CONFIG);
                return;
            }

            const mode     = msg.mode   || node.mode;
            const volume   = msg.volume !== undefined ? (msg.volume | 0) : (node.defaultVolume !== null ? node.defaultVolume : devVolume);
            const voice    = msg.voice  || node.ttsVoice || '';
            const cacheDir = msg.cacheFolder !== undefined ? msg.cacheFolder : node.cacheDir;

            stopPlayback(true);  // silent: status will be overwritten immediately by 'connecting…'
            const sid = ++sessionId;

            function onDone(err, source) {
                if (sessionId !== sid || err) return;
                node.send({ payload: 'ok', status: 'done', mode, source });
            }

            if (mode === 'tts') {
                const text = (typeof msg.payload === 'string' && msg.payload !== 'stop' ? msg.payload : null)
                    || msg.text || node.ttsText;
                if (!text) {
                    node.error('No text for TTS — set msg.payload, msg.text, or configure on the node');
                    node.status(ST_NO_TEXT);
                    return;
                }
                node.status(ST_CONNECTING);
                startPlayback({ type: 'tts', text, voice, volume }, onDone);

            } else {
                const filePath = msg.filePath || node.filePath;
                if (!filePath) {
                    node.error('No file path — set msg.filePath or configure on the node');
                    node.status(ST_NO_FILE);
                    return;
                }
                // Validate early — before opening the AirPlay connection
                try { fs.accessSync(filePath, R_OK); } catch (_) {
                    node.error('File not found or not readable: ' + filePath);
                    node.status(ST_NOT_FOUND);
                    return;
                }
                node.status(ST_CONNECTING);
                startPlayback({ type: 'file', filePath, volume, cacheDir }, onDone);
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

