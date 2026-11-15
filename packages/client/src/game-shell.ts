/** Navigation for the living-island shell; delegates to the existing game controls. */
export function mountGameShell(): void {
  const rail = document.getElementById('game-rail');
  if (!rail) return;
  const mode = new URLSearchParams(location.search).get('mode');
  const modeSection = mode === 'campaign' ? 'campaign' : mode === 'daily' || mode === 'challenge' ? 'arena' : null;
  const markCurrent = (tab: string | null) => {
    for (const item of rail.querySelectorAll<HTMLElement>('[data-shell-tab], [data-shell-mode]')) {
      const current = tab ? item.dataset.shellTab === tab : item.dataset.shellMode === modeSection;
      if (current) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    }
  };
  markCurrent(modeSection ? null : 'farm');
  for (const item of rail.querySelectorAll<HTMLButtonElement>('[data-shell-tab]')) {
    item.addEventListener('click', () => {
      const tab = document.getElementById(`tab-${item.dataset.shellTab}`);
      tab?.click();
      tab?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      tab?.focus({ preventScroll: true });
    });
  }
  for (const tab of document.querySelectorAll<HTMLButtonElement>('.deck-tabs [data-tab]')) {
    tab.addEventListener('click', () => markCurrent(tab.dataset.tab ?? 'farm'));
  }
  document.getElementById('shell-field-guide')?.addEventListener('click', () => {
    document.getElementById('btn-reference')?.click();
  });
}
