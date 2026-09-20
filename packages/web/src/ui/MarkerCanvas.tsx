import type { MouseEvent, ReactNode } from 'react';

export interface Marker { x: number; y: number; note: string }

// An image you can point at. Marker positions are fractions of the image, so they are data and need an inline style.
export function MarkerCanvas({ src, markers, onAdd }: { src: string; markers: Marker[]; onAdd?: (marker: Marker) => void }) {
  // A click places the marker where it landed; pressed from the keyboard there is no such place, so it goes in the middle.
  const place = (event: MouseEvent<HTMLButtonElement>) => {
    const box = event.currentTarget.getBoundingClientRect(), pointed = event.detail > 0;
    onAdd?.({ x: pointed ? (event.clientX - box.left) / box.width : 0.5, y: pointed ? (event.clientY - box.top) / box.height : 0.5, note: '' });
  };
  const frame = (children: ReactNode) => (onAdd
    ? <button type="button" onClick={place} aria-label="Mark a spot on the snapshot" className="relative inline-block cursor-crosshair border-0 bg-transparent p-0">{children}</button>
    : <div className="relative inline-block">{children}</div>);
  return frame(
    <>
      <img src={src} alt="Product snapshot" className="block max-h-120 max-w-full rounded-control border border-line-strong" />
      {markers.map((marker, index) => (
        <span key={index} className="absolute flex size-5.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-pill border-2 border-ground bg-stop text-caption font-semibold text-ink" style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }}>{index + 1}</span>
      ))}
    </>,
  );
}
