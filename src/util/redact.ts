/**
 * Best-effort secret masking for persisted free-text.
 *
 * This is a mitigation, not a guarantee: it recognises common credential
 * shapes and nothing more. The hard controls are filesystem permissions
 * (~/.resurge is 0700, files 0600) and --no-store-output. Both are documented
 * as such in the README so nobody mistakes this for confidentiality.
 */
const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g },
  { name: 'aws-key-id', re: /\bAKIA[0-9A-Z]{12,}/g },
  { name: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'google-key', re: /\bAIza[0-9A-Za-z_-]{20,}/g },
  {
    name: 'auth-header',
    re: /\b(authorization|proxy-authorization)\s*:\s*\S+/gi,
  },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi },
  {
    name: 'private-key',
    re: /-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g,
  },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    name: 'assignment',
    re: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY)[A-Z0-9_]*)\s*[:=]\s*("[^"]+"|'[^']+'|\S+)/gi,
  },
];

export function redact(text: string): string {
  let out = text;
  for (const { name, re } of PATTERNS) {
    out = out.replace(re, (match, ...groups) => {
      if (name === 'assignment' && typeof groups[0] === 'string') {
        return `${groups[0]}=[REDACTED]`;
      }
      if (name === 'auth-header') {
        const key = match.split(':')[0];
        return `${key}: [REDACTED]`;
      }
      return '[REDACTED]';
    });
  }
  return out;
}

export function redactOptional(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  return redact(text);
}
