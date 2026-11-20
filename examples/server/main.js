import { createServer } from 'node:http';
import { createAgoraAgentFactory } from './agora.js';
import { bearerAuthorizer, createVoiceHandler } from './http.js';
import { createSessionService } from './sessions.js';
import { createDiagnosticLogger } from './logging.js';

const log = createDiagnosticLogger();
const appId = process.env.AGORA_APP_ID;
const certificate = process.env.AGORA_APP_CERTIFICATE;
const area = process.env.AGORA_AREA || 'AP';
const whipBaseURL =
  process.env.AGORA_WHIP_BASE_URL ||
  (area === 'CN' ? undefined : 'https://ap-webrtc-whip.ap.sd-rtn.com');
if (!whipBaseURL) throw new Error('Set AGORA_WHIP_BASE_URL to the enabled China WHIP endpoint.');
const createAgent = createAgoraAgentFactory({
  appId,
  certificate,
  pipelineId: process.env.AGORA_PIPELINE_ID,
  area,
  enableRtm: false,
  enableInterruption: true,
  asrLanguage: process.env.AGORA_ASR_LANGUAGE || undefined,
  log,
});
const service = createSessionService({
  appId,
  certificate,
  createAgent,
  baseURL: whipBaseURL,
  toolsPublicURL: process.env.VOICE_TOOLS_PUBLIC_URL,
  log,
});
const server = createServer(
  createVoiceHandler({
    service,
    log,
    authorize: bearerAuthorizer(process.env.BACKEND_API_TOKEN),
    allowedOrigins: (process.env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  }),
);
server.requestTimeout = 20_000;
server.headersTimeout = 10_000;
const sweeper = setInterval(() => {
  void service.sweep();
}, 10_000);
sweeper.unref();
server.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1', () => {
  log('server.listening', {
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.PORT || 8787),
    area,
    pipelineId: process.env.AGORA_PIPELINE_ID,
  });
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    log('server.stopping', { signal });
    clearInterval(sweeper);
    server.close();
    const deadline = setTimeout(() => process.exit(1), 20_000);
    try {
      await service.close();
      log('server.stopped');
      clearTimeout(deadline);
      process.exitCode = 0;
    } catch {
      console.error('Cloud cleanup is unconfirmed; reconcile active sessions before restarting.');
      process.exitCode = 1;
    }
  });
}
