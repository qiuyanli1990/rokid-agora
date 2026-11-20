import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  createDiagnosticLogger,
  errorInfo,
  redactDiagnostics,
} from '../examples/server/logging.js';
import { createSessionService } from '../examples/server/sessions.js';
import { bearerAuthorizer, createVoiceHandler } from '../examples/server/http.js';
import { createAgoraAgentFactory } from '../examples/server/agora.js';

test('diagnostic logs redact credentials and tolerate a failed sink', () => {
  const lines = [];
  createDiagnosticLogger((line) => lines.push(line))('test', {
    channel: 'test-channel',
    token: 'private-token',
    nested: { Authorization: 'Bearer private-auth', appCertificate: 'private-certificate' },
  });
  const logged = JSON.parse(lines[0]);
  assert.equal(logged.channel, 'test-channel');
  assert.equal(logged.token, '[REDACTED]');
  assert(!lines[0].includes('private-'));
  assert.doesNotThrow(() =>
    createDiagnosticLogger(() => {
      throw new Error('sink unavailable');
    })('test'),
  );
});

test('upstream errors expose status and stable codes without message or response bodies', () => {
  const error = Object.assign(new Error('private-message'), {
    code: 'UPSTREAM_FAILED',
    statusCode: 502,
    body: { token: 'private-token' },
  });
  assert.deepEqual(errorInfo(error), {
    errorType: 'Error',
    upstreamStatus: 502,
    errorCode: 'UPSTREAM_FAILED',
  });
  assert(!JSON.stringify(errorInfo(error)).includes('private-'));
  assert.equal(errorInfo({ code: 'Bearer private-token' }).errorCode, undefined);
});

test('session lifecycle logs correlate channel and participants without reservation credentials', async () => {
  const lines = [];
  const store = createSessionService({
    appId: '1'.repeat(32),
    certificate: '2'.repeat(32),
    baseURL: 'https://whip.example.test',
    createAgent: () => ({ async start() {}, async stop() {} }),
    log: createDiagnosticLogger((line) => lines.push(JSON.parse(line))),
  });
  const reservation = store.createSession('test-owner');
  await store.startAgent(reservation.id, 'test-owner');
  await store.stopSession(reservation.id, 'test-owner');
  assert.deepEqual(
    lines.map((line) => line.event),
    ['session.created', 'session.starting', 'session.started', 'session.stopped'],
  );
  assert.equal(lines[0].sessionId, reservation.id);
  assert.equal(lines[0].channel, reservation.whip.channel);
  assert.equal(lines[0].uid, reservation.rtm.userId);
  assert.equal(lines[0].botUid, reservation.rtm.agentUserId);
  assert(!JSON.stringify(lines).includes(reservation.whip.token));
  assert(!JSON.stringify(lines).includes(reservation.rtm.token));
});

test('HTTP diagnostics log correlated response errors without headers or query strings', async () => {
  const lines = [];
  const handler = createVoiceHandler({
    service: {},
    authorize: bearerAuthorizer('expected-test-token-with-enough-characters'),
    log: createDiagnosticLogger((line) => lines.push(JSON.parse(line))),
  });
  const request = Object.assign(new EventEmitter(), {
    method: 'POST',
    url: '/voice/sessions?token=private-query',
    headers: { authorization: 'Bearer private-header' },
    complete: true,
  });
  const response = Object.assign(new EventEmitter(), {
    setHeader() {},
    writeHead(status) {
      this.statusCode = status;
    },
    end() {
      this.writableEnded = true;
      this.emit('finish');
    },
  });
  await handler(request, response);
  const incoming = lines.find((line) => line.event === 'http.request');
  const outgoing = lines.find((line) => line.event === 'http.response');
  assert.equal(incoming.route, '/voice/sessions');
  assert.equal(outgoing.status, 401);
  assert.equal(outgoing.error, 'UNAUTHORIZED');
  assert.equal(incoming.requestId, outgoing.requestId);
  assert(!JSON.stringify(lines).includes('private-'));
});

