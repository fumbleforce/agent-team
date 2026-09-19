import type { MouseEvent } from 'react';

export interface Marker { x: number; y: number; note: string }

// An image you can point at. Marker positions are fractions of the image, so they are data and need an inline style.
export function MarkerCanvas({ src, markers, onAdd }: { src: string; markers: Marker[]; onAdd?: (marker: Marker) => void }) {
  const place = (event: MouseEvent<HTMLDivElement>) => {
    if (!onAdd) return;
    const box = event.currentTarget.getBoundingClientRect();
    onAdd({ x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height, note: '' });
  };
  return (
    <div className={onAdd ? 'relative inline-block cursor-crosshair' : 'relative inline-block'} onClick={place} role={onAdd ? 'button' : undefined} aria-label={onAdd ? 'Click to mark a spot' : undefined}>
      <img src={src} alt="Product snapshot" className="block max-h-120 max-w-full rounded-control border border-line-strong" />
      {markers.map((marker, index) => (
        <span key={index} className="absolute flex size-5.5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-pill border-2 border-ground bg-stop text-caption font-semibold text-ink" style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }}>{index + 1}</span>
      ))}
    </div>
  );
}
