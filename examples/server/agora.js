import { AgoraClient, Area } from 'agora-agents';
import agoraToken from 'agora-token';
import { isAgoraUid } from '../../src/agora.js';
import { historySnapshot } from '../../src/transcripts.js';
import { errorInfo, redactDiagnostics } from './logging.js';

const { ConvoAITokenBuilder } = agoraToken;

/** Configure the official server SDK. A saved AI Studio pipeline supplies ASR/LLM/TTS. */
export function createAgoraAgentFactory({
  appId,
  certificate,
  pipelineId,
  area = 'AP',
  enableRtm = false,
  enableInterruption,
  asrLanguage,
  log = () => {},
}) {
  if (!pipelineId || !['AP', 'CN', 'US', 'EU'].includes(area))
    throw new TypeError('Set AGORA_PIPELINE_ID and a valid AGORA_AREA.');
  if (enableInterruption !== undefined && typeof enableInterruption !== 'boolean')
    throw new TypeError('enableInterruption must be a boolean.');
  if (
    asrLanguage !== undefined &&
    (typeof asrLanguage !== 'string' ||
      !asrLanguage.trim() ||
      asrLanguage.length > 64 ||
      /[\r\n]/.test(asrLanguage))
  )
    throw new TypeError('Provide a valid ASR language.');
  const client = new AgoraClient({
    area: Area[area],
    appId,
    appCertificate: certificate,
    timeoutInSeconds: 15,
    maxRetries: 0,
    fetch: async (url, options) => {
      const path = new URL(String(url));
      if (!path.pathname.endsWith('/join')) return globalThis.fetch(url, options);
      const startedAt = Date.now();
      let body;
      try {
        body = JSON.parse(options.body);
      } catch {
        body = '(request body unavailable)';
      }
      const context = {
        sessionName: body?.name,
        channel: body?.properties?.channel,
        url: `${path.origin}${path.pathname}`,
        method: options.method,
      };
      log('agent.http_request', {
        ...context,
        body: redactDiagnostics(body, [certificate]),
      });
      try {
        return await globalThis.fetch(url, options);
      } catch (error) {
        log('agent.transport_failed', {
          ...context,
          responseReceived: false,
          durationMs: Date.now() - startedAt,
          ...errorInfo(error),
        });
        throw error;
      }
    },
  });
  return ({ sessionId, channel, uid, botUid, maxDurationSeconds, tools = [] }) => {
    if (
      typeof uid !== 'string' ||
      typeof botUid !== 'string' ||
      !isAgoraUid(uid) ||
      !isAgoraUid(botUid) ||
      uid === botUid
    ) {
      throw new TypeError('The client and agent must use distinct string accounts.');
    }
    if (!Number.isInteger(maxDurationSeconds) || maxDurationSeconds < 1) {
      throw new TypeError('The cloud agent duration must be a positive number of seconds.');
    }
    const lifetime = Math.min(maxDurationSeconds, 86400);
    // AgentSession 2.12 auto-token generation parses agentUid as an integer.
    // The generated REST client accepts an explicit account token without that conversion.
    const token = () => {
      const value = ConvoAITokenBuilder.buildToken(
        appId,
        certificate,
        channel,
        botUid,
        lifetime,
        lifetime,
      );
      if (!value) throw new Error('The cloud agent token could not be generated.');
      return value;
    };
    const authorization = () => ({ headers: { Authorization: `agora token=${token()}` } });
    const stopAgent = async (id) => {
      try {
        await client.agents.stop({ appid: appId, agentId: id }, authorization());
      } catch (error) {
        if (error.statusCode !== 404) throw error;
      }
    };
    let agentId;
    let uncertainUntil = 0;
    return {
      async getTranscripts() {
        if (!agentId) return [];
        const history = await client.agents.getHistory({ appid: appId, agentId }, authorization());
        return historySnapshot(history.contents);
      },
      async start() {
        const startedAt = Date.now();
        let rtcToken;
        let responseLogged = false;
        log('agent.starting', {
          sessionId,
          channel,
          uid,
          botUid,
          pipelineId,
          area,
          rtm: enableRtm,
          cloudEndpoint: client.getCurrentURL(),
        });
        try {
          rtcToken = token();
          const { data: result, rawResponse } = await client.agents
            .start(
              {
                appid: appId,
                name: `aiui-${sessionId}`,
                pipeline_id: pipelineId,
                properties: {
                  channel,
                  token: rtcToken,
                  agent_rtc_uid: botUid,
                  remote_rtc_uids: [uid],
                  enable_string_uid: true,
                  ...(enableInterruption === undefined
                    ? {}
                    : { interruption: { enable: enableInterruption } }),
                  ...(enableRtm || tools.length
                    ? {
                        advanced_features: {
                          ...(enableRtm ? { enable_rtm: true } : {}),
                          ...(tools.length ? { enable_tools: true } : {}),
                        },
                      }
                    : {}),
                  ...(enableRtm ? { parameters: { data_channel: 'rtm' } } : {}),
                  ...(tools.length ? { llm: { tools } } : {}),
                  ...(asrLanguage ? { asr: { language: asrLanguage } } : {}),
                  idle_timeout: 60,
                },
              },
              { headers: { Authorization: `agora token=${rtcToken}` } },
            )
            .withRawResponse();
          log('agent.start_response', {
            sessionId,
            channel,
            status: rawResponse.status,
            body: redactDiagnostics(result, [certificate, rtcToken]),
            durationMs: Date.now() - startedAt,
          });
          responseLogged = true;
          agentId = result.agent_id;
          if (!agentId) throw new Error('The cloud did not return an agent ID.');
          log('agent.started', {
            sessionId,
            channel,
            uid,
            botUid,
            agentId,
            durationMs: Date.now() - startedAt,
          });
        } catch (error) {
          if (!responseLogged)
            log('agent.start_response', {
              sessionId,
              channel,
              responseReceived: Number.isInteger(error.statusCode),
              status: error.statusCode ?? null,
              body: redactDiagnostics(error.body ?? null, [certificate, rtcToken]),
              ...errorInfo(error),
            });
          log('agent.start_failed', {
            sessionId,
            channel,
            durationMs: Date.now() - startedAt,
            cloudEndpoint: client.getCurrentURL(),
            ...errorInfo(error),
          });
          // A lost HTTP response does not prove that the cloud failed to create the agent.
          uncertainUntil = Date.now() + 60_000;
          throw error;
        }
      },
      async stop() {
        if (!agentId && uncertainUntil) {
          log('agent.reconciling', { sessionId, channel, cloudEndpoint: client.getCurrentURL() });
          try {
            const page = await client.agents.list(
              { appid: appId, channel, state: '0,1,2,3', limit: 100 },
              authorization(),
            );
            for await (const found of page) {
              if (found.agent_id) {
                log('agent.reconcile_found', { sessionId, channel, agentId: found.agent_id });
                await stopAgent(found.agent_id);
              }
            }
          } catch (error) {
            log('agent.reconcile_failed', { sessionId, channel, ...errorInfo(error) });
            throw error;
          }
          // Retain the record for repeated queries while creation may still become visible.
          if (Date.now() < uncertainUntil) {
            const pending = new Error('Cloud start reconciliation is pending.');
            pending.code = 'CLOUD_START_RECONCILIATION_PENDING';
            throw pending;
          }
          uncertainUntil = 0;
        }
        if (!agentId) return;
        log('agent.stopping', { sessionId, channel, agentId });
        // Retain the ID after a failed stop so the reconciler can retry with fresh auth.
        try {
          await stopAgent(agentId);
        } catch (error) {
          log('agent.stop_failed', { sessionId, channel, agentId, ...errorInfo(error) });
          throw error;
        }
        log('agent.stopped', { sessionId, channel, agentId });
        agentId = null;
      },
    };
  };
}
