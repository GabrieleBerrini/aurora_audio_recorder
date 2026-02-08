// ======================================================================
// STATE AND GLOBAL VARIABLES
// ======================================================================

// Base recording state
let mediaRecorder, recordedChunks = [], audioBlob = null, audioUrl = null;
let audioCtx, lowpassFilter, highpassFilter, delayNode, delayFeedback, reverbConvolver, dryGain, wetGain, masterGain, analyser, dataArray, animationId;
let recStartTime = 0;
let recTimerId = null;
let activeProcessedSource = null;
let mediaElementSource = null;

// Google Drive state
const GOOGLE_CLIENT_ID = "704802154881-t0b03q9dc11ijifmopp1f662rnh4hiuf.apps.googleusercontent.com"; 
const DRIVE_FOLDER_NAME = "Aurora Recordings";
const DRIVE_SCOPES = "https://www.googleapis.com/auth/drive.file";

let tokenClient = null;
let driveAccessToken = null;
let driveFolderIdCache = null;

// Waveform canva
const waveformCanvas = document.getElementById("waveform");
const wfCtx = waveformCanvas.getContext("2d");

// Fixed UI elements
const btnStartRec = document.getElementById("btnStartRec");
const btnStopRec = document.getElementById("btnStopRec");
const btnPlayProcessed = document.getElementById("btnPlayProcessed");
const btnDownloadWav = document.getElementById("btnDownloadWav");
const btnDownloadProcessedWav = document.getElementById("btnDownloadProcessedWav");
const statusEl = document.getElementById("status");
const player = document.getElementById("player");

// Dynamic UI containers
const knobsContainer = document.getElementById("knobsContainer");
const presetsContainer = document.getElementById("presetsContainer");

// Drive UI
const btnAuthDrive = document.getElementById("btnAuthDrive");
const btnUploadWav = document.getElementById("btnUploadWav");
const btnUploadProcessedWav = document.getElementById("btnUploadProcessedWav");
const driveStatusEl = document.getElementById("driveStatus");

// Knobs configuration
const knobsConfig = [
  { id: "gain", label: "Volume", min: 0, max: 100, step: 1, value: 50 },
  { id: "pitch", label: "Pitch", min: 0.5, max: 2.0, step: 0.01, value: 1.00 },
  { id: "lowpass", label: "Lowpass Filter", min: 200, max: 20000, step: 1, value: 20000 },
  { id: "highpass", label: "Highpass Filter", min: 10, max: 5000, step: 1, value: 10 },
  { id: "delayTime", label: "Delay", min: 0, max: 0.5, step: 0.01, value: 0 },
  { id: "reverbMix", label: "Reverb", min: 0, max: 1, step: 0.1, value: 0.3 }
];

// Parameter initial values
const paramValues = {
  gain: 1.00,
  pitch: 1.00,
  lowpass: 20000,
  highpass: 10,
  delayTime: 0,
  reverbMix: 0.0
};

// Presets configuration
const presetsConfig = {
  clean: {
    label: "Clean",
    params: { lowpass: 20000, highpass: 20, delayTime: 0, reverbMix: 0.0, pitch: 1 }
  },
  phone: {
    label: "Phone",
    params: { lowpass: 3500,  highpass: 400, delayTime: 0, reverbMix: 0.0, pitch: 1 }
  },
  hall: {
    label: "Hall",
    params: { lowpass: 18000, highpass: 80, delayTime: 0.25, reverbMix: 0.7, pitch: 1 }
  },
  lofi: {
    label: "Lo‑Fi",
    params: { lowpass: 5000, highpass: 150, delayTime: 0.12, reverbMix: 0.4, pitch: 0.9 }
  }
};

// ======================================================================
// DYNAMIC UI CREATION (KNOBS & PRESETS)
// ======================================================================

