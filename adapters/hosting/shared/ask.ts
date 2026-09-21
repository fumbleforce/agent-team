import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

// Questions go to the terminal; a secret is typed without being shown. Without a terminal nothing is asked and flags decide.
export type Ask = (question: string, options?: { fallback?: string; secret?: boolean }) => Promise<string>;
export function terminalAsk(input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): Ask | null {
  if (!input.isTTY) return null;
  return async (question, { fallback = '', secret = false } = {}) => {
    let muted = false;
    const shown = new Writable({ write(chunk, _encoding, done) { if (!muted) output.write(chunk); done(); } });
    const lines = createInterface({ input, output: shown, terminal: true });
    try {
      // A yes/no question already shows its default as the capital letter.
      const pending = lines.question(`${question}${fallback && !/\([Yy]\/[Nn]\)$/.test(question) ? ` [${fallback}]` : ''}: `);
      muted = secret;
      const answer = (await pending).trim();
      if (secret) output.write('\n');
      return answer || fallback;
    } finally { lines.close(); }
  };
}

export const yes = (answer: string) => /^y(es)?$/i.test(answer);
