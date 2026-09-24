// A clean off-screen drag-image chip (shared by the tree's member drag and the KPI-group drag).
// Must be in the DOM (off-screen) at setDragImage() snapshot time; the caller removes it on dragend.
export function makeDragChip(text: string): HTMLElement {
  const chip = document.createElement('div');
  chip.textContent = text;
  chip.style.cssText = [
    'position:fixed', 'top:-1000px', 'left:-1000px', 'pointer-events:none',
    'padding:6px 12px', 'background:#0066cc', 'color:#fff',
    'font:500 12px/1.2 system-ui,-apple-system,sans-serif',
    'border-radius:6px', 'box-shadow:0 4px 14px rgba(0,0,0,0.25)', 'white-space:nowrap',
  ].join(';');
  return chip;
}
