// Something is happening right now. Used beside a sentence that says what.
export function Spinner() {
  return <span role="status" aria-label="Working" className="inline-block size-3 shrink-0 animate-spin rounded-pill border-2 border-line-strong border-t-accent" />;
}
