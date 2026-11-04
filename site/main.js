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

// The animated demo in the hero. A ticket is replayed on one clock: every element of the window
// says when it appears (data-show, data-hide), types its text (data-type="start,duration"), counts
// (data-count="from,to,start,duration") or gets a class (data-on="class@start[-end],…"). The state
// is a function of the time, so the steps can jump back and forth.
const demo = document.querySelector('.demo');
if (demo) runDemo(demo);

function runDemo(demo) {
  const END = 25000;
  const LOOP = 26000;
  const win = demo.querySelector('.dm-window');
  const thread = demo.querySelector('.dm-thread');
  const cursor = demo.querySelector('.dm-cursor');
  const caption = demo.querySelector('.dm-caption');
  const toggle = demo.querySelector('.dm-toggle');
  const steps = [...demo.querySelectorAll('[data-step]')].map((button) => ({
    button,
    from: Number(button.dataset.step),
    text: `<b>${button.querySelector('b').textContent}.</b> ${button.querySelector('span').textContent}`,
  }));
  steps.forEach((step, i) => (step.to = steps[i + 1]?.from ?? END));

  const nums = (value) => value.split(',').map(Number);
  const clamp = (x) => Math.min(1, Math.max(0, x));
  const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
  // Numbers and the pause button follow the page's language.
  const format = (n) => Math.round(n).toLocaleString(document.documentElement.lang || 'en');

  const shown = [...win.querySelectorAll('[data-show], [data-hide]')].map((el) => ({
    el,
    show: el.dataset.show ? Number(el.dataset.show) : -Infinity,
    hide: el.dataset.hide ? Number(el.dataset.hide) : Infinity,
  }));
  const typed = [...win.querySelectorAll('[data-type]')].map((el) => {
    const [start, duration] = nums(el.dataset.type);
    return { el, start, duration, text: el.textContent.trim() };
  });
  const counted = [...win.querySelectorAll('[data-count]')].map((el) => {
    const [from, to, start, duration] = nums(el.dataset.count);
    return { el, from, to, start, duration };
  });
  const classed = [...win.querySelectorAll('[data-on]')].flatMap((el) =>
    el.dataset.on.split(',').map((rule) => {
      const [name, span] = rule.split('@');
      const [from, to] = span.split('-').map(Number);
      return { el, name, from, to: to ?? Infinity };
    }),
  );

  // The pointer moves to a target over a duration and clicks at given times.
  const pointer = {
    from: 14900,
    to: 21800,
    moves: [
      { at: 14900, duration: 0, target: '.dm-thread', x: 0.75, y: 0.6 },
      { at: 15200, duration: 1000, target: '[data-target="approve"]' },
      { at: 19800, duration: 1000, target: '[data-target="send"]' },
    ],
    clicks: [16300, 21000],
  };
  const lastPoint = new Map();
  function pointOf(move) {
    const el = win.querySelector(move.target);
    const rect = el.getBoundingClientRect();
    const origin = win.getBoundingClientRect();
    // A hidden target keeps the point it had when it was last seen.
    if (rect.width) {
      lastPoint.set(move, {
        x: rect.left - origin.left + rect.width * (move.x ?? 0.5),
        y: rect.top - origin.top + rect.height * (move.y ?? 0.6),
      });
    }
    return lastPoint.get(move) ?? { x: origin.width / 2, y: origin.height / 2 };
  }

  function render(t, jump) {
    for (const { el, show, hide } of shown) {
      const hidden = !(t >= show && t < hide);
      if (el.hidden !== hidden) el.hidden = hidden;
    }
    for (const { el, start, duration, text } of typed) {
      const p = clamp((t - start) / duration);
      const value = text.slice(0, Math.round(p * text.length));
      if (el.textContent !== value) el.textContent = value;
      el.classList.toggle('typing', p > 0 && p < 1);
    }
    for (const { el, from, to, start, duration } of counted) {
      const value = format(from + (to - from) * ease(clamp((t - start) / duration)));
      if (el.textContent !== value) el.textContent = value;
    }
    for (const { el, name, from, to } of classed) el.classList.toggle(name, t >= from && t < to);

    const current = steps.findLastIndex((step) => t >= step.from);
    steps.forEach((step, i) => {
      step.button.classList.toggle('active', i === current);
      step.button.classList.toggle('done', i < current);
      step.button.style.setProperty('--p', i === current ? clamp((t - step.from) / (step.to - step.from)) : 0);
    });
    if (caption.dataset.step !== String(current)) {
      caption.dataset.step = String(current);
      caption.innerHTML = steps[current].text;
    }

    const visible = t >= pointer.from && t < pointer.to;
    cursor.classList.toggle('show', visible);
    if (visible) {
      let at = pointOf(pointer.moves[0]);
      for (let i = 1; i < pointer.moves.length; i++) {
        const move = pointer.moves[i];
        if (t < move.at) break;
        const p = ease(clamp((t - move.at) / move.duration));
        const to = pointOf(move);
        at = { x: at.x + (to.x - at.x) * p, y: at.y + (to.y - at.y) * p };
      }
      cursor.style.transform = `translate(${at.x}px, ${at.y}px)`;
    }
    cursor.classList.toggle(
      'press',
      pointer.clicks.some((click) => t >= click && t < click + 300),
    );

    // The thread follows its newest message, smoothly while playing.
    const bottom = thread.scrollHeight - thread.clientHeight;
    if (jump) thread.scrollTop = bottom;
    else if (Math.abs(bottom - thread.scrollTop) > 0.5) thread.scrollTop += (bottom - thread.scrollTop) * 0.12;

    win.classList.toggle('ending', t > END + 400);
  }

  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let t = still ? END : 0;
  let paused = still;
  let inView = false;
  let last = performance.now();

  function setPaused(value) {
    paused = value;
    toggle.setAttribute('aria-pressed', String(paused));
    toggle.querySelector('span').textContent = paused ? toggle.dataset.play : toggle.dataset.pause;
  }
  setPaused(still);
  if (still) toggle.hidden = true;

  toggle.addEventListener('click', () => setPaused(!paused));
  for (const step of steps) {
    step.button.addEventListener('click', () => {
      // Without motion a step shows its final state; otherwise it plays from its start.
      t = still ? step.to - 1 : step.from;
      render(t, true);
      if (!still) setPaused(false);
    });
  }

  new IntersectionObserver(([entry]) => (inView = entry.isIntersecting), { threshold: 0.25 }).observe(win);

  render(t, true);
  function frame(now) {
    const dt = Math.min(now - last, 100);
    last = now;
    if (!paused && inView && !document.hidden) {
      t += dt;
      const looped = t >= LOOP;
      if (looped) t = 0;
      render(t, looped);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
