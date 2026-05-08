// ══════════════════════════════════════════════════════════════════
// IndexedDB
// ══════════════════════════════════════════════════════════════════
const DB_NAME    = 'slowReverbDB';
const DB_VERSION = 1;
const MAX_FILES  = 20;
let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('audioFiles')) {
        const s = d.createObjectStore('audioFiles', { keyPath: 'id', autoIncrement: true });
        s.createIndex('fileKey', 'fileKey', { unique: true });
      }
      if (!d.objectStoreNames.contains('presets')) {
        d.createObjectStore('presets', { keyPath: 'fileKey' });
      }
    };
    req.onsuccess  = e => resolve(e.target.result);
    req.onerror    = e => reject(e.target.error);
  });
}

function makeFileKey(name, size) { return `${name}::${size}`; }

function dbSaveFile(file, arrayBuffer) {
  return new Promise((resolve, reject) => {
    const tx    = db.transaction('audioFiles', 'readwrite');
    const store = tx.objectStore('audioFiles');
    const key   = makeFileKey(file.name, file.size);
    store.index('fileKey').get(key).onsuccess = e => {
      const existing = e.target.result;
      const record = { fileKey: key, name: file.name, size: file.size,
                       type: file.type, data: arrayBuffer, lastPlayed: Date.now() };
      if (existing) { record.id = existing.id; store.put(record); }
      else           store.add(record);
    };
    tx.oncomplete = () => resolve();
    tx.onerror    = e => reject(e.target.error);
  });
}

function dbGetAllFiles() {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('audioFiles', 'readonly');
    const req = tx.objectStore('audioFiles').getAll();
    req.onsuccess = e => resolve(e.target.result.sort((a, b) => a.id - b.id));
    req.onerror   = e => reject(e.target.error);
  });
}

function dbDeleteFile(fileKey) {
  return new Promise((resolve, reject) => {
    const tx         = db.transaction(['audioFiles', 'presets'], 'readwrite');
    const fileStore  = tx.objectStore('audioFiles');
    const presetStore= tx.objectStore('presets');
    fileStore.index('fileKey').getKey(fileKey).onsuccess = e => {
      if (e.target.result !== undefined) fileStore.delete(e.target.result);
    };
    presetStore.delete(fileKey);
    tx.oncomplete = () => resolve();
    tx.onerror    = e => reject(e.target.error);
  });
}

function dbSavePreset(fileKey, preset) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('presets', 'readwrite');
    tx.objectStore('presets').put({ fileKey, ...preset });
    tx.oncomplete = () => resolve();
    tx.onerror    = e => reject(e.target.error);
  });
}

function dbUpdateFileMeta(fileKey, customMeta) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('audioFiles', 'readwrite');
    const store = tx.objectStore('audioFiles');
    store.index('fileKey').get(fileKey).onsuccess = e => {
      const record = e.target.result;
      if (record) {
        record.customMeta = customMeta;
        store.put(record);
      }
      resolve();
    };
    tx.onerror = e => reject(e.target.error);
  });
}

function dbGetFileMeta(fileKey) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('audioFiles', 'readonly');
    const store = tx.objectStore('audioFiles');
    store.index('fileKey').get(fileKey).onsuccess = e => {
      resolve(e.target.result ? e.target.result.customMeta : null);
    };
    tx.onerror = e => reject(e.target.error);
  });
}

function dbGetPreset(fileKey) {
  return new Promise((resolve, reject) => {
    const tx  = db.transaction('presets', 'readonly');
    const req = tx.objectStore('presets').get(fileKey);
    req.onsuccess = e => resolve(e.target.result || null);
    req.onerror   = e => reject(e.target.error);
  });
}

async function dbPruneOldFiles() {
  const files = await dbGetAllFiles();
  if (files.length > MAX_FILES) {
    const toDelete = files.slice(MAX_FILES);
    for (const f of toDelete) await dbDeleteFile(f.fileKey);
  }
}

const ICON_PLAY  = `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><polygon points="6,3 20,12 6,21"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><rect x="5" y="3" width="4" height="18" rx="1"/><rect x="15" y="3" width="4" height="18" rx="1"/></svg>`;

// ══════════════════════════════════════════════════════════════════
// Audio state
// ══════════════════════════════════════════════════════════════════
// Create our OWN native AudioContext and hand it to Tone.js.
// This guarantees we always have the real BaseAudioContext for AudioWorkletNode.
const nativeCtx = new (window.AudioContext || window.webkitAudioContext)();
Tone.setContext(nativeCtx);

let reverb = null, analyser = null;
let sourceNode = null;       // native AudioBufferSourceNode
let stNode     = null;       // SoundTouchNode (AudioWorklet)
let bridgeGainNode = null;   // native GainNode bridging ST → Tone.js
let audioBuffer = null;      // decoded AudioBuffer
let stRegistered = false;    // whether SoundTouch processor is loaded
let animFrameId = null;
let isPlaying   = false;
let loopEnabled = true;
let currentObjectURL = null;
let currentFileKey   = null;

// The ultimate Media Session fix: we feed the actual audio file into a hidden,
// nearly-silent <audio> element. This gives macOS a legitimate track to monitor
// (with the correct duration) instead of fighting Web Audio API bugs.
const mediaBridge = document.createElement('audio');
mediaBridge.volume = 0.00001; // completely inaudible (-100dB)
document.body.appendChild(mediaBridge);

// Seek tracking
let seekContextStart = 0; // Tone.now() when play began
let seekOffset       = 0; // seconds into buffer when play began
let isSeeking        = false;

