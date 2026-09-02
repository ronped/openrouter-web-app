const $ = (selector) => document.querySelector(selector);
const form = $("#generator");
const jobsEl = $("#jobs");
const key = "seedance-studio-jobs";
let jobs = JSON.parse(localStorage.getItem(key) || "[]");
let knownModels = [];
let referenceSources = [];
let referenceProcessing = Promise.resolve();
let frameAssets = { first_frame: null, last_frame: null };
let frameProcessing = { first_frame: Promise.resolve(), last_frame: Promise.resolve() };
let sourceVideo = null;
let driveState = { configured: false, connected: false };

function save() { localStorage.setItem(key, JSON.stringify(jobs)); }
function error(message = "") { $("#form-error").textContent = message; }
function jobId(job) { return job.id || job.generation_id; }

function outputUrls(job) {
  return job.video_urls || job.output_urls || job.unsigned_urls || job.output?.videos || [];
}

function contentUrl(job, index = 0) {
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
      const url = contentUrl(job, index) || (typeof urls[index] === "string" ? urls[index] : urls[index]?.url);
      if (!url) continue;
      const video = document.createElement("video");
      video.src = url; video.controls = true; video.preload = "metadata";
      output.append(video);
      const download = document.createElement("a");
      download.href = url; download.download = `seedance-${jobId(job) || "video"}-${index + 1}.mp4`;
      download.textContent = `Download clip ${index + 1}`; download.className = "download";
      output.append(download);
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
  return canvas.toDataURL("image/jpeg", 0.88);
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
      frames.push(canvas.toDataURL("image/jpeg", 0.84));
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

async function frameDataUrl(file, frameType) {
  if (file.type.startsWith("image/")) return imageDataUrl(file);
  if (file.type.startsWith("video/")) {
    const position = frameType === "first_frame" ? 0.98 : 0.02;
    return (await videoStillDataUrls(file, [position]))[0];
  }
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

function previewCard(url, label, remove, tag = null) {
  const card = document.createElement("div"); card.className = "preview-card";
  const image = document.createElement("img"); image.src = url; image.alt = label; image.title = "Click to enlarge";
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
  card.append(image, removeButton);
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
    }));
  });
}

function renderSourceVideo() {
  const target = $("#source-video-preview"); target.replaceChildren();
  if (!sourceVideo) return;
  const label = document.createElement("span"); label.textContent = sourceVideo.driveUrl ? `@Video1 · ${sourceVideo.file.name} · Google Drive scratch link ready` : `@Video1 · ${sourceVideo.file.name}`;
  const remove = document.createElement("button"); remove.type = "button"; remove.className = "quiet"; remove.textContent = "Remove";
  remove.addEventListener("click", () => { sourceVideo = null; $("#source-video-file").value = ""; renderSourceVideo(); });
  target.append(label, remove);
}

function setSourceVideo(file) {
  if (file && !file.type.startsWith("video/")) return Promise.reject(new Error(`${file.name} is not a video.`));
  sourceVideo = file ? { file } : null; renderSourceVideo();
  return Promise.resolve();
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
  const localRefs = referenceSources.flatMap((source) => source.urls);
  const refs = [...localRefs, ...urlRefs].map((url) => ({ type: "image_url", image_url: { url } }));
  const choices = [
    ["first_frame", frameAssets.first_frame?.url, $("#first-frame").value.trim()],
    ["last_frame", frameAssets.last_frame?.url, $("#last-frame").value.trim()]
  ];
  const frames = choices.map(([frame_type, localUrl, url]) => {
    const value = localUrl || url;
    return value ? { type: "image_url", frame_type, image_url: { url: value } } : null;
  });
  const totalLength = [...refs, ...frames.filter(Boolean)].reduce((sum, item) => sum + item.image_url.url.length, 0);
  if (totalLength > 12_000_000) throw new Error("The selected images are too large together. Use fewer or smaller images.");
  return { refs, frames: frames.filter(Boolean), extensionVideo: $("#source-video-url").value.trim(), sourceVideo };
}

