import { motionQuery } from './settings';

/** The stamp thump. Skipped (final look only) when the player prefers reduced motion. */
export function playStamp(node: HTMLElement): void {
  if (motionQuery.matches) return;
  node.classList.remove('play'); void node.offsetWidth; node.classList.add('play');
}