// Create knob elements dynamically
function createKnobs() {
  knobsConfig.forEach(cfg => {
    const wrapper = document.createElement("div");
    wrapper.className = "knob-wrapper";

    const knob = document.createElement("div");
    knob.className = "knob";
    knob.dataset.target = cfg.id;
    knob.dataset.min = cfg.min;
    knob.dataset.max = cfg.max;
    knob.dataset.step = cfg.step;

    const label = document.createElement("div");
    label.className = "knob-label";
    label.textContent = cfg.label;

    const valueEl = document.createElement("div");
    valueEl.className = "knob-value";
    valueEl.id = cfg.id + "Val";
    valueEl.textContent = (cfg.id === "lowpass" || cfg.id === "highpass")
      ? Math.round(cfg.value) // Condition for frequency knobs (integer values)
      : cfg.value.toFixed(2); // Other knobs (float values with two decimals)

    wrapper.appendChild(knob);
    wrapper.appendChild(label);
    wrapper.appendChild(valueEl);
    knobsContainer.appendChild(wrapper);
  });
}

// Create preset buttons dynamically
function createPresets() {
  Object.entries(presetsConfig).forEach(([name, preset]) => {
    const btn = document.createElement("button");
    btn.className = "preset";
    btn.dataset.preset = name;
    btn.textContent = preset.label;
    btn.addEventListener("click", () => applyPreset(name));
    presetsContainer.appendChild(btn);
  });
}

createKnobs();
createPresets();

// ======================================================================
// AUDIO GRAPH INITIALIZATION
// ======================================================================

function initAudioGraph() {
  if (audioCtx) return;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  lowpassFilter = audioCtx.createBiquadFilter();
  lowpassFilter.type = "lowpass";
  lowpassFilter.frequency.value = paramValues.lowpass;

  highpassFilter = audioCtx.createBiquadFilter();
  highpassFilter.type = "highpass";
  highpassFilter.frequency.value = paramValues.highpass;

  delayNode = audioCtx.createDelay(5.0);
  delayNode.delayTime.value = paramValues.delayTime;

  delayFeedback = audioCtx.createGain();
  delayFeedback.gain.value = 0.3;
  delayNode.connect(delayFeedback);
  delayFeedback.connect(delayNode);

  reverbConvolver = audioCtx.createConvolver();
  reverbConvolver.buffer = createReverbImpulse(audioCtx, 2.5, 2.0);

  dryGain = audioCtx.createGain();
  wetGain = audioCtx.createGain();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = paramValues.gain;

  const mix = paramValues.reverbMix;
  dryGain.gain.value = 1 - mix;
  wetGain.gain.value = mix;

  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  dataArray = new Uint8Array(analyser.fftSize);

  lowpassFilter.connect(highpassFilter);
  highpassFilter.connect(delayNode);
  delayNode.connect(dryGain);
  delayNode.connect(reverbConvolver);
  reverbConvolver.connect(wetGain);
  dryGain.connect(masterGain);
  wetGain.connect(masterGain);
  masterGain.connect(analyser);
  analyser.connect(audioCtx.destination);
}

// Connect HTML <audio> element to analyser to draw waveform on raw playback
function connectPlayerToAnalyser() {
  if (!audioCtx || !player) return;
  if (mediaElementSource) return;
  mediaElementSource = audioCtx.createMediaElementSource(player);
  mediaElementSource.connect(analyser);
}

// Generate an impulse response for the reverb
function createReverbImpulse(context, duration, decay) {
  const rate = context.sampleRate;
  const length = rate * duration;
  const impulse = context.createBuffer(2, length, rate);
  for (let c = 0; c < impulse.numberOfChannels; c++) {
    const chData = impulse.getChannelData(c);
    for (let i = 0; i < length; i++) {
      const n = (length - i) / length;
      chData[i] = (Math.random() * 2 - 1) * Math.pow(n, decay);
    }
  }
  return impulse;
}

// ======================================================================
// KNOB BEHAVIOR
// ======================================================================

// Knob utility functions
const lerp = (a, b, t) => a + (b - a) * t; // Linear interpolation for knobs angle-to-value conversion
const clamp = (v, min, max) => Math.min(max, Math.max(min, v)); // To set values within a range
const valueToAngle = (v, min, max) => -135 + ((v - min) / (max - min)) * 270;

// Knob behavior
const knobElems = document.querySelectorAll(".knob");

