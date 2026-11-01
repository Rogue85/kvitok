// Theme toggle: the choice is remembered; without one the page follows the system.
const root = document.documentElement;
const dark = window.matchMedia('(prefers-color-scheme: dark)');

document.getElementById('theme').addEventListener('click', () => {
  const current = root.dataset.theme ?? (dark.matches ? 'dark' : 'light');
  const next = current === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try {
    localStorage.setItem('kvitok-theme', next);
  } catch {}
});

// Tabs in "Get started".
const tabs = [...document.querySelectorAll('[role="tab"]')];
for (const tab of tabs) {
  tab.addEventListener('click', () => {
    for (const other of tabs) {
      const selected = other === tab;
      other.setAttribute('aria-selected', String(selected));
      document.getElementById(other.getAttribute('aria-controls')).hidden = !selected;
    }
  });
}

// A copy button on every code block.
const copyIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const doneIcon =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

for (const block of document.querySelectorAll('.code')) {
  const button = document.createElement('button');
  button.className = 'copy';
  button.type = 'button';
  button.setAttribute('aria-label', 'Copy');
  button.innerHTML = copyIcon;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(block.querySelector('pre').textContent);
      button.innerHTML = doneIcon;
      setTimeout(() => (button.innerHTML = copyIcon), 1500);
    } catch {}
  });
  block.append(button);
}
