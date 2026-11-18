import pino, { type Logger } from 'pino';

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /sk-or-v1-[A-Za-z0-9]{16,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /nvapi-[A-Za-z0-9_-]{16,}/g,
  /gsk_[A-Za-z0-9]{16,}/g,
  /hf_[A-Za-z0-9]{16,}/g,
  /ur_live_[A-Za-z0-9_-]{16,}/g,
  /([?&](?:key|api_key|token|secret)=)[^&\s"']+/gi,
];

export function redactSecrets(input: string, knownSecrets: string[] = []): string {
  let output = input;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 6) {
      output = output.split(secret).join('[REDACTED]');
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, (match, prefix) => {
      if (typeof prefix === 'string' && prefix.length > 0) {
        return `${prefix}[REDACTED]`;
      }
      if (match.toLowerCase().startsWith('bearer ')) {
        return 'Bearer [REDACTED]';
      }
      return '[REDACTED]';
    });
  }
  return output;
}

export function createLogger(level: string = 'info'): Logger {
  return pino({
    level,
    base: {
      service: 'ujjwalrouter',
    },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-api-key"]',
        'req.headers["x-goog-api-key"]',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.apiKey',
        '*.api_key',
        '*.token',
        '*.secret',
        '*.password',
        '*.authorization',
        'headers.authorization',
        'headers["x-goog-api-key"]',
      ],
      censor: '[REDACTED]',
    },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  });
}