knobElems.forEach(knob => {
  const id = knob.dataset.target;
  const min = +knob.dataset.min; // The + operator is necessary to convert strings to numbers
  const max = +knob.dataset.max;
  const step = +knob.dataset.step || 0.01; // 0.01 is used as default step value

  let value = paramValues[id];
  let angle = valueToAngle(value, min, max);
  let dragging = false;

  knob.style.transform = `rotate(${angle}deg)`; // To let the knobs be in the right default position once the page is loaded

let startMouseAngle = 0;

// Function to get the mouse angle relative to the center of the knob
function mouseAngleDeg(ev, element) {
  const r = element.getBoundingClientRect(); // To get dimensions and relative position of the element with respect to the viewport
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const dx = ev.clientX - cx; // "clientX" and "clientY" give the mouse position relative to the viewport, so this two operations are useful to get the mouse position relative to the center of the knob
  const dy = ev.clientY - cy;
  return Math.atan2(dy, dx) * (180 / Math.PI);
}

knob.addEventListener("mousedown", (e) => {
  e.preventDefault(); // To prevent text selection while dragging ("preventDefault" unables the default browser behavior for the event)
  dragging = true;

  lastMouseAngle = mouseAngleDeg(e, knob);

  document.body.style.userSelect = "none";
});

window.addEventListener("mouseup", () => {
  dragging = false;
  document.body.style.userSelect = "";
});

window.addEventListener("mousemove", (e) => {
  if (!dragging) return;

  const currentMouseAngle = mouseAngleDeg(e, knob);
  let delta = currentMouseAngle - lastMouseAngle;

if (delta > 180) delta -= 360;
if (delta < -180) delta += 360;

const speed = e.shiftKey ? 0.35 : 1.0;
angle = clamp(angle + delta * speed, -135, 135);

lastMouseAngle = currentMouseAngle;

  knob.style.transform = `rotate(${angle}deg)`;

  const t = (angle + 135) / 270;
  const raw = lerp(min, max, t);
  const v = Math.round(raw / step) * step;

  value = v;
  updateParam(id, v);
  updateValLabel(id, v);
});

  updateValLabel(id, value);
  updateParam(id, value);
});

// Application of the presets
function applyPreset(name) {
  initAudioGraph();

  const preset = presetsConfig[name];
  if (!preset) return;

  const p = preset.params;

  const knobs = document.querySelectorAll(".knob");

  knobs.forEach(k => {
  const id = k.dataset.target;

  if (id === "gain") return; // The gain doesn't vary due to the application of the presets

  if (!(id in p)) return;

  const val = p[id];

  paramValues[id] = val; // Update internal state
  updateParam(id, val);
  updateValLabel(id, val);

  const min = +k.dataset.min;
  const max = +k.dataset.max;
  k.style.transform = `rotate(${valueToAngle(val, min, max)}deg)`;
});
}

function updateValLabel(id, v) {
  const el = document.getElementById(id + "Val");
  if (!el) return;
  if (id === "lowpass" || id === "highpass") el.textContent = Math.round(v);
  else el.textContent = v.toFixed(2);
}

function updateParam(id, v) {
  paramValues[id] = v;

  if (id === "gain" && masterGain) masterGain.gain.value = v / 100;
  else if (id === "lowpass" && lowpassFilter) lowpassFilter.frequency.value = v;
  else if (id === "highpass" && highpassFilter) highpassFilter.frequency.value = v;
  else if (id === "delayTime" && delayNode) delayNode.delayTime.value = v;
  else if (id === "reverbMix" && dryGain && wetGain) {
    wetGain.gain.value = v;
    dryGain.gain.value = 1 - v;
  }
}

// ======================================================================
// WAVEFORM
// ======================================================================

