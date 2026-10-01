import { createServer } from "node:http";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scryptSync } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { spawn } from "node:child_process";

const port = Number(process.env.PORT || 3000);
const apiKey = process.env.OPENROUTER_API_KEY;
const openRouterManagementKey = process.env.OPENROUTER_MANAGEMENT_KEY;
const modelArkApiKey = process.env.MODELARK_API_KEY;
const bytePlusAccessKeyId = process.env.BYTEPLUS_ACCESS_KEY_ID;
const bytePlusSecretAccessKey = process.env.BYTEPLUS_SECRET_ACCESS_KEY;
const modelArkRegion = process.env.MODELARK_REGION || "ap-southeast-1";
const publicDir = join(process.cwd(), "public");
const openRouterBase = "https://openrouter.ai";
const modelArkBase = process.env.MODELARK_BASE_URL || "https://ark.ap-southeast.bytepluses.com/api/v3";
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${port}/api/google/callback`;
const googleScope = "https://www.googleapis.com/auth/drive.file";
const googleSessions = new Map();
const googleStates = new Map();
const googleTokenDirectory = join(homedir(), ".seedance-studio");
const googleTokenFile = join(googleTokenDirectory, "google-drive-tokens.json");
const googleRefreshTokens = new Map();
const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobePath = process.env.FFPROBE_PATH || "ffprobe";

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml"
};

function send(res, status, data, type = "application/json; charset=utf-8", headers = {}) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
  res.end(Buffer.isBuffer(data) || typeof data === "string" ? data : JSON.stringify(data));
}

function configuredGoogle() { return Boolean(googleClientId && googleClientSecret); }
function missingGoogleConfiguration() {
  return [!googleClientId && "GOOGLE_CLIENT_ID", !googleClientSecret && "GOOGLE_CLIENT_SECRET"].filter(Boolean);
}

function tokenEncryptionKey() {
  if (!configuredGoogle()) throw new Error("Google Drive scratch upload is not configured.");
  return scryptSync(googleClientSecret, `seedance-studio:${googleClientId}:drive-token-store`, 32);
}

function encryptRefreshToken(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", tokenEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: encrypted.toString("base64") };
}

function decryptRefreshToken(value) {
  const decipher = createDecipheriv("aes-256-gcm", tokenEncryptionKey(), Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

async function loadGoogleRefreshTokens() {
  if (!configuredGoogle()) return;
  try {
    const saved = JSON.parse(await readFile(googleTokenFile, "utf8"));
    Object.entries(saved.tokens || {}).forEach(([id, value]) => googleRefreshTokens.set(id, decryptRefreshToken(value)));
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("Could not restore the saved Google Drive connection. Connect Drive again if needed.");
  }
}

async function saveGoogleRefreshTokens() {
  await mkdir(googleTokenDirectory, { recursive: true, mode: 0o700 });
  const tokens = Object.fromEntries([...googleRefreshTokens].map(([id, value]) => [id, encryptRefreshToken(value)]));
  const temporary = `${googleTokenFile}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify({ version: 1, tokens }), { mode: 0o600 });
  await rename(temporary, googleTokenFile);
  await chmod(googleTokenFile, 0o600);
}