// ══════════════════════════════════════════════════════════════════
// Elements
// ══════════════════════════════════════════════════════════════════
const dropzone      = document.getElementById('dropzone');
const fileInput     = document.getElementById('fileInput');
const fileBadge     = document.getElementById('fileBadge');
const fileBadgeName = document.getElementById('fileBadgeName');
const changeFile    = document.getElementById('changeFile');
const visualizer    = document.getElementById('visualizer');
const ctx2d         = visualizer.getContext('2d');
const playBtn       = document.getElementById('playBtn');
const prevBtn       = document.getElementById('prevBtn');
const nextBtn       = document.getElementById('nextBtn');
const loopBtn       = document.getElementById('loopBtn');
const statusEl      = document.getElementById('status');
const historyList   = document.getElementById('historyList');
const seekSlider     = document.getElementById('seekSlider');
const seekCurrent    = document.getElementById('seekCurrent');
const seekTotal      = document.getElementById('seekTotal');
const playerSongName = document.getElementById('playerSongName');
const playerCover    = document.getElementById('playerCover');
const ytInput        = document.getElementById('ytInput');
const ytBtn          = document.getElementById('ytBtn');
const ytProgressWrap = document.getElementById('ytProgressWrap');
const ytBar          = document.getElementById('ytBar');
const ytStatusEl     = document.getElementById('ytStatus');
const ytResults      = document.getElementById('ytResults');
const speedSlider   = document.getElementById('speedSlider');
const reverbSlider  = document.getElementById('reverbSlider');
const pitchSlider   = document.getElementById('pitchSlider');
const volumeSlider  = document.getElementById('volumeSlider');
const speedVal      = document.getElementById('speedVal');
const reverbVal     = document.getElementById('reverbVal');
const pitchVal      = document.getElementById('pitchVal');
const volumeVal     = document.getElementById('volumeVal');

// ══════════════════════════════════════════════════════════════════
// Slider helpers
// ══════════════════════════════════════════════════════════════════
function sliderFill(slider) {
  const pct = ((slider.value - slider.min) / (slider.max - slider.min)) * 100;
  slider.style.setProperty('--fill', pct + '%');
}

function formatPitch(v) {
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return sign + Math.abs(v) + 'st';
}

function syncDisplayValues() {
  speedVal.textContent  = parseFloat(speedSlider.value).toFixed(2) + '×';
  reverbVal.textContent = Math.round(parseFloat(reverbSlider.value) * 100) + '%';
  pitchVal.textContent  = formatPitch(parseFloat(pitchSlider.value));
  volumeVal.textContent = Math.round(parseFloat(volumeSlider.value) * 100) + '%';
  [speedSlider, reverbSlider, pitchSlider, volumeSlider].forEach(sliderFill);
}
// Restore global volume from localStorage
const savedVolume = localStorage.getItem('globalVolume');
if (savedVolume !== null) volumeSlider.value = savedVolume;
syncDisplayValues();

// When true: no pitch shifting — speed and pitch coupled (best quality)
let pitchNatural = false;

function applyPlaybackRate() {
  const speed = parseFloat(speedSlider.value);
  try { mediaBridge.playbackRate = speed; } catch (_) {}
  
  if (pitchNatural) {
    // Vinyl mode: speed and pitch coupled — no pitch compensation
    if (sourceNode) sourceNode.playbackRate.value = speed;
    if (stNode) {
      stNode.parameters.get('pitchSemitones').value = 0;
      stNode.parameters.get('playbackRate').value = 1;
    }
  } else {
    // Independent mode: sourceNode sets speed, stNode compensates pitch then shifts it
    if (sourceNode) sourceNode.playbackRate.value = speed;
    if (stNode) {
      stNode.parameters.get('pitchSemitones').value = parseFloat(pitchSlider.value);
      stNode.parameters.get('playbackRate').value = speed; // cancels pitch drift from sourceNode speed
    }
  }
}

const pitchLinkBtn = document.getElementById('pitchLinkBtn');
const pitchRow     = document.getElementById('pitchRow');

pitchLinkBtn.addEventListener('click', () => {
  pitchNatural = !pitchNatural;
  pitchLinkBtn.style.opacity  = pitchNatural ? '1'    : '0.5';
  pitchLinkBtn.title = pitchNatural
    ? 'Natural: speed and pitch move together (best quality) — click to decouple'
    : 'Natural: speed and pitch move together (best quality)';
  pitchSlider.disabled        = pitchNatural;
  pitchSlider.style.opacity   = pitchNatural ? '0.3'  : '1';
  pitchVal.style.opacity      = pitchNatural ? '0.3'  : '1';
  applyPlaybackRate();
});

// Debounced preset auto-save
let presetSaveTimer = null;
function schedulePresetSave() {
  if (!currentFileKey) return;
  clearTimeout(presetSaveTimer);
  presetSaveTimer = setTimeout(() => {
    dbSavePreset(currentFileKey, currentPreset()).catch(() => {});
    renderHistory();
  }, 600);
}

function currentPreset() {
  return {
    speed:  parseFloat(speedSlider.value),
    reverb: parseFloat(reverbSlider.value),
    pitch:  parseFloat(pitchSlider.value),
  };
}

function applyPreset(p) {
  speedSlider.value  = p.speed;
  reverbSlider.value = p.reverb;
  pitchSlider.value  = p.pitch;
  syncDisplayValues();
}

