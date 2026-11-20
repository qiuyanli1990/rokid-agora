# AIUI Voice Agent Customer Package

This repository contains the customer delivery for an AIUI voice agent:

- `examples/agent/` — the AIUI Agent uploaded to AIUI Studio.
- `examples/server/` — the Node.js backend. It keeps Agora credentials on the server and creates short-lived session tokens.
- `src/` — the Agora AIUI client SDK used by the Agent.

Only `examples/agent/` is uploaded to AIUI Studio. Run `examples/server/` on a computer that the glasses can reach on the same LAN.

## 1. Prerequisites

Install or obtain:

- Node.js 22 or later and Git.
- An Ink host with WHIP/WebRTC, microphone, and Worker support. Desktop testing uses `ink-open`.
- An Agora or Shengwang project with App ID + App Certificate, Conversational AI, Signaling (RTM), and duplex WHIP enabled.
- A **published** voice pipeline from AI Studio. A draft pipeline is not usable.

The App Certificate and any model/vendor keys stay in the backend `.env` file. Never put them in `examples/agent/` or AIUI Studio.

## 2. Get the code and install dependencies

```sh
git clone <CUSTOMER_REPOSITORY_URL>
cd <CUSTOMER_REPOSITORY_DIRECTORY>
npm ci
npm run example:prepare
```

Run `npm run example:prepare` again after changing files under `src/`.

## 3. Configure and start the LAN backend

Create the private server configuration:

```sh
cp examples/server/.env.example examples/server/.env
```

Edit `examples/server/.env`:

```dotenv
AGORA_APP_ID=<project-app-id>
AGORA_APP_CERTIFICATE=<project-primary-certificate>
AGORA_PIPELINE_ID=<published-ai-studio-pipeline-id>
AGORA_AREA=AP
AGORA_AGENTS_API_BASE_URL=https://api.agora.io
AGORA_WHIP_BASE_URL=https://ap-webrtc-whip.ap.sd-rtn.com
BACKEND_API_TOKEN=<random-token-at-least-24-characters>
ALLOWED_ORIGINS=
HOST=0.0.0.0
PORT=8787
```

Generate a token with:

```sh
node -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))"
```

For Shengwang China, set `AGORA_AREA=CN`, use the Shengwang API origin and the WHIP endpoint enabled for the project. Keep the App ID, certificate, and pipeline from the same project.

Start the backend and leave this terminal open:

```sh
npm run example:server
```

The server listens on TCP port `8787`. Allow this port through the computer firewall. The glasses/Ink host and this computer must be on the same LAN. Use the computer's LAN IPv4 address, for example `192.168.1.20`.

## 4. Set the LAN server URL in the AIUI Agent

Edit `examples/agent/configuration.js`:

```js
export default {
  provider: 'agora',
  backendURL: 'http://192.168.1.20:8787',
  localTools: false,
  microphoneMode: 'full-duplex',
  async authorization() {
    return 'Bearer <the-same-BACKEND_API_TOKEN-as-the-server>';
  },
};
```

Replace the IP address and token. Use `provider: 'shengwang'` for a Shengwang pipeline. `backendURL` may use private HTTP only for LAN development; use HTTPS for a deployed backend.

## 5. Test locally before uploading

Start the backend from step 3, then open a second terminal:

```sh
ink-open examples/agent --networking-transport native --permission-checks
```

Allow microphone access, tap **Let's talk**, ask a question, confirm that the agent answers, then tap **End**. If the backend log shows `ORIGIN_DENIED` during web preview, add the exact Origin shown in the log to `ALLOWED_ORIGINS`, separated by commas, and restart the server.

## 6. Import the Agent into AIUI Studio

1. Push this repository to the customer's GitHub account.
2. Open AIUI Studio: <https://aiui-global.rokid.com/> (global) or <https://aiui.rokid.com/space> (China).
3. Choose **GitHub import** and authorize GitHub if requested.
4. Select the customer repository, branch/tag, and directory **`examples/agent`**. Do not import the repository root; the backend is not an AIUI Agent.
5. Open the imported project in the **Code** tab and verify `configuration.js` contains the reachable LAN URL and the matching backend token.
6. Use **Preview** to check the page. Preview only proves the UI can load; the backend computer must be reachable from the preview runtime.

If GitHub import is unavailable, download the repository and use **Local import** with the `examples/agent` folder.

## 7. Package and update the glasses

1. In AIUI Studio open **Build & Review** (or **Build & Submit for Review**).
2. Select **Package AIX** and wait for **Upload successful**.
3. Save the agent information. A new package/version must be generated after every code change.
4. Open the Rokid AI app and connect the glasses.
5. Go to **Settings → Developer Options → AIUI → Update glasses resource**.
6. Wait for **Agent resource package downloaded successfully**.
7. Invoke the agent by voice and run the full call flow on the glasses.

When code or `configuration.js` changes, push the new commit, refresh/re-import the Agent in AIUI Studio, package AIX again, save, and repeat the glasses resource update. Updating the GitHub repository alone does not update a device.

## 8. Release checklist

- The backend runs on an HTTPS, reachable host for production devices.
- `.env` is local only and is not committed.
- The App Certificate and vendor/model keys exist only on the backend.
- `backendURL` resolves from the target device, and the server firewall allows the port.
- The published pipeline, App ID, certificate, provider, area, and WHIP endpoint belong to the same cloud project.
- The current package passes a real-device smoke test before submission.

Run the SDK checks before handing over a release:

```sh
npm run check
```

For API and troubleshooting details, see [`docs/getting-started.md`](docs/getting-started.md), [`docs/backend.md`](docs/backend.md), and [`docs/troubleshooting.md`](docs/troubleshooting.md).