function drawWaveform() {
  if (!analyser) return;
  animationId = requestAnimationFrame(drawWaveform);

  const w = waveformCanvas.width;
  const h = waveformCanvas.height;

  analyser.getByteTimeDomainData(dataArray);

  wfCtx.fillStyle = "#000";
  wfCtx.fillRect(0, 0, w, h);

  wfCtx.lineWidth = 2;
  wfCtx.strokeStyle = "#38bdf8";
  wfCtx.beginPath();

  const slice = w / dataArray.length;
  let x = 0;

  for (let i = 0; i < dataArray.length; i++) {
    const v = dataArray[i] / 128.0; // Normalize between 0 and 2 to adapt to canvas height (dataArray elements can have values between 0 and 255)
    const y = v * h / 2;
    if (i === 0) wfCtx.moveTo(x, y);
    else wfCtx.lineTo(x, y);
    x += slice;
  }

  wfCtx.lineTo(w, h / 2);
  wfCtx.stroke();
}

// Stop waveform animation before leaving the page
window.addEventListener("beforeunload", () => {
  if (animationId) cancelAnimationFrame(animationId);
});

// ======================================================================
// MIC RECORDING
// ======================================================================

btnStartRec.addEventListener("click", async () => { // async in order to be able to use await inside it
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); // Mic authorization
    mediaRecorder = new MediaRecorder(stream);
    recordedChunks = [];

    mediaRecorder.ondataavailable = e => {
      if (e.data.size) recordedChunks.push(e.data);
    };

    mediaRecorder.start();
    recStartTime = performance.now();

    // To update and show the recording timer
    if (recTimerId) clearInterval(recTimerId);
    recTimerId = setInterval(() => {
    const elapsed = (performance.now() - recStartTime) / 1000;
    statusEl.textContent = `Recording... ${elapsed.toFixed(1)}s`;
    }, 100);

    btnStartRec.disabled = true;
    btnStopRec.disabled = false;
    statusEl.textContent = "Recording...";
  } catch (e) {
    console.error(e);
    statusEl.textContent = "Error";
  }
});

btnStopRec.addEventListener("click", () => {
  mediaRecorder.onstop = () => {
    audioBlob = new Blob(recordedChunks, { type: "audio/webm" });
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(audioBlob);
    player.src = audioUrl;

    btnPlayProcessed.disabled = false;
    btnDownloadWav.disabled = false;
    btnDownloadProcessedWav.disabled = false;
    statusEl.textContent = "The recording is ready";

    refreshDriveButtons();
  };

  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(t => t.stop()); // Disconnect the mic
  }
  if (recTimerId) {
    clearInterval(recTimerId);
    recTimerId = null;
  }

  btnStartRec.disabled = false;
  btnStopRec.disabled = true;
});

// ======================================================================
// PLAYER EVENTS
// ======================================================================

player.addEventListener("play", () => {
  initAudioGraph();
  connectPlayerToAnalyser();
  if (!animationId) drawWaveform();

  if (activeProcessedSource) {
    try {
      activeProcessedSource.stop();
    } catch (e) {}
    activeProcessedSource = null;
  }

  btnPlayProcessed.disabled = false;
});

player.addEventListener("ended", () => {
  if (animationId) {
    cancelAnimationFrame(animationId);
    animationId = null;
  }
});

// ======================================================================
// DOWNLOAD RAW WAV
// ======================================================================

btnDownloadWav.addEventListener("click", () => {
  downloadWav({getBlobFn: getRawWavBlob, prefix: "Aurora_"});
});

async function downloadWav({getBlobFn, prefix}) {
  if (!audioBlob) return;

  try {
    const filename = safeTimestampName("wav", prefix);
    const wavBlob = await getBlobFn();
    downloadBlob(wavBlob, filename);
    statusEl.textContent = `Downloaded - ${filename}`;
  } catch (e) {
    console.error(e);
    statusEl.textContent = "Error while exporting the file";
  }
}

