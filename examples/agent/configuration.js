// Set the URL of the backend on the same LAN as the glasses or Ink host.
// Never put AGORA_APP_CERTIFICATE or cloud vendor API keys in this agent.
export default {
  // 'agora': English / Agora Cloud. 'shengwang': Chinese / 声网 Cloud.
  // UI only; configure the matching service and pipeline in your backend.
  provider: 'agora',
  backendURL: 'http://YOUR_LAN_SERVER_IP:8787',
  // Enable after the backend sets VOICE_TOOLS_PUBLIC_URL. Actions are defined in pages/call/tools.js.
  localTools: false,
  // Use a host with echo cancellation or headphones. Otherwise use 'half-duplex'.
  microphoneMode: 'full-duplex',
  async authorization() {
    // Replace this with the same token as BACKEND_API_TOKEN in examples/server/.env.
    // For production, return a short-lived credential from your user login flow.
    return 'Bearer REPLACE_WITH_BACKEND_API_TOKEN';
  },
};
