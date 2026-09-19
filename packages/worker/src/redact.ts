// Nothing a worker uploads may carry one of its secrets: step titles, details, diffs, outputs and summaries pass through here first.
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|PRIVATE|API_?KEY|ACCESS_?KEY|_KEY$|^KEY$|AUTH|COOKIE|SESSION|DSN|DATABASE_URL|CONNECTION_STRING)/i;
// Short values are left alone: replacing every "1" or "true" would destroy the text and hide nothing.
const MIN_LENGTH = 6;
const MARK = '[redacted]';

// Shapes that are secrets wherever they come from: forge and chat tokens, model and cloud keys, bearer headers, signed web tokens, private key blocks, passwords in addresses.
const PATTERNS: readonly RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_\w{20,}\b/g,
  /\bglpat-[\w-]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /(?<=:\/\/[^\s/:@]+:)[^\s/@]{3,}(?=@)/g,
];

export type Redactor = (text: string) => string;

export function createRedactor(env: NodeJS.ProcessEnv, extra: readonly string[] = []): Redactor {
  const values = [...new Set([...Object.entries(env).filter(([name, value]) => SECRET_NAME.test(name) && (value?.length ?? 0) >= MIN_LENGTH).map(([, value]) => value!), ...extra.filter(value => value.length >= MIN_LENGTH)])]
    // Longest first, so a secret that contains another is removed whole.
    .sort((a, b) => b.length - a.length);
  return text => {
    let clean = text;
    for (const value of values) clean = clean.split(value).join(MARK);
    for (const pattern of PATTERNS) clean = clean.replace(pattern, MARK);
    return clean;
  };
}

// Clips to a byte budget on a character boundary and says whether anything was cut.
export function clipBytes(text: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= limit) return { text, truncated: false };
  let clipped = Buffer.from(text).subarray(0, limit).toString('utf8');
  if (clipped.endsWith('�')) clipped = clipped.slice(0, -1);
  return { text: clipped, truncated: true };
}