test('cloud lifecycle diagnostics include the returned agent ID and matching channel', async (t) => {
  const lines = [];
  t.mock.method(globalThis, 'fetch', async () => Response.json({ agent_id: 'test-cloud-agent' }));
  const factory = createAgoraAgentFactory({
    appId: '1'.repeat(32),
    certificate: '2'.repeat(32),
    pipelineId: 'test-pipeline',
    log: createDiagnosticLogger((line) => lines.push(JSON.parse(line))),
  });
  const agent = factory({
    sessionId: 'test-session',
    channel: 'test-channel',
    uid: 'test-user',
    botUid: 'test-bot',
    maxDurationSeconds: 60,
  });
  await agent.start();
  await agent.stop();
  assert.deepEqual(
    lines.map((line) => line.event),
    [
      'agent.starting',
      'agent.http_request',
      'agent.start_response',
      'agent.started',
      'agent.stopping',
      'agent.stopped',
    ],
  );
  const started = lines.find((line) => line.event === 'agent.started');
  assert.equal(started.agentId, 'test-cloud-agent');
  assert.equal(started.channel, 'test-channel');
  assert.equal(started.uid, 'test-user');
  assert.equal(started.botUid, 'test-bot');
  const request = lines.find((line) => line.event === 'agent.http_request');
  assert.match(request.url, /\/api\/conversational-ai-agent\/v2\/projects\/1{32}\/join$/);
  assert.equal(request.method, 'POST');
  assert.equal(request.body.name, 'aiui-test-session');
  assert.equal(request.body.properties.token, '[REDACTED]');
  assert.equal(request.body.appid, undefined);
  const response = lines.find((line) => line.event === 'agent.start_response');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { agent_id: 'test-cloud-agent' });
  assert(!JSON.stringify(lines).includes('agora token='));
  assert(!JSON.stringify(lines).includes('2'.repeat(32)));
});

test('diagnostic values redact credentials embedded in upstream message strings', () => {
  const safe = redactDiagnostics(
    {
      reason: 'Denied',
      detail: 'private-certificate Bearer private-auth agora token=private-auth',
      token: 'private-response-token',
    },
    ['private-certificate', 'private-auth'],
  );
  assert.equal(safe.reason, 'Denied');
  assert(!JSON.stringify(safe).includes('private-'));
});

test('cloud error diagnostics preserve the actual HTTP status and redacted response body', async (t) => {
  const lines = [];
  let sentToken;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    sentToken = JSON.parse(options.body).properties.token;
    return Response.json(
      {
        reason: 'TEST_REJECTED',
        detail: `Rejected ${options.headers.Authorization}`,
        token: 'private-response-token',
      },
      { status: 401 },
    );
  });
  const factory = createAgoraAgentFactory({
    appId: '1'.repeat(32),
    certificate: '2'.repeat(32),
    pipelineId: 'test-pipeline',
    log: createDiagnosticLogger((line) => lines.push(JSON.parse(line))),
  });
  const agent = factory({
    sessionId: 'failed-session',
    channel: 'test-channel',
    uid: 'user',
    botUid: 'bot',
    maxDurationSeconds: 60,
  });
  await assert.rejects(agent.start(), { statusCode: 401 });
  const response = lines.find((line) => line.event === 'agent.start_response');
  assert.equal(response.status, 401);
  assert.equal(response.responseReceived, true);
  assert.equal(response.body.reason, 'TEST_REJECTED');
  assert(!JSON.stringify(lines).includes('private-response-token'));
  assert(!JSON.stringify(lines).includes(sentToken));
});

test('transport failure diagnostics capture the native cause and distinguish a missing response', async (t) => {
  const lines = [];
  t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
  });
  const factory = createAgoraAgentFactory({
    appId: '1'.repeat(32),
    certificate: '2'.repeat(32),
    pipelineId: 'test-pipeline',
    log: createDiagnosticLogger((line) => lines.push(JSON.parse(line))),
  });
  const agent = factory({
    sessionId: 'failed-session',
    channel: 'test-channel',
    uid: 'user',
    botUid: 'bot',
    maxDurationSeconds: 60,
  });
  await assert.rejects(agent.start());
  const transport = lines.find((line) => line.event === 'agent.transport_failed');
  assert.equal(transport.causeCode, 'UND_ERR_CONNECT_TIMEOUT');
  assert.equal(transport.responseReceived, false);
  const response = lines.find((line) => line.event === 'agent.start_response');
  assert.equal(response.status, null);
  assert.equal(response.body, null);
  assert.equal(response.responseReceived, false);
});