async function refreshModels() {
  try {
    const payload = await api("/api/models");
    knownModels = payload.data || payload.models || [];
    const select = $("#model");
    const current = select.value;
    select.replaceChildren();
    knownModels.forEach((model) => select.add(new Option(model.name || model.id, model.id)));
    if (!knownModels.length) select.add(new Option("No video models returned", ""));
    select.value = knownModels.some((m) => m.id === current) ? current : knownModels[0]?.id || "";
    const seedance = knownModels.find((m) => m.id === "bytedance/seedance-2.5");
    $("#model-note").textContent = seedance
      ? "Seedance 2.5 is available. Settings are checked by OpenRouter when the job is submitted."
      : "Seedance 2.5 is not in the current live catalog; choose an available video model.";
  } catch (e) {
    $("#model-note").textContent = `Could not load the video catalog: ${e.message}`;
  }
}

async function checkJobs() {
  const pending = jobs.filter((job) => !["completed", "failed", "cancelled", "expired"].includes(job.status) && jobId(job));
  await Promise.all(pending.map(async (job) => {
    try { Object.assign(job, await api(`/api/videos/${jobId(job)}`)); }
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
    const { refs, frames, extensionVideo: sourceVideoUrl, sourceVideo: localSourceVideo } = await parseAssets();
    let extensionVideo = sourceVideoUrl;
    const payload = {
      model: values.get("model"), prompt: values.get("prompt"),
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
    if (localSourceVideo && !extensionVideo) {
      if (!driveState.configured) throw new Error("Google Drive scratch upload is not configured. Paste a direct HTTPS video URL instead.");
      if (!driveState.connected) throw new Error("Connect Google Drive before generating with a local source video.");
      button.textContent = "Uploading source video…";
      const scratch = await uploadSourceVideo(localSourceVideo.file);
      extensionVideo = scratch.url;
      scratchDriveFileId = scratch.id;
      localSourceVideo.driveUrl = scratch.url;
      renderSourceVideo();
    }
    if (extensionVideo) {
      if (payload.model !== "bytedance/seedance-2.5") throw new Error("True video extension is currently enabled only for Seedance 2.5.");
      if (frames.length) throw new Error("Remove first/last frame inputs when extending @Video1; frame images override reference-based generation.");
      if (!/^https:\/\//i.test(extensionVideo)) throw new Error("The source-video URL must begin with https:// and point directly to the video file.");
      delete payload.size;
      delete payload.aspect_ratio;
      payload.input_references = [{ type: "video_url", video_url: { url: extensionVideo } }, ...refs];
    } else {
      if (refs.length) payload.input_references = refs;
      if (frames.length) payload.frame_images = frames;
    }
    const job = await api("/api/videos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    jobs.unshift({ ...job, model: payload.model, prompt: payload.prompt, status: job.status || "submitted", scratchDriveFileId });
    save(); render(); checkJobs();
  } catch (e) {
    if (scratchDriveFileId) api(`/api/drive/files/${encodeURIComponent(scratchDriveFileId)}`, { method: "DELETE" }).catch(() => {});
    error(e.message);
  }
  finally { button.disabled = false; button.innerHTML = "Generate video <span>→</span>"; }
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
$("#first-frame-file").addEventListener("change", (event) => setFrameAsset("first_frame", event.target.files[0]).catch(error));
$("#last-frame-file").addEventListener("change", (event) => setFrameAsset("last_frame", event.target.files[0]).catch(error));
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
  const health = await api("/api/health").catch(() => ({ configured: false }));
  $("#connection").textContent = health.configured ? "OpenRouter connected" : "Add OPENROUTER_API_KEY to start";
  $("#connection").classList.toggle("offline", !health.configured);
  render(); await refreshModels(); await refreshDriveStatus(); await checkJobs();
  window.setInterval(checkJobs, 5000);
})();
