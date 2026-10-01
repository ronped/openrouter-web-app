const $ = (selector) => document.querySelector(selector);
const form = $("#generator");
const jobsEl = $("#jobs");
const key = "seedance-studio-jobs";
const formSettingsKey = "seedance-studio-form-settings";
let jobs = JSON.parse(localStorage.getItem(key) || "[]");
let knownModels = [];
let preferredModel;
let referenceSources = [];
let referenceProcessing = Promise.resolve();
let frameAssets = { first_frame: null, last_frame: null };
let frameProcessing = { first_frame: Promise.resolve(), last_frame: Promise.resolve() };
let sourceVideo = null;
let driveState = { configured: false, connected: false };

function save() { localStorage.setItem(key, JSON.stringify(jobs)); }
const rememberedFields = ["provider", "generation_type", "model", "duration", "aspect_ratio", "resolution", "size", "image_aspect_ratio", "image_resolution", "image_count", "generate_audio", "seed", "return_last_frame", "camera_fixed", "omni_reference_task_type", "output_format"];
function saveFormSettings() {
  const settings = {};
  rememberedFields.forEach((name) => {
    const field = form.elements.namedItem(name);
    if (!field) return;
    settings[name] = field.type === "checkbox" ? field.checked : field.value;
  });
  localStorage.setItem(formSettingsKey, JSON.stringify(settings));
}
function restoreFormSettings() {
  let settings;
  try { settings = JSON.parse(localStorage.getItem(formSettingsKey) || "{}"); } catch { settings = {}; }
  rememberedFields.forEach((name) => {
    if (!(name in settings) || name === "model") return;
    const field = form.elements.namedItem(name);
    if (field) field.type === "checkbox" ? field.checked = Boolean(settings[name]) : field.value = settings[name];
  });
  preferredModel = settings.model;
}
function error(message = "") { $("#form-error").textContent = message; }
function jobId(job) { return job.id || job.generation_id; }

function outputUrls(job) {
  return job.video_urls || job.output_urls || job.unsigned_urls || job.output?.videos || [];
}

function contentUrl(job, index = 0) {
  // Image responses already contain their result URL (or a data URL). Only
  // OpenRouter video jobs have a retrievable `/content` resource by job ID.
  if (job.kind === "image" || job.provider === "modelark") return null;
  const id = jobId(job);
  return id ? `/api/videos/${encodeURIComponent(id)}/content?index=${index}` : null;
}

function jobKey(job, index) { return jobId(job) || `${job.model}-${job.prompt}-${index}`; }

function costText(job) {
  const cost = job.usage?.cost;
  if (typeof cost !== "number") return "Cost pending";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: cost < 0.01 ? 4 : 2, maximumFractionDigits: cost < 0.01 ? 4 : 2 }).format(cost);
}

function renderState(job) {
  return JSON.stringify({ status: job.status, model: job.model, prompt: job.prompt, urls: outputUrls(job), error: job.error?.message || job.error, cost: job.usage?.cost });
}

function createJobNode(job) {
  const node = $("#job-template").content.cloneNode(true);
  const article = node.querySelector(".job");
  const status = job.status || "submitted";
  article.dataset.renderState = renderState(job);
  node.querySelector(".status").textContent = status;
  node.querySelector(".status").classList.add(`status-${status}`);
  node.querySelector(".job-model").textContent = job.model;
  node.querySelector(".job-cost").textContent = costText(job);
  node.querySelector(".job-prompt").textContent = job.prompt;
  const output = node.querySelector(".output");
  const urls = outputUrls(job);
  if (urls.length || status === "completed") {
    const count = Math.max(1, urls.length);
    for (let index = 0; index < count; index += 1) {
      const item = urls[index];
      const url = contentUrl(job, index) || (typeof item === "string" ? item : item?.url);
      if (!url) continue;
      if (job.kind === "image") {
        const image = document.createElement("img"); image.src = url; image.alt = job.prompt; image.className = "generated-image"; image.addEventListener("click", () => openImage(url, job.prompt)); output.append(image);
      } else {
        const video = document.createElement("video"); video.src = url; video.controls = true; video.preload = "metadata";
        output.append(video);
      }
      const download = document.createElement("a");
      const imageExtension = ({ "image/jpeg": ".jpg", "image/webp": ".webp", "image/svg+xml": ".svg" })[item?.media_type] || ".png";
      download.href = url; download.download = `seedance-${jobId(job) || job.kind || "output"}-${index + 1}${job.kind === "image" ? imageExtension : ".mp4"}`;
      download.textContent = `Download ${job.kind === "image" ? "image" : "clip"} ${index + 1}`; download.className = "download";
      output.append(download);
    }
    if (job.last_frame_url) {
      const lastFrame = document.createElement("a"); lastFrame.href = job.last_frame_url; lastFrame.className = "download"; lastFrame.textContent = "Download returned last frame (JPEG)"; lastFrame.download = `seedance-${jobId(job) || "video"}-last-frame.jpg`;
      output.append(lastFrame);
    }
  } else if (job.error) {
    output.textContent = job.error.message || job.error;
    output.className = "output failed";
  } else {
    output.textContent = "Working on it…";
  }
  return article;
}

function render() {
  if (!jobs.length) {
    jobsEl.innerHTML = '<p class="empty">Your completed clips will appear here.</p>';
    return;
  }
  const existing = new Map([...jobsEl.querySelectorAll(".job")].map((node) => [node.dataset.jobKey, node]));
  const next = document.createDocumentFragment();
  jobs.forEach((job, index) => {
    const key = jobKey(job, index);
    const state = renderState(job);
    const prior = existing.get(key);
    const article = prior?.dataset.renderState === state ? prior : createJobNode(job);
    article.dataset.jobKey = key;
    next.append(article);
  });
  jobsEl.replaceChildren(next);
}

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