// Slider event listeners
speedSlider.addEventListener('input', () => {
  speedVal.textContent = parseFloat(speedSlider.value).toFixed(2) + '×';
  sliderFill(speedSlider);
  // When speed changes during playback, recalculate seek offset to keep
  // the timeline accurate, then apply new rate.
  if (isPlaying && sourceNode) {
    seekOffset = getCurrentPos();
    seekContextStart = Tone.now();
  }
  applyPlaybackRate();
  schedulePresetSave();
  if (typeof updateMediaSessionPositionState === 'function') {
    updateMediaSessionPositionState();
  }
});

reverbSlider.addEventListener('input', () => {
  reverbVal.textContent = Math.round(parseFloat(reverbSlider.value) * 100) + '%';
  sliderFill(reverbSlider);
  if (reverb) reverb.wet.value = parseFloat(reverbSlider.value);
  schedulePresetSave();
});

pitchSlider.addEventListener('input', () => {
  pitchVal.textContent = formatPitch(parseFloat(pitchSlider.value));
  sliderFill(pitchSlider);
  applyPlaybackRate();
  schedulePresetSave();
});

volumeSlider.addEventListener('input', () => {
  const v = parseFloat(volumeSlider.value);
  volumeVal.textContent = Math.round(v * 100) + '%';
  sliderFill(volumeSlider);
  applyVolume(v);
  localStorage.setItem('globalVolume', v);
});

// ══════════════════════════════════════════════════════════════════
// Drop zone / file input
// ══════════════════════════════════════════════════════════════════
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
changeFile.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover',  e => { e.preventDefault(); dropzone.classList.add('drag-over'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('audio/')) loadFile(file);
  else if (file) setStatus('please drop an audio file');
});

fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) loadFile(file);
  fileInput.value = '';
});

// ══════════════════════════════════════════════════════════════════
// Audio loading — Hybrid engine: native Web Audio + SoundTouch WASM + Tone.js FX
// ══════════════════════════════════════════════════════════════════

// Volume helper — controls the bridge gain node between SoundTouch and Reverb
function applyVolume(v) {
  if (v === undefined) v = parseFloat(volumeSlider.value);
  const gain = v * 0.2; // cap at 20% of full volume
  if (bridgeGainNode) {
    bridgeGainNode.gain.value = gain;
  }
}

// Ensure the SoundTouch AudioWorklet is registered once
async function ensureSoundTouch() {
  if (stRegistered) return;
  await nativeCtx.audioWorklet.addModule(`${SERVER}/soundtouch-processor.js`);
  stRegistered = true;
}

function stopSource() {
  if (sourceNode) {
    try { sourceNode.onended = null; sourceNode.stop(); } catch (_) {}
    try { sourceNode.disconnect(); } catch (_) {}
    sourceNode = null;
  }
}

// Create and start a new AudioBufferSourceNode at the given offset
function createAndStartSource(offset = 0) {
  stopSource();
  sourceNode = nativeCtx.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.loop = loopEnabled;
  sourceNode.playbackRate.value = parseFloat(speedSlider.value);
  sourceNode.connect(stNode);
  sourceNode.start(0, offset);

  // Handle natural end (non-looping)
  sourceNode.onended = () => {
    if (!loopEnabled && isPlaying && !advancingToNext) {
      advancingToNext = true;
      playNext();
    }
  };
}

function applyMetadataToUI(meta, fileKey) {
  if (currentFileKey !== fileKey) return;
  playerSongName.innerHTML = `
    <div class="player-song-title">${escHtml(meta.title)}</div>
    <div class="player-song-artist">${escHtml(meta.artist)}</div>
  `;
  if (meta.coverUrl) {
    playerCover.src = meta.coverUrl;
    playerCover.style.display = 'block';
  } else {
    playerCover.src = '';
    playerCover.style.display = 'none';
  }
  if ('mediaSession' in navigator) {
    const metadataObj = { title: meta.title, artist: meta.artist, album: meta.album };
    if (meta.coverUrl) {
      metadataObj.artwork = [
        { src: meta.coverUrl, sizes: '512x512', type: 'image/jpeg' },
        { src: meta.coverUrl, sizes: '256x256', type: 'image/jpeg' },
        { src: meta.coverUrl, sizes: '128x128', type: 'image/jpeg' }
      ];
    }
    navigator.mediaSession.metadata = new MediaMetadata(metadataObj);
  }
}