function cookie(req, name) {
  return (req.headers.cookie || "").split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`))?.slice(name.length + 1);
}

function sessionId(req) { return cookie(req, "seedance_drive_session"); }

function sessionCookie(id) {
  return `seedance_drive_session=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`;
}

async function googleResponse(url, options, fallback) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || payload.error_description || fallback || `Google Drive returned ${response.status}.`);
  return payload;
}

async function driveAccessToken(req) {
  const id = sessionId(req);
  let session = id && googleSessions.get(id);
  if (!session && id && googleRefreshTokens.has(id)) {
    session = { refresh_token: googleRefreshTokens.get(id), expires_at: 0 };
    googleSessions.set(id, session);
  }
  if (!session) throw new Error("Connect Google Drive before uploading a source video.");
  if (Date.now() < session.expires_at - 60_000) return session.access_token;
  if (!session.refresh_token) throw new Error("Your Google Drive connection expired. Connect it again.");
  const form = new URLSearchParams({ client_id: googleClientId, client_secret: googleClientSecret, refresh_token: session.refresh_token, grant_type: "refresh_token" });
  const refreshed = await googleResponse("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form }, "Could not refresh the Google Drive connection.");
  session.access_token = refreshed.access_token;
  session.expires_at = Date.now() + (refreshed.expires_in || 3600) * 1000;
  return session.access_token;
}

async function rawBody(req, maximum, message) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > maximum) throw new Error(message);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function uploadToDrive(req, url) {
  const token = await driveAccessToken(req);
  const type = req.headers["content-type"] || "application/octet-stream";
  if (!type.startsWith("video/")) throw new Error("The Google Drive scratch upload must be a video file.");
  const bytes = await rawBody(req, 100 * 1024 * 1024, "Google Drive scratch uploads are limited to 100 MiB.");
  if (!bytes.length) throw new Error("The selected video is empty.");
  const requestedName = decodeURIComponent(url.searchParams.get("filename") || "source-video.mp4");
  const name = requestedName.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 200) || "source-video.mp4";
  const create = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
      "x-upload-content-type": type,
      "x-upload-content-length": String(bytes.length)
    },
    body: JSON.stringify({ name: `Seedance scratch — ${name}`, mimeType: type })
  });
  if (!create.ok) {
    const payload = await create.json().catch(() => ({}));
    throw new Error(payload.error?.message || `Could not start the Google Drive upload (${create.status}).`);
  }
  const uploadUrl = create.headers.get("location");
  if (!uploadUrl) throw new Error("Google Drive did not return an upload URL.");
  const file = await googleResponse(uploadUrl, { method: "PUT", headers: { "content-type": type, "content-length": String(bytes.length) }, body: bytes }, "Could not upload the source video to Google Drive.");
  try {
    await googleResponse(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}/permissions?fields=id`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "anyone", role: "reader" })
    }, "Google Drive could not make this file readable by link.");
  } catch (error) {
    await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
    throw error;
  }
  return { id: file.id, name: file.name, url: `https://drive.google.com/uc?export=download&id=${encodeURIComponent(file.id)}` };
}

async function body(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 70_000_000) throw new Error("Request is too large. Use a source video under 45 MB, fewer reference images, or a directly accessible video URL.");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function commandOutput(command, args, maximum = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let length = 0;
    child.stdout.on("data", (chunk) => {
      length += chunk.length;
      if (length > maximum) { child.kill(); reject(new Error("Extracted frame is too large.")); return; }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => { if (Buffer.concat(stderr).length < 16_384) stderr.push(chunk); });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `${command} exited with code ${code}.`));
    });
  });
}

