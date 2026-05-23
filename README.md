# node-red-contrib-airtunes

Node-RED nodes for streaming audio to AirPlay devices (HomePod, Airport Express, etc.) using [airtunes2](https://github.com/ciderapp/node_airtunes2) and `ffmpeg`.

Supports two modes:
- **Play MP3** — stream any MP3 file from the local filesystem.
- **Text to Speech** — speak arbitrary text using the OS TTS engine (`say` on macOS, `espeak` on Linux). A short temporary audio file is created and deleted automatically after playback.

---

## Prerequisites

| Requirement | macOS | Linux / Raspberry Pi |
|---|---|---|
| **Node-RED** ≥ 3 | ✓ | ✓ |
| **ffmpeg** | `brew install ffmpeg` | `sudo apt install ffmpeg` |
| **TTS engine** (TTS mode only) | built-in `say` — nothing to install | `sudo apt install espeak` |

Your AirPlay device must be on the same local network as the machine running Node-RED.

---

## Installation

```bash
# in your Node-RED user directory (~/.node-red)
npm install node-red-contrib-airtunes
```

Or install via **Manage Palette** in the Node-RED UI.

### Raspberry Pi 3 / ARM (no compilation required)

`airtunes2` ships a native C++ addon for ALAC encoding, but includes a complete **pure-JavaScript fallback** that activates automatically when the native binary is absent. All HomeKit pairing crypto (SRP, Curve25519, Ed25519, ChaCha20-Poly1305) is already pure JavaScript. No compilation needed.

**Prerequisites on the Pi:**
```bash
sudo apt install ffmpeg        # required for audio decoding
sudo apt install espeak        # only if using Text-to-Speech mode
```

**Install via tarball (recommended for Pi 3):**

**Option A (automated): Use the build script**
```bash
cd /path/to/node-red-contrib-airtunes
./build-tarball.sh
# produces: node-red-contrib-airtunes-1.0.0.tgz (~4.5 MB)
```

**Option B (manual): Build step by step**

1. On your Mac, clean build and create the tarball:
   ```bash
   cd /path/to/node-red-contrib-airtunes
   rm -rf node_modules package-lock.json foo *.tgz
   npm install --production --ignore-scripts --no-audit
   npm pack
   # produces: node-red-contrib-airtunes-1.0.0.tgz (~4.5 MB)
   ```

2. Copy the `.tgz` file to the Pi:
   ```bash
   scp node-red-contrib-airtunes-1.0.0.tgz pi@PI_IP:~/
   ```

3. On the Pi, install from the tarball:
   ```bash
   cd ~/.node-red
   npm install ~/node-red-contrib-airtunes-1.0.0.tgz --ignore-scripts --no-audit
   ```

**Why this works:** The tarball is a complete binary archive with all dependencies pre-bundled, including airtunes2 and its slow GitHub-sourced packages (axlsign, chacha-js, mdns-js, dns-js). The Pi never downloads from GitHub. The `--production --ignore-scripts` flags ensure only runtime dependencies are included (no build tools, native compilation, or test files). Install takes a few minutes (SD card I/O) but always completes without memory errors or GitHub cloning delays.

---

## Nodes

### AirTunes Config (config node)

Stores connection details for one AirPlay device. Multiple **airplay** nodes can share a single config.

| Property | Description | Default |
|----------|-------------|---------|
| **Name** | Friendly label | – |
| **Host / IP** | IP address or hostname of the AirPlay device | – |
| **Port** | AirPlay port | `7000` |
| **Volume** | Playback volume (0–100) | `50` |

---

### airplay

Streams audio to the configured AirPlay device on each incoming message.

#### Configuration

| Property | Description |
|----------|-------------|
| **Name** | Optional label |
| **Device** | Select an *AirTunes Config* node |
| **Mode** | `Play MP3 file` or `Text to Speech` |
| **MP3 File Path** | *(file mode)* Absolute path to the MP3 on the Node-RED host |
| **Text to Speak** | *(TTS mode)* Default text; overridden at runtime by `msg.payload` or `msg.text` |
| **Voice / Language** | *(TTS mode)* Voice name on macOS (`say -v <name>`, e.g. `Anna`, `Markus`) or language code on Linux (`espeak -v <lang>`, e.g. `de`, `en`). Blank = system default |
| **TTS Temp Dir** | *(TTS mode)* Directory for the temporary AIFF file created during TTS synthesis. Leave blank to use the system temp folder (`/tmp`). Point to a RAM disk to avoid disk writes |
| **MP3 Cache Dir** | *(file mode, optional)* Directory for caching ffmpeg PCM output. Enables instant playback on file replays. Leave blank to disable. **Recommended:** point to a RAM disk for speed (e.g. `/Volumes/ramdisk` on Mac, `/mnt/ramdisk` on Pi) |

#### Input message properties

| Property | Type | Description |
|----------|------|-------------|
| `msg.payload` | `string` | TTS text to speak, **or** `"stop"` to halt playback |
| `msg.text` | `string` | TTS text (alternative to `msg.payload`) |
| `msg.filePath` | `string` | Overrides the configured MP3 path (file mode) |
| `msg.voice` | `string` | Overrides the configured voice / language (TTS mode) |
| `msg.volume` | `number` | Overrides the volume (0–100) |
| `msg.mode` | `string` | `"file"` or `"tts"` — overrides the node's mode |
| `msg.cacheFolder` | `string` | Overrides the configured cache directory (file mode). Disables caching if set to empty string |
| `msg.stop` | `boolean` | `true` to stop playback immediately |

#### Output message (emitted when playback finishes normally)

| Property | Type | Value |
|----------|------|-------|
| `msg.payload` | `string` | `"ok"` |
| `msg.status` | `string` | `"done"` |
| `msg.mode` | `string` | `"file"` or `"tts"` |
| `msg.source` | `string` | File path (file mode) or text spoken (TTS mode) |

Use this output to chain actions after playback — for example, resuming Spotify via its Web API.

#### MP3 Caching for faster replays

When a file is played for the first time, the plugin caches the ffmpeg PCM output (16-bit, 44.1 kHz, stereo). Subsequent plays of the same file skip ffmpeg entirely and read directly from the cache — **enabling instant playback**. The cache is automatically invalidated if the source file changes.

**Setup:**
1. Create a RAM disk (avoids slow SD card writes):
   - **macOS**: `diskutil secureErase freespace 0 -type JHFS+ ramdisk 200m` → `/Volumes/ramdisk`
   - **Linux / Pi**: `mkdir -p /mnt/ramdisk && mount -t tmpfs -o size=200m tmpfs /mnt/ramdisk`
2. Configure the **MP3 Cache Dir** on the node to your RAM disk path
3. Cache files are named by MD5 hash of the MP3 path (e.g. `3d5a5c8f...pcm`)

**Result:** Playing the same MP3 every 5 minutes? First play takes 1–2 seconds (ffmpeg), subsequent plays are instant (<100ms).

#### Status indicators on cache hits

When a file is played from cache, the status shows the cached file size:
- **Blue / playing (cached 2.1MB)** — reading from cache, not running ffmpeg

---

## Status indicators

| Colour | Text | Meaning |
|--------|------|---------|
| Yellow | connecting… | Waiting for the AirPlay device |
| Green | playing | Audio is streaming |
| Blue | playing (cached …) | Reading from ffmpeg cache (file mode only) |
| Grey | done | Finished normally |
| Red | — | Error — check the debug panel |

---

## TTS voice options

### macOS — `say` voices

List all available voices with `say -v ?`. Common German voices: `Anna`, `Petra`, `Markus`.

```bash
say -v Anna "Hallo, das ist eine Nachricht"
```

### Linux — `espeak` languages

Pass a language code with `-v`. Example: `de` for German, `en` for English, `fr` for French.

```bash
espeak -v de "Hallo, das ist eine Nachricht"
```

---

## Example Flow

```json
[
    {
        "id": "inject1",
        "type": "inject",
        "name": "Play background music",
        "props": [{ "p": "filePath", "v": "/home/pi/music/lofi.mp3", "vt": "str" }],
        "wires": [["airplay1"]]
    },
    {
        "id": "inject2",
        "type": "inject",
        "name": "Announce in German",
        "props": [
            { "p": "payload", "v": "Der Kaffee ist fertig!", "vt": "str" },
            { "p": "mode",    "v": "tts", "vt": "str" },
            { "p": "voice",   "v": "Anna", "vt": "str" }
        ],
        "wires": [["airplay1"]]
    },
    {
        "id": "inject3",
        "type": "inject",
        "name": "Stop",
        "props": [{ "p": "stop", "v": "true", "vt": "bool" }],
        "wires": [["airplay1"]]
    },
    {
        "id": "airplay1",
        "type": "airplay",
        "name": "HomePod",
        "device": "config1",
        "mode": "file",
        "filePath": "/home/pi/music/lofi.mp3",
        "ttsVoice": "Anna"
    },
    {
        "id": "config1",
        "type": "airtunes-config",
        "name": "Living Room HomePod",
        "host": "192.168.178.45",
        "port": 7000,
        "volume": 50
    }
]
```

---

## How It Works

1. A trigger arrives → the node stops any active playback and starts a new AirTunes session.
2. Simultaneously, if mode is TTS (macOS), `say` begins writing the AIFF to a temp file in parallel with the AirPlay handshake.
3. Once the device is `ready`:
   - **File mode**: `ffmpeg` decodes the MP3 and pipes raw 16-bit PCM (44 100 Hz stereo) to `airtunes2`.
   - **TTS mode (macOS)**: waits for `say` to finish (usually already done), then `ffmpeg` reads the AIFF and pipes PCM to `airtunes2`. The temp file is deleted after playback.
   - **TTS mode (Linux)**: `espeak --stdout` pipes WAV directly into `ffmpeg`'s stdin, then into `airtunes2`.
4. When `ffmpeg` exits, the AirTunes stream is ended. After a 3 s drain, `stopAll()` is called.
5. The node emits an output message.

---

## License

MIT