import { useCallback, useEffect, useRef, useState } from 'react';

// Speech in and out with what the browser itself offers: nothing is installed and no key is needed.
// Where the browser cannot listen (some cannot), `canListen` is false and the panel stays a typed conversation.
interface Recognition { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; abort(): void; onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onend: (() => void) | null; onerror: ((event: { error: string }) => void) | null }
const Listener = (): (new () => Recognition) | null => { const scope = window as unknown as Record<string, unknown>; return (scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null) as (new () => Recognition) | null; };

export function useVoice(onHeard: (text: string) => void) {
  const [listening, setListening] = useState(false), [hearing, setHearing] = useState(''), [problem, setProblem] = useState<string | null>(null);
  const active = useRef<Recognition | null>(null), heard = useRef(onHeard);
  heard.current = onHeard;
  const canListen = typeof window !== 'undefined' && Listener() !== null, canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;

  const stop = useCallback(() => { active.current?.abort(); active.current = null; setListening(false); setHearing(''); }, []);
  const listen = useCallback(() => {
    const Make = Listener();
    if (!Make || active.current) return;
    window.speechSynthesis?.cancel();
    const recognition = new Make();
    recognition.lang = navigator.language; recognition.interimResults = true; recognition.continuous = false;
    let said = '';
    recognition.onresult = event => { const parts = Array.from(event.results); said = parts.map(part => part[0]?.transcript ?? '').join(' ').trim(); setHearing(said); };
    recognition.onerror = event => { if (event.error !== 'no-speech' && event.error !== 'aborted') setProblem(event.error === 'not-allowed' ? 'The browser was not allowed to use the microphone.' : 'Listening stopped; try again.'); };
    recognition.onend = () => { active.current = null; setListening(false); setHearing(''); if (said) heard.current(said); };
    active.current = recognition; setProblem(null); setListening(true);
    recognition.start();
  }, []);
  // Read aloud, and say when it is over, so a spoken conversation can take turns.
  const speak = useCallback((text: string, after?: () => void) => {
    if (!canSpeak) { after?.(); return; }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text.replace(/[*_`#>]/g, ''));
    utterance.lang = navigator.language; utterance.rate = 1.05;
    utterance.onend = () => after?.(); utterance.onerror = () => after?.();
    window.speechSynthesis.speak(utterance);
  }, [canSpeak]);
  const hush = useCallback(() => { if (canSpeak) window.speechSynthesis.cancel(); }, [canSpeak]);
  useEffect(() => () => { active.current?.abort(); if (canSpeak) window.speechSynthesis.cancel(); }, [canSpeak]);
  return { canListen, canSpeak, listening, hearing, problem, listen, stop, speak, hush };
}