async function exactVideoFrame(bytes, filename, position) {
  const directory = await mkdtemp(join(tmpdir(), "seedance-frame-"));
  const extension = extname(filename || "")?.replace(/[^.a-z0-9]/gi, "") || ".video";
  const input = join(directory, `input${extension}`);
  try {
    await writeFile(input, bytes, { mode: 0o600 });
    let frameNumber = 0;
    if (position === "last") {
      const counted = (await commandOutput(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "default=nokey=1:noprint_wrappers=1", input], 1024)).toString("utf8").trim();
      const count = Number.parseInt(counted, 10);
      if (!Number.isInteger(count) || count < 1) throw new Error("Could not determine the number of video frames.");
      frameNumber = count - 1;
    }
    const select = `select=eq(n\\,${frameNumber})`;
    // Selection is the only filter: preserve FFmpeg's ordinary video decode
    // path, then encode a high-quality JPEG to match ModelArk's last frame.
    const jpeg = await commandOutput(ffmpegPath, ["-v", "error", "-i", input, "-map", "0:v:0", "-vf", select, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "mjpeg", "-q:v", "2", "pipe:1"]);
    if (!jpeg.length) throw new Error("Could not extract a video frame.");
    return jpeg;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function trimVideoRange(bytes, filename, start, end) {
  const directory = await mkdtemp(join(tmpdir(), "seedance-trim-"));
  const extension = extname(filename || "")?.replace(/[^.a-z0-9]/gi, "") || ".mp4";
  const input = join(directory, `input${extension}`);
  const output = join(directory, `trimmed${extension}`);
  try {
    await writeFile(input, bytes, { mode: 0o600 });
    const duration = Number((await commandOutput(ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nokey=1:noprint_wrappers=1", input], 1024)).toString("utf8").trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("Could not determine the source-video duration.");
    if (start < 0 || end > duration + 0.05 || end <= start || end - start < 2 || end - start > 15) throw new Error("Choose a 2–15 second range within the source video.");
    // Re-encoding at CRF 0 is lossless for the decoded video frames, which
    // permits a frame-accurate cut instead of retaining a preceding GOP.
    // Keep audio packets untouched.
    await commandOutput(ffmpegPath, ["-v", "error", "-ss", String(start), "-i", input, "-t", String(end - start), "-map", "0:v", "-map", "0:a?", "-c:v", "libx264", "-crf", "0", "-preset", "medium", "-c:a", "copy", "-movflags", "+faststart", "-avoid_negative_ts", "make_zero", output], 1024);
    const trimmed = await readFile(output);
    if (!trimmed.length) throw new Error("Could not trim the selected video.");
    const outputDuration = Number((await commandOutput(ffprobePath, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nokey=1:noprint_wrappers=1", output], 1024)).toString("utf8").trim());
    return { bytes: trimmed, sourceDuration: duration, outputDuration: Number.isFinite(outputDuration) ? outputDuration : undefined };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function videoInfo(bytes, filename) {
  const directory = await mkdtemp(join(tmpdir(), "seedance-video-info-"));
  const extension = extname(filename || "")?.replace(/[^.a-z0-9]/gi, "") || ".video";
  const input = join(directory, `input${extension}`);
  try {
    await writeFile(input, bytes, { mode: 0o600 });
    const raw = await commandOutput(ffprobePath, ["-v", "error", "-select_streams", "v:0", "-show_entries", "format=duration:stream=avg_frame_rate,r_frame_rate", "-of", "json", input], 32 * 1024);
    const probe = JSON.parse(raw.toString("utf8"));
    const parseFrameRate = (rate) => {
      const [numerator, denominator] = String(rate || "").split("/").map(Number);
      return numerator > 0 && denominator > 0 ? numerator / denominator : null;
    };
    const frameRate = parseFrameRate(probe.streams?.[0]?.avg_frame_rate) || parseFrameRate(probe.streams?.[0]?.r_frame_rate);
    const duration = Number(probe.format?.duration);
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(frameRate) || frameRate <= 0) throw new Error("Could not determine the source-video frame rate.");
    return { duration, frameRate };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function openRouter(path, options = {}) {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured on the server.");
  const response = await fetch(`${openRouterBase}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "http-referer": `http://localhost:${port}`,
      "x-title": "Seedance Studio",
      ...options.headers
    }
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: text }; }
  if (!response.ok) {
    const error = new Error(payload.error?.message || payload.message || `OpenRouter returned ${response.status}.`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function modelArk(path, options = {}) {
  if (!modelArkApiKey) throw new Error("MODELARK_API_KEY is not configured on the server.");
  const response = await fetch(`${modelArkBase}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${modelArkApiKey}`, "content-type": "application/json", ...options.headers }
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = { error: text }; }
  if (!response.ok) {
    const error = new Error(payload.error?.message || payload.message || payload.error?.code || `ModelArk returned ${response.status}.`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function hmac(key, value, encoding) { return createHmac("sha256", key).update(value).digest(encoding); }
function bytePlusTimestamp(date = new Date()) {
  const iso = date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  return { timestamp: iso, shortDate: iso.slice(0, 8) };
}

async function bytePlusControlPlane(action, payload = {}) {
  if (!bytePlusAccessKeyId || !bytePlusSecretAccessKey) return null;
  const host = `ark.${modelArkRegion}.byteplusapi.com`;
  const query = `Action=${encodeURIComponent(action)}&Version=2024-01-01`;
  const body = JSON.stringify(payload);
  const payloadHash = sha256(body);
  const { timestamp, shortDate } = bytePlusTimestamp();
  const signedHeaders = "host;x-content-sha256;x-date";
  const canonicalHeaders = `host:${host}\nx-content-sha256:${payloadHash}\nx-date:${timestamp}\n`;
  const canonicalRequest = `POST\n/\n${query}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const scope = `${shortDate}/${modelArkRegion}/ark/request`;
  const stringToSign = `HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
  const signingKey = hmac(hmac(hmac(hmac(bytePlusSecretAccessKey, shortDate), modelArkRegion), "ark"), "request");
  const signature = hmac(signingKey, stringToSign, "hex");
  const authorization = `HMAC-SHA256 Credential=${bytePlusAccessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(`https://${host}/?${query}`, { method: "POST", headers: { "content-type": "application/json", host, "x-content-sha256": payloadHash, "x-date": timestamp, authorization }, body });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.ResponseMetadata?.Error?.Message || result.message || `BytePlus ${action} returned ${response.status}.`);
  return result;
}

function stringsIn(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringsIn(item, output));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => stringsIn(item, output));
  return output;
}

function foundationModelFor(candidate, foundationModels) {
  const normalized = candidate.toLowerCase();
  return foundationModels.find((model) => {
    const name = String(model.Name || "").toLowerCase();
    return name && (normalized === name || normalized.startsWith(`${name}-`) || normalized.includes(name));
  });
}

function callableModelId(activationId, foundation) {
  const version = String(foundation?.PrimaryVersion || "");
  // Visual-generation releases use a numeric build suffix (for example 260628).
  // Activations can return only the family ID, which is not accepted by the
  // inference endpoint; compose it with the foundation model's primary release.
  if (/^\d{6,}$/.test(version) && !new RegExp(`[-_]${version}$`).test(activationId)) return `${activationId}-${version}`;
  return activationId;
}

function visualModelFromActivation(item, foundationModels = []) {
  const strings = stringsIn(item);
  const candidates = [item.ModelVersion, item.Model?.ModelVersion, item.Model?.Version, item.Model?.Id, item.ModelId, ...strings].filter((value) => typeof value === "string");
  const candidate = candidates.find((value) => /(?:seedance|seedream).*[-_]\d{6,}/i.test(value)) || candidates.find((value) => /(?:seedance|seedream)/i.test(value));
  if (!candidate) return null;
  const type = /seedream/i.test(candidate) ? "image" : /seedance/i.test(candidate) ? "video" : null;
  if (!type) return null;
  const foundation = foundationModelFor(candidate, foundationModels);
  const id = callableModelId(candidate, foundation);
  const displayName = foundation?.DisplayName || item.DisplayName || item.ModelName || foundation?.Name || candidate;
  const primaryVersion = foundation?.PrimaryVersion;
  const name = primaryVersion && !displayName.includes(primaryVersion) ? `${displayName} (version ${primaryVersion})` : displayName;
  return { id, name, generation_type: type, status: item.Status || "activated" };
}

async function listFoundationModels() {
  const result = await bytePlusControlPlane("ListFoundationModels", { PageNumber: 1, PageSize: 100 });
  if (!result) return [];
  return result.Result?.Items || [];
}

async function listModelArkActivations() {
  const [result, foundationModels] = await Promise.all([
    bytePlusControlPlane("ListModelActivations", { PageNumber: 1, PageSize: 100 }),
    listFoundationModels().catch((error) => { console.warn(`ModelArk foundation-model discovery failed: ${error.message}`); return []; })
  ]);
  if (!result) return null;
  const items = result.Result?.Items || result.Result?.ModelActivations || result.Result?.Data || [];
  return items.map((item) => visualModelFromActivation(item, foundationModels)).filter(Boolean);
}

async function listModelArkEndpoints() {
  const result = await bytePlusControlPlane("ListEndpoints", { PageNumber: 1, PageSize: 100 });
  if (!result) return null;
  return (result.Result?.Items || []).map((item) => {
    const foundation = item.ModelReference?.FoundationModel || {};
    const summary = JSON.stringify(item).toLowerCase();
    const generationType = summary.includes("seedream") ? "image" : summary.includes("seedance") ? "video" : null;
    const label = item.Name || foundation.ModelVersion || foundation.Name || item.Id;
    return generationType && item.Id ? { id: item.Id, name: item.Status ? `${label} (${item.Status})` : label, generation_type: generationType, status: item.Status } : null;
  }).filter(Boolean);
}

function modelArkStatus(status) {
  return ({ succeeded: "completed", success: "completed", completed: "completed", failed: "failed", cancelled: "cancelled", expired: "expired", processing: "processing", running: "processing", pending: "queued", queued: "queued" })[status] || status || "submitted";
}

function modelArkVideoUrls(payload) {
  const candidates = [payload.video_url, payload.video_url?.url, payload.content?.video_url, payload.content?.video_url?.url, payload.output?.video_url, payload.output?.video_url?.url, payload.data?.video_url, payload.data?.video_url?.url, ...(payload.content?.videos || []), ...(payload.output?.videos || [])];
  return [...new Set(candidates.map((item) => typeof item === "string" ? item : item?.url).filter(Boolean))];
}

function modelArkPrompt(payload) {
  const content = Array.isArray(payload.content) ? payload.content : Array.isArray(payload.input?.content) ? payload.input.content : [];
  return content.find((item) => item?.type === "text")?.text;
}

function normalizeModelArkVideo(payload) {
  const prompt = payload.prompt || modelArkPrompt(payload);
  return { ...payload, ...(prompt ? { prompt } : {}), id: payload.id || payload.task_id, status: modelArkStatus(payload.status), output_urls: modelArkVideoUrls(payload), last_frame_url: payload.last_frame_url || payload.content?.last_frame_url || payload.output?.last_frame_url };
}

async function videoContent(id, index) {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured on the server.");
  const response = await fetch(`${openRouterBase}/api/v1/videos/${id}/content?index=${index}`, {
    headers: {
      authorization: `Bearer ${apiKey}`,
      "http-referer": `http://localhost:${port}`,
      "x-title": "Seedance Studio"
    }
  });
  if (!response.ok) {
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { payload = {}; }
    const error = new Error(payload.error?.message || payload.message || `OpenRouter returned ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return response;
}

await loadGoogleRefreshTokens();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, { configured: Boolean(apiKey), openrouter: Boolean(apiKey), modelark: Boolean(modelArkApiKey) });
    }
    if (req.method === "GET" && url.pathname === "/api/google/status") {
      const id = sessionId(req);
      return send(res, 200, { configured: configuredGoogle(), connected: Boolean(id && (googleSessions.has(id) || googleRefreshTokens.has(id))), missing: missingGoogleConfiguration() });
    }
    if (req.method === "GET" && url.pathname === "/api/google/connect") {
      if (!configuredGoogle()) return send(res, 503, { error: "Google Drive scratch upload is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server first." });
      const id = sessionId(req) || randomBytes(24).toString("hex");
      const state = randomBytes(24).toString("hex");
      googleStates.set(state, { id, expires: Date.now() + 10 * 60_000 });
      const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authorize.search = new URLSearchParams({ client_id: googleClientId, redirect_uri: googleRedirectUri, response_type: "code", scope: googleScope, access_type: "offline", prompt: "consent", state }).toString();
      return send(res, 302, "", "text/plain", { location: authorize.toString(), "set-cookie": sessionCookie(id) });
    }
    if (req.method === "GET" && url.pathname === "/api/google/callback") {
      const state = googleStates.get(url.searchParams.get("state"));
      googleStates.delete(url.searchParams.get("state"));
      if (!state || state.expires < Date.now() || state.id !== sessionId(req)) return send(res, 400, "Google Drive connection could not be verified. Please try again.", "text/plain");
      if (url.searchParams.get("error")) return send(res, 302, "", "text/plain", { location: `/?drive_error=${encodeURIComponent(url.searchParams.get("error"))}` });
      const code = url.searchParams.get("code");
      if (!code) return send(res, 400, "Google did not return an authorization code.", "text/plain");
      const form = new URLSearchParams({ code, client_id: googleClientId, client_secret: googleClientSecret, redirect_uri: googleRedirectUri, grant_type: "authorization_code" });
      const token = await googleResponse("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form }, "Could not connect Google Drive.");
      const refreshToken = token.refresh_token || googleRefreshTokens.get(state.id);
      if (!refreshToken) throw new Error("Google did not return a reusable connection token. Try connecting Drive again.");
      googleRefreshTokens.set(state.id, refreshToken);
      await saveGoogleRefreshTokens();
      googleSessions.set(state.id, { access_token: token.access_token, refresh_token: refreshToken, expires_at: Date.now() + (token.expires_in || 3600) * 1000 });
      return send(res, 302, "", "text/plain", { location: "/?drive_connected=1" });
    }
    if (req.method === "POST" && url.pathname === "/api/google/disconnect") {
      const id = sessionId(req);
      if (id) {
        googleSessions.delete(id);
        googleRefreshTokens.delete(id);
        await saveGoogleRefreshTokens();
      }
      return send(res, 200, { disconnected: true }, "application/json; charset=utf-8", { "set-cookie": "seedance_drive_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
    }
    if (req.method === "POST" && url.pathname === "/api/drive/upload") {
      return send(res, 200, await uploadToDrive(req, url));
    }
    if (req.method === "DELETE" && /^\/api\/drive\/files\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
      const token = await driveAccessToken(req);
      const id = url.pathname.split("/").pop();
      const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } });
      if (!response.ok && response.status !== 404) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error?.message || `Could not remove the Google Drive scratch file (${response.status}).`);
      }
      return send(res, 200, { deleted: true });
    }
    if (req.method === "POST" && url.pathname === "/api/video-frame") {
      const position = url.searchParams.get("position");
      if (position !== "first" && position !== "last") return send(res, 400, { error: "Choose first or last frame." });
      if (!(req.headers["content-type"] || "").startsWith("video/")) return send(res, 400, { error: "Upload a video file." });
      const bytes = await rawBody(req, 100 * 1024 * 1024, "Video frame extraction is limited to 100 MiB.");
      if (!bytes.length) return send(res, 400, { error: "The selected video is empty." });
      const filename = decodeURIComponent(url.searchParams.get("filename") || "input.video");
      return send(res, 200, await exactVideoFrame(bytes, filename, position), "image/jpeg");
    }
    if (req.method === "POST" && url.pathname === "/api/video-trim") {
      const start = Number(url.searchParams.get("start"));
      const end = Number(url.searchParams.get("end"));
      if (!Number.isFinite(start) || !Number.isFinite(end)) return send(res, 400, { error: "Choose a start and end time for the video trim." });
      const type = req.headers["content-type"] || "";
      if (!type.startsWith("video/")) return send(res, 400, { error: "Upload a video file." });
      const bytes = await rawBody(req, 100 * 1024 * 1024, "Video trimming is limited to 100 MiB.");
      if (!bytes.length) return send(res, 400, { error: "The selected video is empty." });
      const filename = decodeURIComponent(url.searchParams.get("filename") || "input.mp4");
      const trimmed = await trimVideoRange(bytes, filename, start, end);
      return send(res, 200, trimmed.bytes, type, { "x-source-duration": String(trimmed.sourceDuration), "x-trimmed-duration": String(trimmed.outputDuration || "") });
    }
    if (req.method === "POST" && url.pathname === "/api/video-info") {
      const type = req.headers["content-type"] || "";
      if (!type.startsWith("video/")) return send(res, 400, { error: "Upload a video file." });
      const bytes = await rawBody(req, 100 * 1024 * 1024, "Video inspection is limited to 100 MiB.");
      if (!bytes.length) return send(res, 400, { error: "The selected video is empty." });
      const filename = decodeURIComponent(url.searchParams.get("filename") || "input.video");
      return send(res, 200, await videoInfo(bytes, filename));
    }
    if (req.method === "GET" && url.pathname === "/api/models") {
      if (url.searchParams.get("provider") === "modelark") {
        try {
          const activations = await listModelArkActivations();
          if (activations) {
            return send(res, 200, { data: activations, live: true });
          }
        } catch (error) {
          console.warn(`ModelArk activation discovery failed: ${error.message}`);
        }
        return send(res, 200, { data: [
          { id: "dreamina-seedance-2-5-260628", name: "Seedance 2.5", generation_type: "video" },
          { id: "seedream-5-0-lite-260128", name: "Seedream 5.0 Lite (image · PNG)", generation_type: "image" }
        ], live: false });
      }
      if (url.searchParams.get("type") === "image") return send(res, 200, await openRouter("/api/v1/images/models"));
      return send(res, 200, await openRouter("/api/v1/videos/models"));
    }
    if (req.method === "GET" && url.pathname === "/api/credits") {
      const credits = { openrouter: null, modelark: modelArkApiKey ? { available: false, message: "Balance is available in the ModelArk console." } : null };
      if (apiKey) {
        try {
          const account = await openRouter("/api/v1/credits", openRouterManagementKey ? { headers: { authorization: `Bearer ${openRouterManagementKey}` } } : {});
          const data = account.data || account;
          credits.openrouter = { balance: Number(data.total_credits) - Number(data.total_usage) };
        } catch {
          try {
            const key = await openRouter("/api/v1/key");
            credits.openrouter = key.data || key;
          } catch (error) { credits.openrouter = { error: error.message }; }
        }
      }
      return send(res, 200, credits);
    }
    if (req.method === "POST" && url.pathname === "/api/videos") {
      const input = await body(req);
      if (input.provider === "modelark") {
        if (typeof input.model !== "string" || !Array.isArray(input.content) || !input.content.length) return send(res, 400, { error: "A ModelArk model and prompt or image input are required." });
        const hasFrameInput = input.content.some((item) => item?.role === "first_frame" || item?.role === "last_frame");
        const hasMultimodalReference = input.content.some((item) => item?.role === "reference_image" || item?.role === "reference_video");
        // ModelArk rejects this field for text-only and frame-guided generation.
        if (hasFrameInput || !hasMultimodalReference) delete input.omni_reference_task_type;
        delete input.provider;
        return send(res, 202, normalizeModelArkVideo(await modelArk("/contents/generations/tasks", { method: "POST", body: JSON.stringify(input) })));
      }
      const hasFrame = Array.isArray(input.frame_images) && input.frame_images.length > 0;
      if (typeof input.model !== "string" || (!hasFrame && (typeof input.prompt !== "string" || !input.prompt.trim()))) {
        return send(res, 400, { error: "A model and either a prompt or a frame image are required." });
      }
      return send(res, 202, await openRouter("/api/v1/videos", {
        method: "POST",
        body: JSON.stringify(input)
      }));
    }
    if (req.method === "GET" && /^\/api\/videos\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
      const id = url.pathname.split("/").pop();
      if (url.searchParams.get("provider") === "modelark") return send(res, 200, normalizeModelArkVideo(await modelArk(`/contents/generations/tasks/${id}`)));
      return send(res, 200, await openRouter(`/api/v1/videos/${id}`));
    }
    if (req.method === "POST" && url.pathname === "/api/images") {
      const input = await body(req);
      const provider = input.provider;
      delete input.provider;
      if (typeof input.model !== "string" || typeof input.prompt !== "string" || !input.prompt.trim()) return send(res, 400, { error: "An image model and prompt are required." });
      if (provider === "modelark") return send(res, 200, await modelArk("/images/generations", { method: "POST", body: JSON.stringify(input) }));
      if (provider === "openrouter") return send(res, 200, await openRouter("/api/v1/images", { method: "POST", body: JSON.stringify(input) }));
      return send(res, 400, { error: "Choose OpenRouter or ModelArk." });
    }
    if (req.method === "GET" && /^\/api\/videos\/[A-Za-z0-9_-]+\/content$/.test(url.pathname)) {
      const id = url.pathname.split("/")[3];
      const index = Math.max(0, Number.parseInt(url.searchParams.get("index") || "0", 10) || 0);
      const content = await videoContent(id, index);
      const bytes = Buffer.from(await content.arrayBuffer());
      return send(res, 200, bytes, content.headers.get("content-type") || "video/mp4");
    }
    if (req.method === "GET") {
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      const file = normalize(join(publicDir, path));
      if (!file.startsWith(publicDir)) return send(res, 404, "Not found", "text/plain");
      const data = await readFile(file);
      return send(res, 200, data.toString(), types[extname(file)] || "application/octet-stream");
    }
    return send(res, 404, { error: "Not found." });
  } catch (error) {
    return send(res, error.status || 500, { error: error.message, details: error.payload });
  }
});

server.listen(port, () => console.log(`Seedance Studio: http://localhost:${port}`));