async function fetchTrackMetadata(query) {
  try {
    const cleanQuery = query.replace(/\.[^.]+$/, '').replace(/\[.*\]/g, '').replace(/\(.*\)/g, '').trim();
    const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(cleanQuery)}&entity=song&limit=1`);
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      const track = data.results[0];
      return {
        coverUrl: track.artworkUrl100 ? track.artworkUrl100.replace('100x100bb', '512x512bb') : null,
        title: track.trackName,
        artist: track.artistName,
        album: track.collectionName
      };
    }
  } catch (err) {
    console.warn('Failed to fetch track metadata', err);
  }
  return null;
}

async function teardown(clearUI = true) {
  stopSource();
  isPlaying = false;
  seekOffset = 0;
  resetSeekBar();
  if (clearUI) {
    playerSongName.textContent = 'no track loaded';
    playerSongName.classList.add('empty');
    playerCover.style.display = 'none';
    playerCover.src = '';
  }
  playBtn.innerHTML = ICON_PLAY;
  playBtn.classList.remove('playing');
  prevBtn.disabled = true;
  nextBtn.disabled = true;
  if (animFrameId) { cancelAnimationFrame(animFrameId); animFrameId = null; }
  if (stNode)   { try { stNode.disconnect(); }       catch (_) {} stNode   = null; }
  if (bridgeGainNode) { try { bridgeGainNode.disconnect(); } catch (_) {} bridgeGainNode = null; }
  if (reverb)   { try { reverb.dispose(); }           catch (_) {} reverb   = null; }
  if (analyser) { try { analyser.dispose(); }         catch (_) {} analyser = null; }
  if (currentObjectURL) { URL.revokeObjectURL(currentObjectURL); currentObjectURL = null; }
  audioBuffer = null;
  try { mediaBridge.pause(); mediaBridge.removeAttribute('src'); mediaBridge.load(); } catch (_) {}
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'none';
  }
}

// fileKey override lets history loads skip re-saving to DB
async function loadFile(file, overrideKey = null, autoplay = false, initialPos = 0) {
  const fileKey = overrideKey ?? makeFileKey(file.name, file.size);
  const displayName = file.name.replace(/\.[^.]+$/, '');

  currentFileKey = fileKey;
  playerSongName.classList.remove('empty');
  fileBadgeName.textContent = file.name;
  fileBadge.classList.add('visible');
  dropzone.style.display = 'none';
  playBtn.disabled = true;
  setStatus('loading…', false);

  document.querySelectorAll('.history-item').forEach(el => {
    if (el.dataset.filekey === fileKey) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });

  const savedMeta = await dbGetFileMeta(fileKey);
  let metaPromise = Promise.resolve({ meta: savedMeta, isNew: false });

  if (savedMeta) {
    applyMetadataToUI(savedMeta, fileKey);
  } else {
    // Show fallback instantly while fetching from iTunes
    playerSongName.innerHTML = `<div class="player-song-title">${escHtml(displayName)}</div>`;
    playerCover.style.display = 'none';
    playerCover.src = '';
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({ title: displayName, artist: 'Slowcort' });
    }

    metaPromise = fetchTrackMetadata(displayName).then(meta => {
      if (meta) applyMetadataToUI(meta, fileKey);
      return { meta, isNew: true };
    });
  }

  await teardown(false);

  // Get the raw ArrayBuffer (also persists to IndexedDB if new)
  let rawBuf;
  if (!overrideKey) {
    try {
      rawBuf = await file.arrayBuffer();
      await dbSaveFile(file, rawBuf);
      await dbPruneOldFiles();
      
      // Save autofetched metadata to db and update history UI
      metaPromise.then(({ meta, isNew }) => {
        if (isNew && meta) {
          dbUpdateFileMeta(fileKey, meta).then(() => renderHistory());
        }
      });
    } catch (_) {
      rawBuf = rawBuf || await file.arrayBuffer();
    }
  } else {
    rawBuf = await file.arrayBuffer();
  }

  // Load the file into our hidden dummy element for OS Media Session syncing
  try {
    currentObjectURL = URL.createObjectURL(new Blob([rawBuf], { type: file.type || 'audio/mpeg' }));
    mediaBridge.src = currentObjectURL;
  } catch (err) {
    console.warn('Failed to attach media bridge:', err);
  }

  try {
    // Resume our native context (browser autoplay policy)
    if (nativeCtx.state === 'suspended') await nativeCtx.resume();
    await Tone.start();

    // Register SoundTouch processor (once)
    await ensureSoundTouch();

    // Decode audio to native AudioBuffer
    audioBuffer = await nativeCtx.decodeAudioData(rawBuf.slice(0));

    // Create SoundTouch AudioWorkletNode
    stNode = new AudioWorkletNode(nativeCtx, 'soundtouch-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const speed = parseFloat(speedSlider.value);
    stNode.parameters.get('pitchSemitones').value = pitchNatural ? 0 : parseFloat(pitchSlider.value);
    stNode.parameters.get('playbackRate').value = pitchNatural ? 1 : speed; // compensates pitch drift from sourceNode speed

    // Create Tone.js effects chain
    analyser = new Tone.Analyser('fft', 256);
    reverb   = new Tone.Reverb({ decay: 5, wet: parseFloat(reverbSlider.value) });
    await reverb.ready;

    // Wire: SoundTouchNode → Tone.Reverb → Tone.Analyser → Destination
    // Bridge native AudioWorkletNode into Tone.js effect chain.
    bridgeGainNode = nativeCtx.createGain();
    stNode.connect(bridgeGainNode);
    // Tone.connect can accept native AudioNodes on the source side
    Tone.connect(bridgeGainNode, reverb);
    reverb.connect(analyser);
    analyser.toDestination();

    // Volume
    applyVolume();

    initSeekBar(initialPos);
    playBtn.disabled = false;
    prevBtn.disabled = false;
    nextBtn.disabled = false;
    visualizer.classList.add('visible');
    startVisualizer();
    setStatus('ready', true);

    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
      updateMediaSessionPositionState();
    }

    renderHistory();

    if (autoplay) {
      // seekOffset was just reset to 0 by teardown, doPlay will use it
      await doPlay();
    }

  } catch (err) {
    setStatus('error: ' + err.message);
    console.error(err);
  }
}

// ══════════════════════════════════════════════════════════════════
// Playback
// ══════════════════════════════════════════════════════════════════
async function doPlay() {
  if (!audioBuffer) return;
  // Always update OS state
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = 'playing';
  }
  try { mediaBridge.play().catch(() => {}); } catch (_) {}
  if (nativeCtx.state === 'suspended') await nativeCtx.resume();
  
  if (isPlaying) return;
  
  await Tone.start();
  createAndStartSource(seekOffset);
  seekContextStart = Tone.now();
  isPlaying = true;
  playBtn.innerHTML = ICON_PAUSE;
  playBtn.classList.add('playing');
  setStatus('playing', true);
  if ('mediaSession' in navigator) updateMediaSessionPositionState();

  // Update lastPlayed in DB
  if (currentFileKey) {
    const tx = db.transaction('audioFiles', 'readwrite');
    const store = tx.objectStore('audioFiles');
    store.index('fileKey').get(currentFileKey).onsuccess = e => {
      const rec = e.target.result;
      if (rec) { rec.lastPlayed = Date.now(); store.put(rec); }
    };
  }
}

async function doPause() {
  if (!audioBuffer) return;
  // Always update OS state
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  try { mediaBridge.pause(); } catch (_) {}
  if (nativeCtx.state === 'running') {
    nativeCtx.suspend().catch(() => {});
  }
  
  if (!isPlaying) return;
  
  seekOffset = getCurrentPos();
  stopSource();
  isPlaying = false;
  playBtn.innerHTML = ICON_PLAY;
  playBtn.classList.remove('playing');
  setStatus('paused', true);
  if ('mediaSession' in navigator) updateMediaSessionPositionState();

  try { mediaBridge.pause(); } catch (_) {}
  
  if (nativeCtx.state === 'running') {
    await nativeCtx.suspend();
  }
}

playBtn.addEventListener('click', async () => {
  if (!audioBuffer) return;
  if (!isPlaying) await doPlay();
  else await doPause();
});

const savedLoop = localStorage.getItem('loopEnabled');
loopEnabled = savedLoop !== null ? savedLoop === 'true' : true;
loopBtn.classList.toggle('active', loopEnabled);
loopBtn.addEventListener('click', () => {
  loopEnabled = !loopEnabled;
  if (sourceNode) sourceNode.loop = loopEnabled;
  loopBtn.classList.toggle('active', loopEnabled);
  localStorage.setItem('loopEnabled', loopEnabled);
});

// ══════════════════════════════════════════════════════════════════
// History panel
// ══════════════════════════════════════════════════════════════════
async function renderHistory() {
  let files;
  try { files = await dbGetAllFiles(); } catch (_) { return; }

  if (files.length === 0) {
    historyList.innerHTML = '<p class="history-empty">files you play<br>will appear here</p>';
    return;
  }

  // Load all presets in parallel
  const presets = await Promise.all(files.map(f => dbGetPreset(f.fileKey).catch(() => null)));

  historyList.innerHTML = '';
  files.forEach((f, i) => {
    const p = presets[i];
    const isActive = f.fileKey === currentFileKey;

    const item = document.createElement('div');
    item.className = 'history-item' + (isActive ? ' active' : '');
    item.dataset.filekey = f.fileKey;

    const tags = p ? [
      `${parseFloat(p.speed).toFixed(2)}×`,
      `rev ${Math.round(p.reverb * 100)}%`,
      formatPitch(parseFloat(p.pitch)),
    ] : [];

    const meta = f.customMeta;
    const title = meta ? meta.title : f.name.replace(/\.[^.]+$/, '');
    const artist = meta ? meta.artist : '';
    const coverUrl = meta ? meta.coverUrl : null;

    const coverHtml = coverUrl
      ? `<img src="${coverUrl}" style="width: 34px; height: 34px; border-radius: 4px; object-fit: cover; flex-shrink: 0; background: rgba(0,0,0,0.2);">`
      : `<div style="width: 34px; height: 34px; border-radius: 4px; background: rgba(0,0,0,0.1); flex-shrink: 0; display: flex; align-items: center; justify-content: center; color: var(--text-dim);"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle></svg></div>`;

    item.innerHTML = `
      <div style="display: flex; gap: 0.6rem; align-items: center; padding-right: 1.2rem; margin-bottom: 0.35rem;">
        ${coverHtml}
        <div style="min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 0.1rem;">
          <div class="history-item-name" style="margin-bottom: 0; padding-right: 0;" title="${escHtml(title)}">${escHtml(title)}</div>
          ${artist ? `<div style="font-size: 0.68rem; color: var(--text-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escHtml(artist)}">${escHtml(artist)}</div>` : ''}
        </div>
      </div>
      <div class="history-item-meta">
        ${tags.map(t => `<span class="preset-tag">${t}</span>`).join('')}
      </div>
      <button class="history-item-del" title="Remove">×</button>
    `;

    item.addEventListener('click', () => loadFromHistory(f, p));
    item.querySelector('.history-item-del').addEventListener('click', async e => {
      e.stopPropagation();
      await dbDeleteFile(f.fileKey);
      if (currentFileKey === f.fileKey) currentFileKey = null;
      // Also delete from disk (best-effort — ignore if server not running or file already gone)
      try { await fetch(`${SERVER}/file?name=${encodeURIComponent(f.name)}`, { method: 'DELETE' }); } catch (_) {}
      renderHistory();
    });

    historyList.appendChild(item);
  });
}

async function loadFromHistory(record, preset, autoplay = true, initialPos = 0) {
  // Apply saved preset before loading so audio chain picks them up
  if (preset) applyPreset(preset);

  const blob = new Blob([record.data], { type: record.type || 'audio/mpeg' });
  const file = new File([blob], record.name, { type: record.type });

  await loadFile(file, record.fileKey, autoplay, initialPos);
}

// ══════════════════════════════════════════════════════════════════
// Visualizer
// ══════════════════════════════════════════════════════════════════
function startVisualizer() {
  const W = visualizer.width;
  const H = visualizer.height;
  const barCount = 72;

  function draw() {
    animFrameId = requestAnimationFrame(draw);
    updateSeekBar();
    ctx2d.clearRect(0, 0, W, H);
    if (!analyser) return;
    const values = analyser.getValue();
    const step   = Math.floor(values.length / barCount);
    const barW   = W / barCount - 1;
    for (let i = 0; i < barCount; i++) {
      const db   = values[i * step] ?? -140;
      const norm = Math.max(0, (db + 100) / 100);
      const barH = Math.max(2, norm * H * 0.9);
      const x    = i * (barW + 1);
      const light= 55 + norm * 25;
      const alpha= 0.35 + norm * 0.65;
      ctx2d.fillStyle = `hsla(100,18%,${light}%,${alpha})`;
      ctx2d.beginPath();
      ctx2d.roundRect(x, H - barH, barW, barH, [2, 2, 0, 0]);
      ctx2d.fill();
    }
  }

  if (animFrameId) cancelAnimationFrame(animFrameId);
  draw();
}

// ══════════════════════════════════════════════════════════════════
// Utilities
// ══════════════════════════════════════════════════════════════════
function setStatus(msg, active = false) {
  statusEl.textContent = msg;
  statusEl.className   = 'status' + (active ? ' active' : '');
}

function updateMediaSessionPositionState() {
  if ('mediaSession' in navigator && audioBuffer) {
    try {
      const dur = audioBuffer.duration;
      const pos = Math.max(0, Math.min(getCurrentPos(), dur));
      navigator.mediaSession.setPositionState({
        duration: dur,
        playbackRate: parseFloat(speedSlider.value),
        position: pos
      });
    } catch (e) {}
  }
}

function setupMediaSession() {
  if ('mediaSession' in navigator) {
    navigator.mediaSession.setActionHandler('play', async () => {
      await doPlay();
    });
    navigator.mediaSession.setActionHandler('pause', async () => {
      await doPause();
    });
    navigator.mediaSession.setActionHandler('nexttrack', () => { playNext(); });
    navigator.mediaSession.setActionHandler('previoustrack', () => { playPrev(); });
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      const t = details.seekTime;
      isSeeking = false;
      seekOffset = t;
      seekContextStart = Tone.now();
      try { mediaBridge.currentTime = t; } catch (_) {}
      if (audioBuffer && isPlaying) createAndStartSource(t);
      seekCurrent.textContent = formatTime(t);
      updateMediaSessionPositionState();
    });
  }
}
setupMediaSession();

// ══════════════════════════════════════════════════════════════════
// Seek bar
// ══════════════════════════════════════════════════════════════════
function formatTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function getCurrentPos() {
  if (!audioBuffer) return 0;
  if (!isPlaying) return seekOffset;
  const elapsed = (Tone.now() - seekContextStart) * parseFloat(speedSlider.value);
  const dur = audioBuffer.duration;
  let pos = seekOffset + elapsed;
  if (loopEnabled) pos = pos % dur;
  return Math.min(Math.max(pos, 0), dur);
}

let advancingToNext = false;
let lastSaveTime = 0;

function savePlaybackState() {
  if (currentFileKey) {
    localStorage.setItem('lastPlayedFile', currentFileKey);
    localStorage.setItem('lastPlayedPos', getCurrentPos().toString());
  } else {
    localStorage.removeItem('lastPlayedFile');
    localStorage.removeItem('lastPlayedPos');
  }
}

window.addEventListener('pagehide', savePlaybackState);
window.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') savePlaybackState();
});

function updateSeekBar() {
  if (isSeeking || !audioBuffer) return;
  const pos = getCurrentPos();
  const dur = audioBuffer.duration;
  
  if (Date.now() - lastSaveTime > 1000) {
    savePlaybackState();
    lastSaveTime = Date.now();
  }
  const pct = dur > 0 ? (pos / dur * 100) : 0;
  seekSlider.value = pos;
  seekSlider.style.setProperty('--fill', pct + '%');
  seekCurrent.textContent = formatTime(pos);
  seekCurrent.style.color = isPlaying ? 'var(--text-mid)' : 'var(--text-dim)';

  // Auto-advance when non-looping playback reaches the end
  if (isPlaying && !loopEnabled && dur > 0 && pos >= dur - 0.15 && !advancingToNext) {
    advancingToNext = true;
    playNext();
  }
}

async function playNext() {
  const files = await dbGetAllFiles();
  const idx   = files.findIndex(f => f.fileKey === currentFileKey);
  const next  = files[idx + 1];
  if (next) {
    const preset = await dbGetPreset(next.fileKey).catch(() => null);
    await loadFromHistory(next, preset);
  } else {
    // end of list — just stop cleanly
    isPlaying = false;
    seekOffset = 0;
    playBtn.innerHTML = ICON_PLAY;
    playBtn.classList.remove('playing');
    setStatus('ready', true);
  }
  advancingToNext = false;
}

async function playPrev() {
  const currentPos = getCurrentPos();
  if (currentPos > 3) {
    // Just restart song
    seekOffset = 0;
    seekContextStart = Tone.now();
    if (audioBuffer && isPlaying) createAndStartSource(0);
    updateSeekBar();
    updateMediaSessionPositionState();
  } else {
    // Go to previous track
    const files = await dbGetAllFiles();
    const idx   = files.findIndex(f => f.fileKey === currentFileKey);
    const prev  = files[idx - 1];
    if (prev) {
      const preset = await dbGetPreset(prev.fileKey).catch(() => null);
      await loadFromHistory(prev, preset);
    } else {
      // Just restart
      seekOffset = 0;
      seekContextStart = Tone.now();
      if (audioBuffer && isPlaying) createAndStartSource(0);
      updateSeekBar();
      updateMediaSessionPositionState();
    }
  }
}

prevBtn.addEventListener('click', () => { if (audioBuffer) playPrev(); });
nextBtn.addEventListener('click', () => { if (audioBuffer) playNext(); });

function initSeekBar(initialPos = 0) {
  const dur = audioBuffer.duration;
  const pos = Math.min(initialPos, dur);
  seekSlider.max = dur;
  seekSlider.value = pos;
  seekSlider.disabled = false;
  seekTotal.textContent = formatTime(dur);
  seekCurrent.textContent = formatTime(pos);
  seekOffset = pos;
  const pct = dur > 0 ? (pos / dur * 100) : 0;
  seekSlider.style.setProperty('--fill', pct + '%');
}

function resetSeekBar() {
  seekSlider.max = 100;
  seekSlider.value = 0;
  seekSlider.disabled = true;
  seekCurrent.textContent = '0:00';
  seekTotal.textContent = '0:00';
  seekOffset = 0;
}

// Scrubbing
seekSlider.addEventListener('mousedown', () => { isSeeking = true; });
seekSlider.addEventListener('touchstart', () => { isSeeking = true; }, { passive: true });

seekSlider.addEventListener('input', () => {
  const t = parseFloat(seekSlider.value);
  seekCurrent.textContent = formatTime(t);
});

seekSlider.addEventListener('change', () => {
  const t = parseFloat(seekSlider.value);
  isSeeking = false;
  seekOffset = t;
  seekContextStart = Tone.now();
  if (audioBuffer && isPlaying) {
    createAndStartSource(t);
  }
  seekCurrent.textContent = formatTime(t);
  updateMediaSessionPositionState();
  savePlaybackState();
});

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ══════════════════════════════════════════════════════════════════
// YouTube search + import
// ══════════════════════════════════════════════════════════════════
const SERVER = 'http://localhost:3847';

function isYtUrl(v) { return /youtube\.com|youtu\.be/.test(v); }

function ytSetStatus(msg, isError = false) {
  ytStatusEl.textContent = msg;
  ytStatusEl.className   = 'yt-status' + (isError ? ' error' : '');
}

function ytReset() {
  ytBtn.disabled = false;
  ytProgressWrap.classList.remove('visible');
  ytBar.classList.remove('indeterminate');
  ytBar.style.width = '0%';
}

function hideResults() {
  ytResults.classList.remove('visible');
  ytResults.innerHTML = '';
}

// Dynamic button label
ytInput.addEventListener('input', () => {
  ytBtn.textContent = isYtUrl(ytInput.value.trim()) ? '↓' : 'search';
});

ytBtn.addEventListener('click', handleYtAction);
ytInput.addEventListener('keydown', e => { if (e.key === 'Enter') handleYtAction(); });

function handleYtAction() {
  const val = ytInput.value.trim();
  if (!val) return;
  if (isYtUrl(val)) startYtDownload(val);
  else              startYtSearch(val);
}

// ── Search ────────────────────────────────────────────────────────
async function startYtSearch(query) {
  ytBtn.disabled = true;
  hideResults();
  ytSetStatus('searching…');

  try {
    const resp = await fetch(`${SERVER}/search?q=${encodeURIComponent(query)}`);
    const results = await resp.json();

    ytSetStatus('');
    ytBtn.disabled = false;

    if (!results.length) { ytSetStatus('no results found'); return; }

    ytResults.innerHTML = '';
    results.forEach(r => {
      const item = document.createElement('div');
      item.className = 'yt-result';
      item.innerHTML = `
        <img src="${escHtml(r.thumbnail)}" loading="lazy" alt="">
        <div class="yt-result-info">
          <div class="yt-result-title" title="${escHtml(r.title)}">${escHtml(r.title)}</div>
          <div class="yt-result-meta">${escHtml(r.channel)}${r.duration ? ' · ' + escHtml(r.duration) : ''}</div>
        </div>`;
      item.addEventListener('click', () => {
        hideResults();
        ytInput.value = '';
        ytBtn.textContent = 'search';
        startYtDownload(`https://www.youtube.com/watch?v=${r.id}`);
      });
      ytResults.appendChild(item);
    });
    ytResults.classList.add('visible');

  } catch {
    ytSetStatus('server not reachable — run: node server.js', true);
    ytBtn.disabled = false;
  }
}

