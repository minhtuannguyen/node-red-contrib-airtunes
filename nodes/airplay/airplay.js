module.exports = function (RED) {
    const AirTunes  = require('airtunes2');
    const { spawn } = require('child_process');
    const os        = require('os');
    const fs        = require('fs');
    const path      = require('path');
    const crypto    = require('crypto');

    function AirPlayNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;

        node.configNode = RED.nodes.getNode(config.device);
        node.filePath   = config.filePath  || '';
        node.mode       = config.mode      || 'file'; // 'file' | 'tts'
        node.ttsText    = config.ttsText   || '';
        node.ttsVoice   = config.ttsVoice  || '';
        node.ttsTempDir  = config.ttsTempDir  || '';

        let currentAirtunes = null;
        let currentFfmpeg   = null;
        let currentTtsProc  = null;
        let sessionId       = 0;

        // ── Cleanup ────────────────────────────────────────────────────────

        function stopPlayback() {
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
        // Returns { cmd, args, useTempFile } describing how to invoke TTS.
        // macOS : say writes AIFF to a temp file (cannot stream to /dev/stdout)
        // Linux : espeak streams WAV to stdout via --stdout

        function buildTtsCmd(voice) {
            if (os.platform() === 'darwin') {
                const args = [];
                if (voice) args.push('-v', voice);
                // caller appends: -o tempFile text
                return {
                    cmd: 'say', args,
                    useTempFile: true,
                    hint: '"say" is built-in on macOS'
                };
            } else {
                const args = ['--stdout'];
                if (voice) args.push('-v', voice);
                // caller appends: text
                return {
                    cmd: 'espeak', args,
                    useTempFile: false,
                    ffmpegInputFmt: [],
                    hint: 'install with: sudo apt install espeak'
                };
            }
        }

        // ── Core playback ──────────────────────────────────────────────────

        function startPlayback(options, onDone) {
            const airtunes = new AirTunes();
            currentAirtunes = airtunes;

            // For macOS TTS: start 'say' NOW, in parallel with the AirPlay
            // handshake, so the AIFF file is ready (or nearly ready) by the
            // time the device reports 'ready' — reducing perceived start latency.
            let tts        = null;
            let tempFile   = null;
            let ttsReady   = false;
            let onTtsReady = null;

            if (options.type === 'tts') {
                tts = buildTtsCmd(options.voice);
                if (tts.useTempFile) {
                    const tempDir = node.ttsTempDir || os.tmpdir();
                    tempFile = path.join(tempDir, `tts-${crypto.randomBytes(6).toString('hex')}.aiff`);
                    const ttsArgs = [...tts.args, '-o', tempFile, options.text];
                    const ttsProc = spawn(tts.cmd, ttsArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
                    currentTtsProc = ttsProc;
                    ttsProc.stderr.on('data', (d) => node.warn('TTS stderr: ' + d.toString().trim()));
                    ttsProc.on('error', (err) => {
                        node.error(`TTS error: ${err.message} — ${tts.hint}`);
                        node.status({ fill: 'red', shape: 'dot', text: 'TTS error' });
                        if (onDone) onDone(err);
                    });
                    ttsProc.on('close', () => {
                        if (currentTtsProc === ttsProc) currentTtsProc = null;
                        ttsReady = true;
                        if (onTtsReady) onTtsReady();
                    });
                }
            }

            airtunes.add(node.configNode.host, {
                port:   node.configNode.port,
                volume: options.volume
            });

            airtunes.on('device', (deviceHost, deviceStatus) => {
                if (currentAirtunes !== airtunes) return;

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
                        const ffmpeg = spawn('ffmpeg', [
                            '-i', options.filePath,
                            '-f', 's16le', '-ar', '44100', '-ac', '2', 'pipe:1'
                        ], { stdio: ['ignore', 'pipe', 'ignore'] });
                        setupFfmpeg(ffmpeg);

                    } else if (tts.useTempFile) {
                        // macOS: say already running; start ffmpeg when say finishes
                        function spawnFfmpegFromFile() {
                            if (currentAirtunes !== airtunes) {
                                try { fs.unlinkSync(tempFile); } catch (_) {}
                                return;
                            }
                            const ffmpeg = spawn('ffmpeg', [
                                '-i', tempFile,
                                '-f', 's16le', '-ar', '44100', '-ac', '2', 'pipe:1'
                            ], { stdio: ['ignore', 'pipe', 'ignore'] });
                            setupFfmpeg(ffmpeg);
                            ffmpeg.on('close', () => {
                                try { fs.unlinkSync(tempFile); } catch (_) {}
                            });
                        }
                        if (ttsReady) {
                            spawnFfmpegFromFile();
                        } else {
                            onTtsReady = spawnFfmpegFromFile;
                        }

                    } else {
                        // Linux: espeak streams WAV to stdout → ffmpeg stdin
                        const ttsArgs = [...tts.args, options.text];
                        const ttsProc = spawn(tts.cmd, ttsArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
                        currentTtsProc = ttsProc;
                        ttsProc.stderr.on('data', (d) => node.warn('TTS stderr: ' + d.toString().trim()));
                        const ffmpeg = spawn('ffmpeg', [
                            ...tts.ffmpegInputFmt,
                            '-i', 'pipe:0',
                            '-f', 's16le', '-ar', '44100', '-ac', '2', 'pipe:1'
                        ], { stdio: ['pipe', 'pipe', 'ignore'] });
                        ttsProc.stdout.pipe(ffmpeg.stdin);
                        ttsProc.on('error', (err) => {
                            node.error(`TTS error: ${err.message} — ${tts.hint}`);
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

            airtunes.on('buffer', (bufStatus) => {
                if (bufStatus === 'end' && currentAirtunes === airtunes) {
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
                node.error('AirTunes error: ' + (err.message || err));
                node.status({ fill: 'red', shape: 'dot', text: 'error' });
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

            const mode   = msg.mode   || node.mode;
            const volume = (msg.volume !== undefined) ? parseInt(msg.volume) : node.configNode.volume;
            const voice  = msg.voice  || node.ttsVoice || '';

            stopPlayback();
            const sid = ++sessionId;

            function onDone(err, meta) {
                if (sessionId !== sid) return;
                if (err) return;
                node.send({
                    payload: 'ok',
                    status:  'done',
                    mode:    mode,
                    source:  mode === 'tts' ? (meta && meta.text) : (meta && meta.filePath)
                });
            }

            if (mode === 'tts') {
                const text = (typeof msg.payload === 'string' && msg.payload !== 'stop'
                    ? msg.payload : null)
                    || msg.text
                    || node.ttsText;

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
                node.status({ fill: 'yellow', shape: 'dot', text: 'connecting…' });
                startPlayback({ type: 'file', filePath, volume, meta: { filePath } }, onDone);
            }
        });

        node.on('close', function (done) {
            stopPlayback();
            done();
        });
    }

    RED.nodes.registerType('airplay', AirPlayNode);
};