// To generate the file name with a timestamp
function safeTimestampName(ext, prefix) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `${prefix}${stamp}.${ext}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.style.display = "none";
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  URL.revokeObjectURL(url);
  document.body.removeChild(a);
}


async function getRawWavBlob() {
  if (!audioBlob) throw new Error("No recording available");
  initAudioGraph();
  const arrayBuffer = await audioBlob.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  const wavBuffer = audioBufferToWav(audioBuffer);
  return new Blob([wavBuffer], { type: "audio/wav" });
}

// ======================================================================
// PLAYBACK WITH EFFECTS
// ======================================================================

btnPlayProcessed.addEventListener("click", async () => {
  if (!audioBlob) return;
  initAudioGraph();

  // Stop HTML player if it is playing
  if (!player.paused) {
    player.pause();
    player.currentTime = 0;
  }

  if (activeProcessedSource) {
    try {
      activeProcessedSource.stop();
    } catch (e) {}
    activeProcessedSource = null;
  }

  const arrayBuffer = await audioBlob.arrayBuffer();
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.playbackRate.value = paramValues.pitch;
  source.connect(lowpassFilter);

  activeProcessedSource = source;
  btnPlayProcessed.disabled = true;

  source.onended = () => {
    if (activeProcessedSource === source) {
      activeProcessedSource = null;
    }
    btnPlayProcessed.disabled = false;
  };

  source.start();
  if (!animationId) drawWaveform();
});

// ======================================================================
// DOWNLOAD WAV WITH EFFECTS
// ======================================================================

btnDownloadProcessedWav.addEventListener("click", () => {
  downloadWav({getBlobFn: getProcessedWavBlob, prefix: "Aurora_fx_"});
});

async function getProcessedWavBlob() {
  if (!audioBlob) throw new Error("No recording available");

  const arr = await audioBlob.arrayBuffer();
  const probeCtx = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await probeCtx.decodeAudioData(arr);
  const duration = decoded.duration;
  const sampleRate = decoded.sampleRate;
  probeCtx.close();

  const length = Math.ceil(duration * sampleRate);
  const offlineCtx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, length, sampleRate);

  const source = offlineCtx.createBufferSource();
  source.buffer = decoded;

  const lp = offlineCtx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = paramValues.lowpass;

  const hp = offlineCtx.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = paramValues.highpass;

  const del = offlineCtx.createDelay(5.0);
  del.delayTime.value = paramValues.delayTime;

  const fb = offlineCtx.createGain();
  fb.gain.value = 0.3;
  del.connect(fb);
  fb.connect(del);

  const conv = offlineCtx.createConvolver();
  conv.buffer = createReverbImpulse(offlineCtx, 2.5, 2.0);

  const dry = offlineCtx.createGain();
  const wet = offlineCtx.createGain();
  const master = offlineCtx.createGain();

  master.gain.value = paramValues.gain;
  const mix = paramValues.reverbMix;
  dry.gain.value = 1 - mix;
  wet.gain.value = mix;

  source.playbackRate.value = paramValues.pitch;

  source.connect(lp);
  lp.connect(hp);
  hp.connect(del);
  del.connect(dry);
  del.connect(conv);
  conv.connect(wet);
  dry.connect(master);
  wet.connect(master);
  master.connect(offlineCtx.destination);

  source.start(0);
  const rendered = await offlineCtx.startRendering();
  const wavBuffer = audioBufferToWav(rendered);
  return new Blob([wavBuffer], { type: "audio/wav" });
}

// ======================================================================
// GOOGLE DRIVE AUTHORIZATION
// ======================================================================

function initDriveAuth() {
  if (!btnAuthDrive || !window.google || !google.accounts || !google.accounts.oauth2) { // To verify the existence of the element imported by Google src in the HTML
    return;
  }
  if (tokenClient) return;

  // To notify just in case the client ID must be changed or set
  if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.includes("PASTE_YOUR_CLIENT_ID_HERE")) {
    setDriveStatus("Drive: insert GOOGLE_CLIENT_ID in script.js");
    btnAuthDrive.disabled = true;
    return;
  }

  btnAuthDrive.addEventListener("click", () => {
    setDriveStatus("Drive: authorization in progress...");
    tokenClient.requestAccessToken({ prompt: "consent" }); // This function generates the Google consent pop-up
  });

  tokenClient = google.accounts.oauth2.initTokenClient({client_id: GOOGLE_CLIENT_ID, scope: DRIVE_SCOPES,
    callback: (resp) => { // This function is called when requestAccessToken completes and passes the value of resp
      driveAccessToken = resp.access_token;
      driveFolderIdCache = null; // To force the token to be requested again next time (every time you initialize the web app you have to get Google Drive authorization)
      setDriveStatus("Drive: authorized");
      refreshDriveButtons();
    },
  });

}

// To initialize Google Drive authorization immediately after the page is fully loaded
window.addEventListener("load", () => {
  initDriveAuth();
  // To let the initialization retry in case of failure (due to the async loading)
  let tries = 0;
  const t = setInterval(() => {
    initDriveAuth();
    tries++;
    if (tokenClient || tries > 40) clearInterval(t);
  }, 250);
});

function setDriveStatus(msg) {
  if (driveStatusEl) driveStatusEl.textContent = msg;
}

function refreshDriveButtons() {
  const ok = canUploadNow();
  if (btnUploadWav) btnUploadWav.disabled = !ok;
  if (btnUploadProcessedWav) btnUploadProcessedWav.disabled = !ok;
}

function canUploadNow() {
  return !!driveAccessToken && !!audioBlob; // Double negation to convert the element in the equivalent boolean value
}

// ======================================================================
// GOOGLE DRIVE UPLOAD
// ======================================================================

if (btnUploadWav) {
  btnUploadWav.addEventListener("click", async () => {
    try {
      setDriveStatus("Drive: upload in progress...");
      const folderId = await getOrCreateAuroraFolderId();
      const wavBlob = await getRawWavBlob();
      const filename = safeTimestampName("wav", "Aurora_");
      setDriveStatus("Drive: loading WAV...");
      const fileId = await uploadBlobToDriveResumable(wavBlob, filename, "audio/wav", folderId);
      setDriveStatus(`Drive: uploaded - ${filename}`);
      console.log("Drive fileId (mic):", fileId);
    } catch (e) {
      console.error(e);
      setDriveStatus("Drive: upload failed");
    }
  });
}

if (btnUploadProcessedWav) {
  btnUploadProcessedWav.addEventListener("click", async () => {
    try {
      setDriveStatus("Drive: upload in progress...");
      const folderId = await getOrCreateAuroraFolderId();
      const wavBlob = await getProcessedWavBlob();
      const filename = safeTimestampName("wav", "Aurora_fx_");
      setDriveStatus("Drive: loading WAV with effects...");
      const fileId = await uploadBlobToDriveResumable(wavBlob, filename, "audio/wav", folderId);
      setDriveStatus(`Drive: uploaded - ${filename}`);
      console.log("Drive fileId (fx):", fileId);
    } catch (e) {
      console.error(e);
      setDriveStatus("Drive: upload failed");
    }
  });
}

async function uploadBlobToDriveResumable(blob, filename, mimeType, folderId) {
  const metadata = {
    name: filename,
    parents: [folderId],
  };

  const start = await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": mimeType,
      "X-Upload-Content-Length": String(blob.size),
    },
    body: JSON.stringify(metadata),
  });

  if (!start.ok) throw new Error(await start.text());
  const uploadUrl = start.headers.get("Location");
  if (!uploadUrl) throw new Error("Missing upload URL");

  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": mimeType,
      "Content-Length": String(blob.size),
    },
    body: blob,
  });

  if (!put.ok) throw new Error(await put.text());
  const data = await put.json();
  return data.id;
}

// To create the Drive folder or get it if it already exists
async function getOrCreateAuroraFolderId() {
  if (driveFolderIdCache) return driveFolderIdCache;

  const q = `name='${DRIVE_FOLDER_NAME.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const listUrl = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)`;

  const r = await driveFetch(listUrl);
  if (!r.ok) throw new Error(await r.text());
  const data = await r.json();
  if (data.files && data.files.length) {
    driveFolderIdCache = data.files[0].id;
    return driveFolderIdCache;
  }

  const createUrl = "https://www.googleapis.com/drive/v3/files";
  const body = {
    name: DRIVE_FOLDER_NAME,
    mimeType: "application/vnd.google-apps.folder",
  };
  const c = await driveFetch(createUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!c.ok) throw new Error(await c.text());
  const created = await c.json();
  driveFolderIdCache = created.id;
  return driveFolderIdCache;
}

async function driveFetch(url, options = {}) {
  if (!driveAccessToken) throw new Error("Drive not authorized");
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${driveAccessToken}`);
  return fetch(url, { ...options, headers });
}