// ── Download ──────────────────────────────────────────────────────
function startYtDownload(url) {
  hideResults();
  ytBtn.disabled = true;
  ytProgressWrap.classList.add('visible');
  ytBar.style.width = '0%';
  ytBar.classList.remove('indeterminate');
  ytSetStatus('connecting…');

  let evtSource;
  let done = false; // guard: onerror must not fire after a successful done

  try {
    evtSource = new EventSource(`${SERVER}/download?url=${encodeURIComponent(url)}`);
  } catch {
    ytSetStatus('could not connect to server — run: node server.js', true);
    ytReset();
    return;
  }

  evtSource.onmessage = async (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === 'progress') {
      ytBar.style.width = msg.percent + '%';
      ytSetStatus(`downloading… ${msg.percent.toFixed(0)}%  ·  ${msg.speed}  ·  ETA ${msg.eta}`);
    }

    if (msg.type === 'done') {
      done = true;
      evtSource.close();
      ytBar.style.width = '100%';
      ytBar.classList.add('indeterminate');
      ytSetStatus('converting to mp3…');
      try {
        const resp = await fetch(`${SERVER}/file/${msg.token}`);
        if (!resp.ok) throw new Error('failed to fetch file');
        const blob = await resp.blob();
        const file = new File([blob], msg.name || 'youtube_audio.mp3', { type: 'audio/mpeg' });
        ytReset();
        ytSetStatus('');
        await loadFile(file);
      } catch (err) {
        ytSetStatus(err.message, true);
        ytReset();
      }
    }

    if (msg.type === 'error') {
      done = true;
      evtSource.close();
      ytSetStatus(msg.message, true);
      ytReset();
    }
  };

  evtSource.onerror = () => {
    if (done) return; // server closed connection after done — not a real error
    evtSource.close();
    ytSetStatus('server not reachable — run: node server.js', true);
    ytReset();
  };
}