async function refreshDriveStatus() {
  const status = $("#drive-status");
  const connect = $("#connect-drive");
  const disconnect = $("#disconnect-drive");
  try {
    driveState = await api("/api/google/status");
    if (!driveState.configured) {
      status.textContent = `Google Drive scratch upload is not configured. Missing: ${(driveState.missing || []).join(" and ") || "Google OAuth settings"}.`;
      connect.hidden = true;
      disconnect.hidden = true;
    } else if (driveState.connected) {
      status.textContent = "Google Drive connected and remembered on this computer. A selected local source clip will be uploaded when you generate.";
      connect.hidden = true;
      disconnect.hidden = false;
    } else {
      status.textContent = "Connect Google Drive to upload a selected local source clip as a scratch file.";
      connect.hidden = false;
      disconnect.hidden = true;
    }
  } catch (e) { status.textContent = `Google Drive status is unavailable: ${e.message}`; connect.hidden = true; disconnect.hidden = true; }
}

async function uploadSourceVideo(file) {
  const response = await fetch(`/api/drive/upload?filename=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "content-type": file.type || "video/mp4" }, body: file });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Could not upload the source video to Google Drive.");
  return payload;
}

function extensionTrimRange() {
  if (!sourceVideo?.duration) throw new Error("Select a local source video before trimming.");
  const start = Number($("#trim-start").value);
  const visualEnd = Number($("#trim-end").value);
  // The last displayed frame starts slightly before the container's duration.
  // Selecting that final frame means "through the end of the clip", not
  // "stop at the start of that frame".
  const end = visualEnd >= sourceVideo.trimMaximum - 0.000_001 ? sourceVideo.sourceDuration : visualEnd;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start < 2 || end - start > 15) throw new Error("Select a 2–15 second range for the extension.");
  return { start, end, visualEnd };
}

async function trimmedSourceVideo() {
  const { start, end } = extensionTrimRange();
  if (start <= 0.000_001 && end >= sourceVideo.sourceDuration - 0.000_001) {
    $("#trim-status").textContent = "Full clip selected; using the original file without re-encoding.";
    return sourceVideo.file;
  }
  if (sourceVideo.trimmedFile && sourceVideo.trimmedStart === start && sourceVideo.trimmedEnd === end) return sourceVideo.trimmedFile;
  const response = await fetch(`/api/video-trim?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&filename=${encodeURIComponent(sourceVideo.file.name)}`, {
    method: "POST", headers: { "content-type": sourceVideo.file.type || "video/mp4" }, body: sourceVideo.file
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Could not trim the source video.");
  }
  const blob = await response.blob();
  const extension = sourceVideo.file.name.includes(".") ? sourceVideo.file.name.slice(sourceVideo.file.name.lastIndexOf(".")) : ".mp4";
  const base = sourceVideo.file.name.slice(0, -extension.length) || "source-video";
  sourceVideo.trimmedStart = start;
  sourceVideo.trimmedEnd = end;
  sourceVideo.trimmedFile = new File([blob], `${base}-${start.toFixed(2)}-${end.toFixed(2)}s${extension}`, { type: blob.type || sourceVideo.file.type || "video/mp4" });
  const outputDuration = Number(response.headers.get("x-trimmed-duration"));
  const durationText = Number.isFinite(outputDuration) ? `${outputDuration.toFixed(2)}s` : "trimmed copy";
  $("#trim-status").textContent = `Selected ${start.toFixed(2)}–${end.toFixed(2)}s; created ${durationText} with lossless video re-encoding.`;
  renderSourceVideo();
  return sourceVideo.trimmedFile;
}

async function downloadTrimmedSourceVideo() {
  const button = $("#download-trim");
  try {
    button.disabled = true; button.textContent = "Trimming…";
    const file = await trimmedSourceVideo();
    const link = document.createElement("a");
    const url = URL.createObjectURL(file);
    link.href = url; link.download = file.name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  } catch (e) { error(e.message); }
  finally { button.disabled = false; button.textContent = "Download trimmed video"; }
}

async function prepareLocalVideoPreview(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.preload = "auto";
  video.src = url;
  try {
    await waitForVideo(video, "loadedmetadata");
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error(`Could not read the duration of ${file.name}.`);
    return { video, url, duration: video.duration };
  } catch (error) {
    video.removeAttribute("src"); video.load(); URL.revokeObjectURL(url);
    throw error;
  }
}

async function inspectLocalVideo(file) {
  const response = await fetch(`/api/video-info?filename=${encodeURIComponent(file.name)}`, {
    method: "POST", headers: { "content-type": file.type || "video/mp4" }, body: file
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Could not inspect the source video.");
  return payload;
}

function disposeSourceVideoPreview() {
  const video = sourceVideo?.previewVideo;
  if (!video) return;
  video.removeAttribute("src"); video.load(); URL.revokeObjectURL(sourceVideo.previewUrl);
}

function quantizeTrimTime(value) {
  const frameRate = sourceVideo?.frameRate;
  if (!Number.isFinite(frameRate) || frameRate <= 0) return value;
  return Math.round(value * frameRate) / frameRate;
}

function floorTrimTime(value) {
  const frameRate = sourceVideo?.frameRate;
  return Number.isFinite(frameRate) && frameRate > 0 ? Math.floor((value * frameRate) + 0.000_001) / frameRate : value;
}

function ceilTrimTime(value) {
  const frameRate = sourceVideo?.frameRate;
  return Number.isFinite(frameRate) && frameRate > 0 ? Math.ceil((value * frameRate) - 0.000_001) / frameRate : value;
}

function trimEndForVisualTime(visualEnd) {
  return visualEnd >= sourceVideo.trimMaximum - 0.000_001 ? sourceVideo.sourceDuration : visualEnd;
}

async function trimPreviewFrame(time) {
  const video = sourceVideo.previewVideo;
  const target = Math.min(Math.max(0, time), Math.max(0, sourceVideo.duration - 0.001));
  if (Math.abs(video.currentTime - target) > 0.001) {
    const seeking = waitForVideo(video, "seeked");
    video.currentTime = target;
    await seeking;
  }
  // Some browsers decode a paused seek but never dispatch a video-frame
  // callback afterwards.  The seeked event above is enough to draw its frame;
  // use that value after a short grace period so previews cannot stay stuck.
  const actualTime = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true; window.clearTimeout(fallback); resolve(value);
    };
    const fallback = window.setTimeout(() => finish(video.currentTime), 250);
    if (typeof video.requestVideoFrameCallback === "function") video.requestVideoFrameCallback((_, metadata) => finish(metadata.mediaTime));
    else requestAnimationFrame(() => finish(video.currentTime));
  });
  const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale)); canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return { url: canvas.toDataURL("image/jpeg", 0.9), actualTime };
}

let trimPreviewVersion = 0;
let trimPreviewRunning = false;
function renderTrimPreviews() {
  trimPreviewVersion += 1;
  if (trimPreviewRunning) return;
  trimPreviewRunning = true;
  window.setTimeout(processTrimPreviewQueue, 45);
}

async function processTrimPreviewQueue() {
  const target = $("#trim-previews");
  try {
    while (sourceVideo?.duration) {
      const version = trimPreviewVersion;
      let range;
      try { range = extensionTrimRange(); } catch (e) { target.textContent = e.message; break; }
      // Keep the last useful pair of thumbnails on screen while the decoder
      // seeks to the new pair. This avoids a distracting blank state on every
      // slider movement.
      target.setAttribute("aria-busy", "true");
      const start = await trimPreviewFrame(range.start);
      if (version !== trimPreviewVersion) continue;
      const end = await trimPreviewFrame(range.end);
      if (version !== trimPreviewVersion) continue;
      target.replaceChildren();
      [[start, `Trim start · requested ${range.start.toFixed(2)}s · frame ${start.actualTime.toFixed(3)}s`], [end, `Trim end · requested ${range.end.toFixed(2)}s · frame ${end.actualTime.toFixed(3)}s`]].forEach(([frame, label]) => {
      const card = document.createElement("div"); card.className = "preview-card";
      const image = document.createElement("img"); image.src = frame.url; image.alt = label; image.title = "Click to enlarge";
      image.addEventListener("click", () => openImage(frame.url, label));
      const text = document.createElement("span"); text.className = "preview-dimensions"; text.textContent = label;
      card.append(image, text); target.append(card);
      });
      target.removeAttribute("aria-busy");
      break;
    }
  } catch (error) { target.removeAttribute("aria-busy"); target.textContent = error.message; }
  finally { target.removeAttribute("aria-busy"); trimPreviewRunning = false; }
}

function syncTrimRange(changed) {
  if (!sourceVideo?.duration) return;
  const startControl = $("#trim-start");
  const endControl = $("#trim-end");
  const maximum = sourceVideo.trimMaximum ?? sourceVideo.duration;
  let start = quantizeTrimTime(Number(startControl.value));
  let end = quantizeTrimTime(Number(endControl.value));
  if (changed === "start") {
    const trimEnd = trimEndForVisualTime(end);
    start = Math.min(start, floorTrimTime(trimEnd - 2));
    if (trimEnd - start > 15) start = ceilTrimTime(trimEnd - 15);
  } else {
    end = Math.max(end, ceilTrimTime(start + 2));
    if (trimEndForVisualTime(end) - start > 15) end = floorTrimTime(start + 15);
  }
  start = Math.max(0, quantizeTrimTime(start));
  end = Math.min(maximum, quantizeTrimTime(end));
  if (trimEndForVisualTime(end) - start < 2) {
    if (changed === "start" || end >= maximum - 0.000_001) start = Math.max(0, floorTrimTime(trimEndForVisualTime(end) - 2));
    else end = Math.min(maximum, ceilTrimTime(start + 2));
  }
  startControl.value = String(start); endControl.value = String(end);
  const span = Math.max(0.000_001, maximum);
  $("#trim-range").style.setProperty("--trim-start", `${(start / span) * 100}%`);
  $("#trim-range").style.setProperty("--trim-end", `${(end / span) * 100}%`);
  $("#trim-start-value").value = `${start.toFixed(3)}s`;
  $("#trim-end-value").value = `${end.toFixed(3)}s`;
  delete sourceVideo.trimmedFile; delete sourceVideo.trimmedStart; delete sourceVideo.trimmedEnd;
  $("#trim-status").textContent = "";
  renderTrimPreviews();
}

async function initializeTrimControls(file) {
  const preview = await prepareLocalVideoPreview(file);
  try {
    const info = await inspectLocalVideo(file);
    if (!sourceVideo || sourceVideo.file !== file) {
      preview.video.removeAttribute("src"); preview.video.load(); URL.revokeObjectURL(preview.url);
      return;
    }
    const frameRate = Number(info.frameRate);
    const sourceDuration = Number(info.duration);
    const duration = Math.min(preview.duration, sourceDuration);
    if (!Number.isFinite(frameRate) || frameRate <= 0) throw new Error("Could not determine the source-video frame rate.");
    if (!Number.isFinite(duration) || duration < 2) throw new Error("The source video must be at least two seconds long to extend.");
    // This is the timestamp of the final displayable frame. Keep it below the
    // exact container duration so setting a native range input cannot round
    // past its maximum; the full-duration endpoint is restored when submitted.
    const trimMaximum = Math.floor((duration - 0.000_001) * frameRate) / frameRate;
    sourceVideo.duration = duration;
    sourceVideo.sourceDuration = sourceDuration;
    sourceVideo.trimMaximum = trimMaximum;
    sourceVideo.frameRate = frameRate;
    sourceVideo.previewVideo = preview.video;
    sourceVideo.previewUrl = preview.url;
    const end = trimMaximum;
    const start = quantizeTrimTime(Math.max(0, end - 15));
    [$("#trim-start"), $("#trim-end")].forEach((control) => {
      control.min = "0"; control.max = String(trimMaximum); control.step = String(1 / frameRate);
    });
    $("#trim-start").value = String(start); $("#trim-end").value = String(end);
    $("#extension-trim").hidden = false;
    syncTrimRange("end");
  } catch (error) {
    preview.video.removeAttribute("src"); preview.video.load(); URL.revokeObjectURL(preview.url);
    throw error;
  }
}

async function imageDataUrl(file) {
  if (!file.type.startsWith("image/")) throw new Error(`${file.name} is not an image.`);
  if (file.size > 8_000_000) throw new Error(`${file.name} is over the 8 MB per-image limit.`);
  const source = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
  const image = await new Promise((resolve, reject) => {
    const element = new Image(); element.onload = () => resolve(element); element.onerror = () => reject(new Error(`Could not decode ${file.name}.`)); element.src = source;
  });
  const largestSide = Math.max(image.naturalWidth, image.naturalHeight);
  if (largestSide <= 1920 && file.size <= 2_000_000) return source;
  const scale = Math.min(1, 1920 / largestSide);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

const imageDimensionPresets = {
  "1K": { "1:1": [1024, 1024], "4:3": [1152, 864], "3:4": [864, 1152], "3:2": [1248, 832], "2:3": [832, 1248], "16:9": [1424, 800], "9:16": [800, 1424], "21:9": [1568, 672] },
  "2K": { "1:1": [2048, 2048], "4:3": [2304, 1728], "3:4": [1728, 2304], "3:2": [2496, 1664], "2:3": [1664, 2496], "16:9": [2848, 1600], "9:16": [1600, 2848], "21:9": [3136, 1344] },
  "3K": { "1:1": [3072, 3072], "4:3": [3456, 2592], "3:4": [2592, 3456], "3:2": [3744, 2496], "2:3": [2496, 3744], "16:9": [4096, 2304], "9:16": [2304, 4096], "21:9": [4704, 2016] },
  "4K": { "1:1": [4096, 4096], "4:3": [4704, 3520], "3:4": [3520, 4704], "3:2": [4992, 3328], "2:3": [3328, 4992], "16:9": [5504, 3040], "9:16": [3040, 5504], "21:9": [6240, 2656] }
};

function imageOutputDimensions() {
  const resolution = $("[name=image_resolution]").value;
  const ratio = $("[name=image_aspect_ratio]").value;
  const preset = imageDimensionPresets[resolution]?.[ratio];
  if (preset) return preset;
  const base = ({ "512": 512, "1K": 1024, "2K": 2048, "3K": 3072, "4K": 4096 })[resolution] || 2048;
  const [widthRatio, heightRatio] = ratio.split(":").map(Number);
  const height = Math.round(base / Math.sqrt(widthRatio / heightRatio));
  return [Math.ceil(height * widthRatio / heightRatio), height];
}

function outputDimensions() {
  if ($("#generation-type").value === "image") return imageOutputDimensions();
  const size = $("#size").value;
  if (size) return size.split("x").map(Number);
  const resolution = $("[name=resolution]").value;
  const aspect = $("[name=aspect_ratio]").value.split(":").map(Number);
  const height = Number(resolution.replace("p", ""));
  const width = Math.ceil(height * aspect[0] / aspect[1]);
  return [width, height];
}

async function cropAndResizeDataUrl(url, [targetWidth, targetHeight]) {
  if (!url.startsWith("data:image/")) return url;
  const image = await new Promise((resolve, reject) => { const element = new Image(); element.onload = () => resolve(element); element.onerror = () => reject(new Error("Could not decode an image for resizing.")); element.src = url; });
  const targetRatio = targetWidth / targetHeight;
  const sourceRatio = image.naturalWidth / image.naturalHeight;
  let sx = 0; let sy = 0; let sw = image.naturalWidth; let sh = image.naturalHeight;
  if (sourceRatio > targetRatio) { sw = Math.round(sh * targetRatio); sx = Math.round((image.naturalWidth - sw) / 2); }
  else if (sourceRatio < targetRatio) { sh = Math.round(sw / targetRatio); sy = Math.round((image.naturalHeight - sh) / 2); }
  const canvas = document.createElement("canvas"); canvas.width = targetWidth; canvas.height = targetHeight;
  const context = canvas.getContext("2d");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
  return canvas.toDataURL("image/png");
}

function waitForVideo(video, event) {
  return new Promise((resolve, reject) => {
    video.addEventListener(event, resolve, { once: true });
    video.addEventListener("error", () => reject(new Error("Could not decode this video.")), { once: true });
  });
}

async function videoStillDataUrls(file, positions) {
  if (!file.type.startsWith("video/")) throw new Error(`${file.name} is not a video.`);
  if (file.size > 100_000_000) throw new Error(`${file.name} is over the 100 MB video limit.`);
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true; video.playsInline = true; video.preload = "metadata"; video.src = objectUrl;
  try {
    await waitForVideo(video, "loadedmetadata");
    if (!Number.isFinite(video.duration) || !video.videoWidth || !video.videoHeight) throw new Error(`Could not read ${file.name}.`);
    const largestSide = Math.max(video.videoWidth, video.videoHeight);
    const scale = Math.min(1, 1280 / largestSide);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    const frames = [];
    for (const position of positions) {
      const time = Math.min(Math.max(0.03, video.duration * position), Math.max(0.03, video.duration - 0.03));
      if (Math.abs(video.currentTime - time) > 0.01) {
        const seeking = waitForVideo(video, "seeked");
        video.currentTime = time;
        await seeking;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      // PNG avoids introducing a second lossy compression step after decoding
      // the source video frame.
      frames.push(canvas.toDataURL("image/png"));
    }
    return frames;
  } finally {
    video.removeAttribute("src"); video.load(); URL.revokeObjectURL(objectUrl);
  }
}

async function visualReferenceDataUrls(file) {
  if (file.type.startsWith("image/")) return [await imageDataUrl(file)];
  if (file.type.startsWith("video/")) return videoStillDataUrls(file, [0.15, 0.5, 0.85]);
  throw new Error(`${file.name} is not an image or video.`);
}

async function exactVideoFrameDataUrl(file, position) {
  if (file.size > 100_000_000) throw new Error(`${file.name} is over the 100 MB video limit.`);
  const response = await fetch(`/api/video-frame?position=${position}&filename=${encodeURIComponent(file.name)}`, {
    method: "POST", headers: { "content-type": file.type || "video/mp4" }, body: file
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Could not extract the video frame with FFmpeg.");
  }
  const image = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the extracted JPEG frame."));
    reader.readAsDataURL(image);
  });
}

async function frameDataUrl(file, frameType) {
  if (file.type.startsWith("image/")) return imageDataUrl(file);
  // For extension workflows, the end of the source clip is the next clip's
  // first frame, and the source clip's start is its last-frame counterpart.
  if (file.type.startsWith("video/")) return exactVideoFrameDataUrl(file, frameType === "first_frame" ? "last" : "first");
  throw new Error(`${file.name} is not an image or video.`);
}

function openImage(url, label) {
  $("#modal-image").src = url;
  $("#modal-image").alt = label;
  $("#image-modal").showModal();
}

function insertPromptTag(tag) {
  const prompt = $("#prompt");
  const start = prompt.selectionStart ?? prompt.value.length;
  const end = prompt.selectionEnd ?? prompt.value.length;
  const prefix = start && !/\s$/.test(prompt.value.slice(0, start)) ? " " : "";
  const suffix = end < prompt.value.length && !/^\s/.test(prompt.value.slice(end)) ? " " : "";
  prompt.value = `${prompt.value.slice(0, start)}${prefix}${tag}${suffix}${prompt.value.slice(end)}`;
  const cursor = start + prefix.length + tag.length;
  prompt.focus(); prompt.setSelectionRange(cursor, cursor);
}

function previewCard(url, label, remove, tag = null, { scaleToOutput = false } = {}) {
  const card = document.createElement("div"); card.className = "preview-card";
  const image = document.createElement("img"); image.alt = label; image.title = "Click to enlarge";
  const dimensions = document.createElement("span"); dimensions.className = "preview-dimensions";
  const downloadScaled = document.createElement("button"); downloadScaled.type = "button"; downloadScaled.className = "download-scaled"; downloadScaled.hidden = true;
  image.addEventListener("load", () => {
    if (!scaleToOutput) {
      dimensions.textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
      return;
    }
    const [targetWidth, targetHeight] = outputDimensions();
    const mismatch = image.naturalWidth !== targetWidth || image.naturalHeight !== targetHeight;
    dimensions.textContent = mismatch ? `${image.naturalWidth} × ${image.naturalHeight} → ${targetWidth} × ${targetHeight}` : `${image.naturalWidth} × ${image.naturalHeight}`;
    downloadScaled.hidden = !mismatch || !url.startsWith("data:image/");
    downloadScaled.textContent = `Download ${targetWidth} × ${targetHeight}`;
  }, { once: true });
  image.addEventListener("error", () => { dimensions.textContent = "size unavailable"; }, { once: true });
  image.src = url;
  image.addEventListener("click", () => openImage(url, label));
  if (tag) {
    const tagButton = document.createElement("button");
    tagButton.type = "button"; tagButton.className = "reference-tag"; tagButton.textContent = tag; tagButton.title = `Insert ${tag} in the prompt`;
    tagButton.addEventListener("click", () => insertPromptTag(tag));
    card.append(tagButton);
  }
  const removeButton = document.createElement("button");
  removeButton.type = "button"; removeButton.className = "remove-preview"; removeButton.setAttribute("aria-label", `Remove ${label}`); removeButton.textContent = "×";
  removeButton.addEventListener("click", remove);
  downloadScaled.addEventListener("click", async () => {
    try {
      downloadScaled.disabled = true; downloadScaled.textContent = "Preparing…";
      const scaled = await cropAndResizeDataUrl(url, outputDimensions());
      const link = document.createElement("a"); link.href = scaled; link.download = `${label.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "image"}-scaled.png`; link.click();
    } catch (e) { error(e.message); }
    finally { downloadScaled.disabled = false; downloadScaled.textContent = `Download ${outputDimensions().join(" × ")}`; }
  });
  card.append(image, dimensions, downloadScaled, removeButton);
  return card;
}

function syncReferenceInput() {
  const transfer = new DataTransfer();
  referenceSources.forEach((source) => transfer.items.add(source.file));
  $("#reference-files").files = transfer.files;
}

function renderReferencePreviews() {
  const target = $("#reference-previews"); target.replaceChildren();
  let referenceNumber = 0;
  referenceSources.forEach((source) => source.urls.forEach((url, index) => {
    referenceNumber += 1;
    const suffix = source.urls.length > 1 ? ` — still ${index + 1}` : "";
    target.append(previewCard(url, `${source.file.name}${suffix}`, () => {
      source.urls.splice(index, 1);
      if (!source.urls.length) referenceSources = referenceSources.filter((item) => item !== source);
      syncReferenceInput(); renderReferencePreviews();
    }, `@Image${referenceNumber}`));
  }));
}

function renderFramePreviews() {
  const target = $("#frame-previews"); target.replaceChildren();
  [["first_frame", "First frame"], ["last_frame", "Last frame"]].forEach(([type, label]) => {
    const asset = frameAssets[type];
    if (!asset) return;
    target.append(previewCard(asset.url, label, () => {
      frameAssets[type] = null;
      $(type === "first_frame" ? "#first-frame-file" : "#last-frame-file").value = "";
      renderFramePreviews();
    }, null, { scaleToOutput: true }));
  });
}

function renderSourceVideo() {
  const target = $("#source-video-preview"); target.replaceChildren();
  if (!sourceVideo) return;
  const selectedRange = sourceVideo.trimmedFile ? ` · ${sourceVideo.trimmedStart.toFixed(2)}–${sourceVideo.trimmedEnd.toFixed(2)}s trimmed copy ready` : "";
  const label = document.createElement("span"); label.textContent = sourceVideo.driveUrl ? `@Video1 · ${sourceVideo.file.name} · Google Drive scratch link ready` : `@Video1 · ${sourceVideo.file.name}${selectedRange}`;
  const remove = document.createElement("button"); remove.type = "button"; remove.className = "quiet"; remove.textContent = "Remove";
  remove.addEventListener("click", () => { disposeSourceVideoPreview(); sourceVideo = null; $("#source-video-file").value = ""; $("#extension-trim").hidden = true; $("#trim-previews").replaceChildren(); renderSourceVideo(); syncExtensionTaskType(); });
  target.append(label, remove);
}

async function setSourceVideo(file) {
  if (file && !file.type.startsWith("video/")) return Promise.reject(new Error(`${file.name} is not a video.`));
  disposeSourceVideoPreview();
  sourceVideo = file ? { file } : null;
  $("#trim-status").textContent = "";
  $("#extension-trim").hidden = !file;
  if (file) await initializeTrimControls(file);
  renderSourceVideo(); syncExtensionTaskType();
}

function setReferenceSources(files) {
  const sources = [...files].map((file) => ({ file, urls: [] }));
  referenceSources = sources; renderReferencePreviews();
  const task = Promise.all(sources.map(async (source) => {
    source.urls = await visualReferenceDataUrls(source.file);
  }));
  referenceProcessing = task.then(() => {
    if (referenceSources === sources) renderReferencePreviews();
  });
  return referenceProcessing;
}

function setFrameAsset(type, file) {
  frameAssets[type] = null; renderFramePreviews();
  const task = file ? frameDataUrl(file, type).then((url) => { frameAssets[type] = { url, file }; }) : Promise.resolve();
  frameProcessing[type] = task.then(renderFramePreviews);
  return frameProcessing[type];
}

async function parseAssets() {
  await Promise.all([referenceProcessing, frameProcessing.first_frame, frameProcessing.last_frame]);
  const urlRefs = $("#references").value.split("\n").map((url) => url.trim()).filter(Boolean);
  const dimensions = outputDimensions();
  // Reference media is passed through at its original dimensions. Only the
  // first/last-frame controls require a render-sized image.
  const localRefs = referenceSources.flatMap((source) => source.urls);
  const refs = [...localRefs, ...urlRefs].map((url) => ({ type: "image_url", image_url: { url } }));
  const choices = [
    ["first_frame", frameAssets.first_frame?.url, $("#first-frame").value.trim()],
    ["last_frame", frameAssets.last_frame?.url, $("#last-frame").value.trim()]
  ];
  const frames = await Promise.all(choices.map(async ([frame_type, localUrl, url]) => {
    const value = localUrl || url;
    return value ? { type: "image_url", frame_type, image_url: { url: await cropAndResizeDataUrl(value, dimensions) } } : null;
  }));
  const totalLength = [...refs, ...frames.filter(Boolean)].reduce((sum, item) => sum + item.image_url.url.length, 0);
  if (totalLength > 12_000_000) throw new Error("The selected images are too large together. Use fewer or smaller images.");
  return { refs, frames: frames.filter(Boolean), extensionVideo: $("#source-video-url").value.trim(), sourceVideo };
}

async function refreshModels() {
  try {
    const provider = $("#provider").value;
    const type = $("#generation-type").value;
    const payload = await api(`/api/models?provider=${encodeURIComponent(provider)}&type=${encodeURIComponent(type)}`);
    knownModels = payload.data || payload.models || [];
    if (provider === "modelark") knownModels = knownModels.filter((model) => model.generation_type ? model.generation_type === type : (type === "image" ? /seedream/i.test(model.id) : /seedance/i.test(model.id)));
    const select = $("#model");
    const current = preferredModel || select.value;
    select.replaceChildren();
    knownModels.forEach((model) => {
      // The option value is the exact identifier sent to the provider. Showing it
      // prevents a friendly ModelArk activation name from obscuring the callable ID.
      const label = model.name && model.name !== model.id ? `${model.name} — ${model.id}` : model.id;
      select.add(new Option(label, model.id));
    });
    if (!knownModels.length) select.add(new Option(`No ${type} models returned`, ""));
    select.value = knownModels.some((m) => m.id === current) ? current : knownModels[0]?.id || "";
    preferredModel = undefined;
    syncImageOptions();
    $("#model-note").textContent = provider === "modelark"
      ? (payload.live ? "Models are live activated versions discovered from your BytePlus account." : (type === "image" ? "Seedream images are generated synchronously by ModelArk." : "Seedance video jobs run asynchronously in ModelArk."))
      : "Live availability is checked before you generate.";
  } catch (e) {
    $("#model-note").textContent = `Could not load the video catalog: ${e.message}`;
  }
}

function syncImageOptions() {
  if ($("#generation-type").value !== "image") return;
  const selected = knownModels.find((model) => model.id === $("#model").value);
  const advertised = selected?.supported_parameters?.resolution?.values;
  let modelArkResolutions = ["2K", "3K", "4K"];
  if (/seedream-5-0-pro/i.test(selected?.id || "")) modelArkResolutions = ["1K", "2K"];
  else if (/seedream-4-5/i.test(selected?.id || "")) modelArkResolutions = ["2K", "4K"];
  else if (/seedream-4-0/i.test(selected?.id || "")) modelArkResolutions = ["1K", "2K", "4K"];
  const resolutions = $("#provider").value === "modelark"
    ? modelArkResolutions
    : (Array.isArray(advertised) && advertised.length ? advertised : ["1K", "2K", "4K"]);
  const control = $("[name=image_resolution]");
  const prior = control.value;
  control.replaceChildren(...resolutions.map((value) => new Option(value, value)));
  control.value = resolutions.includes(prior) ? prior : (resolutions.includes("2K") ? "2K" : resolutions[0]);

  const countControl = $("[name=image_count]");
  const previousCount = Number(countControl.value);
  const openRouterMaximum = selected?.supported_parameters?.n?.max;
  const maximum = $("#provider").value === "modelark" ? 4 : (Number.isInteger(openRouterMaximum) ? Math.min(10, openRouterMaximum) : 1);
  countControl.replaceChildren(...Array.from({ length: maximum }, (_, index) => new Option(`${index + 1} image${index ? "s" : ""}`, index + 1)));
  countControl.value = String(Math.min(Math.max(previousCount || 1, 1), maximum));
  $("#image-count-note").textContent = maximum > 1
    ? ($("#provider").value === "modelark" ? "Seedream returns a related sequence." : "Each image is billed separately.")
    : "This selected model supports one image per request.";
}

function syncProviderUI() {
  const provider = $("#provider").value;
  const image = $("#generation-type").value === "image";
  $("#generation-type").disabled = false;
  $("#video-settings").hidden = image;
  $("#size").closest("label").hidden = image;
  $("#image-settings").hidden = !image;
  $("#modelark-options").hidden = provider !== "modelark" || image;
  $("#generator details").hidden = false;
  $("#source-video-panel").hidden = image;
  $("#frame-controls").hidden = image;
  $("#frame-previews").hidden = image;
  $("[name=generate_audio]").closest("label").hidden = image;
  $("[name=seed]").closest("label").hidden = image || provider === "modelark";
  $("#generate").innerHTML = `Generate ${image ? "image" : "video"} <span>→</span>`;
  syncImageOptions();
  syncExtensionTaskType();
  refreshModels();
}

function syncExtensionTaskType() {
  const taskType = $("[name=omni_reference_task_type]");
  const extending = Boolean(sourceVideo || $("#source-video-url").value.trim());
  if (extending) taskType.value = "extend";
  taskType.disabled = extending;
}

function money(value) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

async function refreshCredits() {
  const credits = await api("/api/credits").catch(() => ({}));
  const labels = [];
  if (credits.openrouter) {
    if (typeof credits.openrouter.balance === "number") labels.push(`OpenRouter · ${money(credits.openrouter.balance)} credit`);
    else if (typeof credits.openrouter.limit_remaining === "number") labels.push(`OpenRouter · ${money(credits.openrouter.limit_remaining)} key limit`);
    else labels.push(credits.openrouter.error ? "OpenRouter · credit unavailable" : "OpenRouter · no key credit limit");
  }
  if (credits.modelark) labels.push(credits.modelark.available ? `ModelArk · ${money(credits.modelark.balance)} left` : "ModelArk · balance in console");
  $("#connection").textContent = labels.join("  |  ") || "Add an API key to start";
  $("#connection").classList.toggle("offline", !labels.length);
}

async function checkJobs() {
  const pending = jobs.filter((job) => !["completed", "failed", "cancelled", "expired"].includes(job.status) && jobId(job));
  await Promise.all(pending.map(async (job) => {
    try { Object.assign(job, await api(`/api/videos/${jobId(job)}?provider=${encodeURIComponent(job.provider || "openrouter")}`)); }
    catch (e) { job.error = e.message; }
  }));
  const scratchJobs = jobs.filter((job) => ["completed", "failed", "cancelled", "expired"].includes(job.status) && job.scratchDriveFileId);
  await Promise.all(scratchJobs.map(async (job) => {
    try {
      await api(`/api/drive/files/${encodeURIComponent(job.scratchDriveFileId)}`, { method: "DELETE" });
      delete job.scratchDriveFileId;
      delete job.scratchDriveCleanupError;
    } catch (e) { job.scratchDriveCleanupError = e.message; }
  }));
  save(); render();
}

form.addEventListener("submit", async (event) => {
  event.preventDefault(); error();
  const values = new FormData(form);
  const button = $("#generate"); button.disabled = true; button.textContent = "Submitting…";
  let scratchDriveFileId;
  try {
    const provider = values.get("provider");
    const kind = values.get("generation_type");
    const { refs, frames, extensionVideo: sourceVideoUrl, sourceVideo: localSourceVideo } = await parseAssets();
    if (kind === "image") {
      const model = values.get("model");
      const resolution = values.get("image_resolution");
      const aspectRatio = values.get("image_aspect_ratio");
      const imageCount = Number(values.get("image_count"));
      const payload = { provider, model, prompt: values.get("prompt"), resolution, aspect_ratio: aspectRatio };
      if (provider === "modelark") {
        // ModelArk uses `size`; explicit dimensions give the selected aspect
        // ratio while staying within Seedream Lite's supported pixel range.
        payload.size = imageOutputDimensions().join("x");
        delete payload.resolution;
        delete payload.aspect_ratio;
        payload.response_format = "url";
        payload.watermark = false;
        if (imageCount > 1) {
          payload.sequential_image_generation = "auto";
          payload.sequential_image_generation_options = { max_images: imageCount };
        }
      } else if (imageCount > 1) {
        payload.n = imageCount;
      }
      if (provider === "modelark" && /^seedream-5-0-/i.test(model)) payload.output_format = "png";
      const imageInputs = refs.map((item) => ({ type: "image_url", image_url: item.image_url }));
      if (provider === "modelark" && imageInputs.length) payload.image = imageInputs.map((item) => item.image_url.url);
      if (provider === "openrouter" && imageInputs.length) payload.input_references = imageInputs;
      const result = await api("/api/images", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const urls = (result.data || []).map((item) => {
        const url = item.url || (item.b64_json && `data:${item.media_type || "image/png"};base64,${item.b64_json}`);
        return url ? { url, media_type: item.media_type } : null;
      }).filter(Boolean);
      if (!urls.length) throw new Error(`${provider === "modelark" ? "ModelArk" : "OpenRouter"} completed the image request without an image result.`);
      jobs.unshift({ id: `image-${Date.now()}`, model: payload.model, prompt: payload.prompt, provider, kind: "image", status: "completed", output_urls: urls });
      save(); render(); refreshCredits();
      return;
    }
    let extensionVideo = sourceVideoUrl;
    const prompt = String(values.get("prompt") || "");
    const payload = {
      model: values.get("model"), prompt,
      duration: Number(values.get("duration")), aspect_ratio: values.get("aspect_ratio"),
      resolution: values.get("resolution"), generate_audio: values.get("generate_audio") === "on"
    };
    const size = values.get("size");
    const seed = values.get("seed");
    if (size) {
      payload.size = size;
      delete payload.resolution;
      delete payload.aspect_ratio;
    }
    if (seed !== "") payload.seed = Number(seed);
    if (!payload.prompt.trim() && !frames.length) throw new Error("Add a prompt, or a first/last frame image.");
    if (extensionVideo && sourceVideo) throw new Error("Use either a local source video with the trim controls or a pasted source-video URL, not both.");
    if (localSourceVideo && !extensionVideo) {
      if (!driveState.configured) throw new Error("Google Drive scratch upload is not configured. Paste a direct HTTPS video URL instead.");
      if (!driveState.connected) throw new Error("Connect Google Drive before generating with a local source video.");
      button.textContent = "Uploading source video…";
      const sourceFile = await trimmedSourceVideo();
      if (sourceFile !== localSourceVideo.file) button.textContent = "Uploading trimmed source video…";
      const scratch = await uploadSourceVideo(sourceFile);
      extensionVideo = scratch.url;
      scratchDriveFileId = scratch.id;
      localSourceVideo.driveUrl = scratch.url;
      renderSourceVideo();
    }
    if (extensionVideo) {
      if (provider === "openrouter" && payload.model !== "bytedance/seedance-2.5") throw new Error("True video extension is currently enabled only for Seedance 2.5.");
      if (frames.length) throw new Error("Remove first/last frame inputs when extending @Video1; frame images override reference-based generation.");
      if (!/^https:\/\//i.test(extensionVideo)) throw new Error("The source-video URL must begin with https:// and point directly to the video file.");
      delete payload.size;
      delete payload.aspect_ratio;
      payload.input_references = [{ type: "video_url", video_url: { url: extensionVideo } }, ...refs];
    } else {
      if (refs.length) payload.input_references = refs;
      if (frames.length) payload.frame_images = frames;
    }
    if (provider === "modelark") {
      const content = [];
      if (payload.prompt.trim()) content.push({ type: "text", text: payload.prompt });
      refs.forEach((item) => content.push({ type: "image_url", role: "reference_image", image_url: item.image_url }));
      frames.forEach((item) => content.push({ type: "image_url", role: item.frame_type === "first_frame" ? "first_frame" : "last_frame", image_url: item.image_url }));
      if (extensionVideo) content.push({ type: "video_url", role: "reference_video", video_url: { url: extensionVideo } });
      const usesMultimodalReference = !frames.length && (refs.length > 0 || Boolean(extensionVideo));
      const selectedReferenceTask = values.get("omni_reference_task_type");
      const omniReferenceTask = usesMultimodalReference
        ? (extensionVideo ? "extend" : selectedReferenceTask === "auto" ? undefined : selectedReferenceTask)
        : undefined;
      const modelArkPayload = { provider, model: payload.model, content, duration: payload.duration, resolution: payload.resolution, ratio: (frames.length || extensionVideo) ? "adaptive" : payload.aspect_ratio, generate_audio: payload.generate_audio, return_last_frame: values.get("return_last_frame") === "on", camera_fixed: values.get("camera_fixed") === "on", omni_reference_task_type: omniReferenceTask, output_format: values.get("output_format") };
      Object.keys(modelArkPayload).forEach((key) => modelArkPayload[key] === undefined && delete modelArkPayload[key]);
      Object.keys(payload).forEach((key) => delete payload[key]);
      Object.assign(payload, modelArkPayload);
    }
    const job = await api("/api/videos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    jobs.unshift({ ...job, model: payload.model, prompt, provider, kind: "video", status: job.status || "submitted", scratchDriveFileId });
    save(); render(); checkJobs(); refreshCredits();
  } catch (e) {
    if (scratchDriveFileId) api(`/api/drive/files/${encodeURIComponent(scratchDriveFileId)}`, { method: "DELETE" }).catch(() => {});
    error(e.message);
  }
  finally { button.disabled = false; button.innerHTML = `Generate ${$("#generation-type").value} <span>→</span>`; }
});

$("#clear").addEventListener("click", async () => {
  await Promise.all(jobs.filter((job) => job.scratchDriveFileId).map((job) => api(`/api/drive/files/${encodeURIComponent(job.scratchDriveFileId)}`, { method: "DELETE" }).catch(() => {})));
  jobs = []; save(); render();
});
$("#connect-drive").addEventListener("click", () => { window.location.assign("/api/google/connect"); });
$("#disconnect-drive").addEventListener("click", async () => {
  try { await api("/api/google/disconnect", { method: "POST" }); await refreshDriveStatus(); }
  catch (e) { error(e.message); }
});
$("#reference-files").addEventListener("change", (event) => setReferenceSources(event.target.files).catch(error));
$("#source-video-file").addEventListener("change", (event) => setSourceVideo(event.target.files[0]).catch(error));
$("#source-video-url").addEventListener("input", syncExtensionTaskType);
$("#trim-start").addEventListener("input", () => syncTrimRange("start"));
$("#trim-end").addEventListener("input", () => syncTrimRange("end"));
$("#download-trim").addEventListener("click", downloadTrimmedSourceVideo);
$("#first-frame-file").addEventListener("change", (event) => setFrameAsset("first_frame", event.target.files[0]).catch(error));
$("#last-frame-file").addEventListener("change", (event) => setFrameAsset("last_frame", event.target.files[0]).catch(error));
$("#provider").addEventListener("change", syncProviderUI);
$("#generation-type").addEventListener("change", syncProviderUI);
$("#model").addEventListener("change", syncImageOptions);
form.addEventListener("input", saveFormSettings);
form.addEventListener("change", saveFormSettings);
[$("#size"), $("[name=resolution]"), $("[name=aspect_ratio]"), $("[name=image_resolution]"), $("[name=image_aspect_ratio]")].forEach((control) => control.addEventListener("change", () => { renderReferencePreviews(); renderFramePreviews(); }));
$("#close-image-modal").addEventListener("click", () => $("#image-modal").close());
$("#image-modal").addEventListener("click", (event) => { if (event.target === $("#image-modal")) $("#image-modal").close(); });
(function populateDurations() {
  const select = $("#duration");
  for (let seconds = 4; seconds <= 30; seconds += 1) {
    const option = new Option(`${seconds} seconds`, seconds);
    option.selected = seconds === 8;
    select.add(option);
  }
})();
(async () => {
  restoreFormSettings();
  const health = await api("/api/health").catch(() => ({ configured: false }));
  $("#connection").textContent = health.openrouter || health.modelark ? "Checking credit…" : "Add an API key to start";
  $("#connection").classList.toggle("offline", !health.openrouter && !health.modelark);
  render(); syncProviderUI(); await refreshCredits(); await refreshDriveStatus(); await checkJobs();
  window.setInterval(checkJobs, 5000);
})();
