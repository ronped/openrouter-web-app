# Seedance Studio

A self-hosted GUI for OpenRouter's asynchronous video API. It keeps your OpenRouter key on the server, discovers currently available video models, and stores job history only in the browser that created it.

## Run it

Use Node.js 18 or later, then start the app with an OpenRouter key:

```bash
OPENROUTER_API_KEY="your-key" npm start
```

Open [http://localhost:3000](http://localhost:3000).

The model picker loads directly from OpenRouter's live `/api/v1/videos/models` catalogue. This is intentional: Seedance 2.5 availability and its accepted settings can change, and the GUI should not pretend a model is available when it isn't.

## What it supports

- Text-to-video generation
- All Seedance 2.5 durations (4–30 seconds), supported resolutions/aspect ratios, exact output sizes, audio, and optional seed controls
- Local image or video uploads (with previews) or image URLs, plus first/last-frame controls
- Seedance 2.5 video extension from a directly downloadable HTTPS source-video URL
- Optional Google Drive scratch uploads for selected local extension clips
- Automatic five-second job polling, inline video playback, and authenticated downloads from OpenRouter's content endpoint
- Local, browser-only generation history

Local images are encoded in the request as data URLs; the app does not persist them. Reference videos uploaded in the reference section stay in the browser and are sampled into three visual stills; a video used for a first-frame selector supplies its final frame, and one used for a last-frame selector supplies its initial frame. For true Seedance 2.5 extension, use the source-video section and provide a directly downloadable HTTPS URL. OpenRouter's video-generation endpoint rejects local `data:` URLs for `video_url`.

For true extension, Seedance inherits the source video’s framing. OpenRouter’s public request schema does not expose Seedance’s internal `adaptive` ratio value, so the app omits `aspect_ratio` entirely and ignores the Frame and Exact output size controls; the resolution setting is still sent.

## Google Drive scratch uploads (optional)

When configured, a selected local source clip is uploaded to the connected user's Google Drive, set to “anyone with the link can read,” and submitted to OpenRouter through a direct Google Drive download URL. The app deletes the scratch file after the generation reaches a terminal status. If the browser or server stops before that, delete the file manually from Drive. Scratch uploads are limited to 100 MiB.

After the first successful Drive connection, the app stores only the Google refresh token in an AES-256-GCM encrypted local file at `~/.seedance-studio/google-drive-tokens.json`, with owner-only file permissions. Its encryption key is derived at runtime from `GOOGLE_CLIENT_SECRET`, so the token file cannot be used without that secret. The connection survives app restarts in the same browser; use **Disconnect** in the app to remove the saved token.

### Create the Google OAuth client

1. Open [Google Cloud Console](https://console.cloud.google.com/), sign in with the Google account whose Drive you want to use, and create a new project (or choose an existing personal project).
2. Open **APIs & Services → Library**, search for **Google Drive API**, open it, and select **Enable**.
3. Open **APIs & Services → OAuth consent screen**. Choose **External** for a personal Google account (or **Internal** only if you use a managed Google Workspace account), then complete the required app name, support email, and developer-contact fields.
4. On the consent screen’s **Test users** section, add the Google account that will connect Drive. This is needed while the app is in testing mode.
5. Open **APIs & Services → Credentials → Create credentials → OAuth client ID**. If asked, complete the consent-screen setup first.
6. Choose **Web application** as the application type and give it a recognizable name, such as `Seedance Studio Local`.
7. Under **Authorized redirect URIs**, add exactly:

   ```text
   http://localhost:3000/api/google/callback
   ```

   It must match exactly—protocol, host, port, and path. If you later deploy the app or choose another port, add that exact callback URL too.
8. Click **Create**, then copy the displayed **Client ID** and **Client secret**. Keep the secret private; do not put it in browser-side files or commit it to source control.

### Start the app with Drive support

Run the app with the OAuth client credentials:

```bash
OPENROUTER_API_KEY="your-key" \
GOOGLE_CLIENT_ID="your-client-id" \
GOOGLE_CLIENT_SECRET="your-client-secret" \
npm start
```

Open [http://localhost:3000](http://localhost:3000), expand **Reference images & frame control**, select a local source video, and choose **Connect Google Drive**. Sign in with the test-user account from step 4 and approve the permission request.

The app asks only for Google’s `drive.file` scope: it can create, share, and delete files it uses, rather than browse the rest of the Drive.

For public deployment, set `OPENROUTER_API_KEY`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` in your host's secret manager and place authentication in front of the app. Do not expose the server endpoint without access control: anyone who can reach it can spend credits using the configured key or use its configured Google Drive connection.
