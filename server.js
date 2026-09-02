import { createServer } from "node:http";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { homedir } from "node:os";

const port = Number(process.env.PORT || 3000);
const apiKey = process.env.OPENROUTER_API_KEY;
const publicDir = join(process.cwd(), "public");
const openRouterBase = "https://openrouter.ai";
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${port}/api/google/callback`;
const googleScope = "https://www.googleapis.com/auth/drive.file";
const googleSessions = new Map();
const googleStates = new Map();
const googleTokenDirectory = join(homedir(), ".seedance-studio");
const googleTokenFile = join(googleTokenDirectory, "google-drive-tokens.json");
const googleRefreshTokens = new Map();

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
      return send(res, 200, { configured: Boolean(apiKey) });
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
    if (req.method === "GET" && url.pathname === "/api/models") {
      return send(res, 200, await openRouter("/api/v1/videos/models"));
    }
    if (req.method === "POST" && url.pathname === "/api/videos") {
      const input = await body(req);
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
      return send(res, 200, await openRouter(`/api/v1/videos/${id}`));
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