// ══════════════════════════════════════════════════════════════════
// Manual Metadata Fix Modal
// ══════════════════════════════════════════════════════════════════
const playerSongArea = document.getElementById('playerSongArea');
const metaModal = document.getElementById('metaModal');
const metaInput = document.getElementById('metaInput');
const metaSearchBtn = document.getElementById('metaSearchBtn');
const metaCancelBtn = document.getElementById('metaCancelBtn');
const metaResults = document.getElementById('metaResults');

playerSongArea.addEventListener('click', () => {
  if (!currentFileKey) return;
  const titleEl = playerSongName.querySelector('.player-song-title');
  metaInput.value = titleEl ? titleEl.textContent : fileBadgeName.textContent.replace(/\.[^.]+$/, '');
  metaResults.style.display = 'none';
  metaResults.innerHTML = '';
  metaModal.style.display = 'flex';
  metaInput.focus();
  metaInput.select();
});

metaCancelBtn.addEventListener('click', () => metaModal.style.display = 'none');

metaInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') metaSearchBtn.click();
});

metaSearchBtn.addEventListener('click', async () => {
  const q = metaInput.value.trim();
  if (!q) return;
  metaSearchBtn.textContent = '...';
  try {
    const res = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=5`);
    const data = await res.json();
    metaResults.innerHTML = '';
    
    if (data.results && data.results.length > 0) {
      data.results.forEach(track => {
        const item = document.createElement('div');
        item.className = 'yt-result';
        item.innerHTML = `
          <img src="${track.artworkUrl100 || ''}" alt="" style="width:40px; height:40px; border-radius:4px; object-fit:cover;">
          <div class="yt-result-info">
            <div class="yt-result-title">${escHtml(track.trackName)}</div>
            <div class="yt-result-meta">${escHtml(track.artistName)} &middot; ${escHtml(track.collectionName)}</div>
          </div>
        `;
        item.addEventListener('click', async () => {
          const meta = {
            coverUrl: track.artworkUrl100 ? track.artworkUrl100.replace('100x100bb', '512x512bb') : null,
            title: track.trackName,
            artist: track.artistName,
            album: track.collectionName
          };
          if (currentFileKey) await dbUpdateFileMeta(currentFileKey, meta);
          applyMetadataToUI(meta, currentFileKey);
          metaModal.style.display = 'none';
          renderHistory();
        });
        metaResults.appendChild(item);
      });
      metaResults.style.display = 'flex';
    } else {
      metaResults.innerHTML = '<div style="padding:1rem; text-align:center; color:var(--text-dim); font-size:0.8rem;">No results found</div>';
      metaResults.style.display = 'flex';
    }
  } catch(e) {}
  metaSearchBtn.textContent = 'search';
});

// ══════════════════════════════════════════════════════════════════
// Scan downloads folder and import any MP3s not yet in IndexedDB
// ══════════════════════════════════════════════════════════════════
async function scanDownloads() {
  let serverFiles;
  try {
    const resp = await fetch(`${SERVER}/files`);
    if (!resp.ok) return;
    serverFiles = await resp.json();
  } catch { return; } // server not running

  if (!serverFiles.length) return;

  const existing    = await dbGetAllFiles();
  const existingKeys = new Set(existing.map(f => f.fileKey));
  const missing     = serverFiles.filter(sf => !existingKeys.has(makeFileKey(sf.name, sf.size)));

  if (!missing.length) return;

  for (const sf of missing) {
    try {
      const r = await fetch(`${SERVER}/file/${sf.token}`);
      if (!r.ok) continue;
      const blob = await r.blob();
      const file = new File([blob], sf.name, { type: 'audio/mpeg' });
      const buf  = await file.arrayBuffer();
      await dbSaveFile(file, buf);
    } catch (e) {
      console.warn('scanDownloads: failed to import', sf.name, e);
    }
  }

  renderHistory();
}

// ══════════════════════════════════════════════════════════════════
// Init
// ══════════════════════════════════════════════════════════════════
(async () => {
  try {
    db = await openDB();
    await renderHistory();
    
    // Restore previous playback state
    const lastFile = localStorage.getItem('lastPlayedFile');
    const lastPos = parseFloat(localStorage.getItem('lastPlayedPos')) || 0;
    if (lastFile) {
      const files = await dbGetAllFiles();
      const record = files.find(f => f.fileKey === lastFile);
      if (record) {
        const preset = await dbGetPreset(lastFile).catch(() => null);
        await loadFromHistory(record, preset, false, lastPos);
      }
    }
    
    scanDownloads(); // background — imports any new files from disk
  } catch (err) {
    console.warn('IndexedDB unavailable, history disabled:', err);
    historyList.innerHTML = '<p class="history-empty">history unavailable<br>(private mode?)</p>';
  }
})();
