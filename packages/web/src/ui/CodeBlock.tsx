import { useState } from 'react';
import { Button } from './Button';

// Text to copy into a terminal, with a button that does it.
export function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); };
  return (
    <div className="flex items-start gap-2 rounded-control border border-line bg-ground px-3 py-2.5">
      <pre className="m-0 min-w-0 grow overflow-x-auto font-mono text-small whitespace-pre text-ink-soft">{text}</pre>
      <Button size="sm" onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
    </div>
  );
}
