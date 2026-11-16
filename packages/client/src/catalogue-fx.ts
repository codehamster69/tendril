/** The stamp thump. Skipped (final look only) when the player prefers reduced motion. */
export function playStamp(node: HTMLElement): void {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  node.classList.remove('play'); void node.offsetWidth; node.classList.add('play');
}
