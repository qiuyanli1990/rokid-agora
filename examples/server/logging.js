function errorSummary(error) {
  const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
  if (/timeout|timed out/.test(message) || /timeout/i.test(error?.constructor?.name || ''))
    return 'The upstream request timed out.';
  if (message.includes('fetch failed'))
    return 'The network request failed before an HTTP response was received.';
  if (message.includes('query all dns failed')) return 'Cloud endpoint DNS lookup failed.';
  if (message.includes('reconciliation is pending'))
    return 'Cloud start is uncertain; cleanup reconciliation is still pending.';
  if (message.includes('did not return an agent id')) return 'Cloud response has no agent ID.';
  if (message.includes('aborted a request')) return 'The upstream request was aborted.';
}

/** Classify errors without copying credential-bearing SDK messages or response bodies. */
export function errorInfo(error) {
  const summary = errorSummary(error);
  let cause = error?.cause;
  let causeCode;
  for (let depth = 0; cause && depth < 4; depth++, cause = cause.cause) {
    if (typeof cause.code === 'string' && /^[A-Z][A-Z_0-9]{0,63}$/.test(cause.code)) {
      causeCode = cause.code;
      break;
    }
  }
  return {
    errorType: typeof error?.name === 'string' ? error.name : 'Error',
    ...(error?.constructor?.name && error.constructor.name !== error.name
      ? { errorClass: error.constructor.name }
      : {}),
    ...(summary ? { errorSummary: summary } : {}),
    ...(causeCode ? { causeCode } : {}),
    ...(Number.isInteger(error?.statusCode ?? error?.status)
      ? { upstreamStatus: error.statusCode ?? error.status }
      : {}),
    ...(typeof error?.code === 'string' && /^[A-Z][A-Z_0-9]{0,63}$/.test(error.code)
      ? { errorCode: error.code }
      : {}),
  };
}

export function redactDiagnostics(value, secrets = []) {
  const text = JSON.stringify(value, (key, item) => {
    if (/authorization|certificate|secret|token|password|api.?key/i.test(key)) return '[REDACTED]';
    if (typeof item !== 'string') return item;
    for (const secret of secrets) {
      if (typeof secret === 'string' && secret.length > 0)
        item = item.split(secret).join('[REDACTED]');
    }
    return item.replace(/\b(Bearer\s+|agora\s+token=)[^\s"'<>]+/gi, '$1[REDACTED]');
  });
  return text === undefined ? null : JSON.parse(text);
}

export function createDiagnosticLogger(write = (line) => console.log(line)) {
  return (event, fields = {}) => {
    try {
      const line = JSON.stringify(
        { time: new Date().toISOString(), event, ...fields },
        (key, value) =>
          /authorization|certificate|secret|token|password|api.?key/i.test(key)
            ? '[REDACTED]'
            : value,
      );
      write(line);
    } catch {
      // A failed log sink must not interrupt session cleanup or cloud operations.
    }
  };
}
