import { clamp } from './numbers.js';

export function scale(value, factor) {
  return clamp(value * factor, 0, 100);
}
