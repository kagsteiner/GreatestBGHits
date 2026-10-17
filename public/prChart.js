/* Performance rating over time for the play page's match history: one dot
   per match on a true time axis, joined by a line. Plain SVG, styled by the
   page's theme tokens; hovering a match shows its details. */

const SVG_NS = 'http://www.w3.org/2000/svg';
const MARGIN = { top: 14, right: 18, bottom: 30, left: 38 };
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// eXtreme Gammon's labels, as computed on the server (src/playMatch.js).
const PR_LABELS = [
  [2.5, 'Extraterrestrial'], [5, 'World class'], [7.5, 'Expert'], [12.5, 'Advanced'],
  [17.5, 'Intermediate'], [22.5, 'Casual player'], [30, 'Beginner'], [Infinity, 'Awful']
];

function prLabel(value) {
  return PR_LABELS.find(([below]) => value < below)[1];
}

function svg(tag, attributes = {}, parent = null) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, String(value));
  if (parent) parent.appendChild(el);
  return el;
}

/** Round tick steps: hours within two days, then days, weeks and months. */
function timeTicks(start, end, maxTicks) {
  const span = end - start;
  const steps = span < 2 * DAY
    ? [1, 2, 3, 6, 12, 24].map((hours) => hours * HOUR)
    : [1, 2, 7, 14, 30, 61, 91, 182, 365].map((days) => days * DAY);
  const step = steps.find((candidate) => span / candidate <= maxTicks) || steps[steps.length - 1];
  const first = new Date(start);
  if (step >= DAY) first.setHours(0, 0, 0, 0);
  else first.setMinutes(0, 0, 0);
  const ticks = [];
  for (let time = first.getTime(); time <= end; time += step) {
    if (time >= start) ticks.push(time);
  }
  return { ticks, hourly: step < DAY };
}

function prTicks(max) {
  const step = max <= 20 ? 5 : (max <= 50 ? 10 : 20);
  const top = Math.max(step * 2, Math.ceil(max / step) * step);
  const ticks = [];
  for (let value = 0; value <= top; value += step) ticks.push(value);
  return { ticks, top };
}

function formatWhen(time, withTime) {
  const date = new Date(time);
  const day = date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit' });
  return withTime ? `${day} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : day;
}

/**
 * @param {HTMLElement} container
 * @param {Array<{ startedAt: string, pr: number|null, status: string, length: number, plies: number,
 *   score: { you: number, engine: number }, rated: number, flagged: number }>} matches
 */
export function drawPrChart(container, matches) {
  container.replaceChildren();
  const points = matches
    .filter((entry) => entry.pr != null)
    .map((entry) => ({ entry, time: new Date(entry.startedAt).getTime(), pr: entry.pr }))
    .sort((a, b) => a.time - b.time);
  if (!points.length) {
    container.appendChild(Object.assign(document.createElement('p'), {
      className: 'meta', textContent: 'No rated matches yet.'
    }));
    return;
  }

  const width = Math.max(280, container.clientWidth);
  const height = Math.max(200, container.clientHeight);
  const plot = {
    left: MARGIN.left, right: width - MARGIN.right, top: MARGIN.top, bottom: height - MARGIN.bottom
  };

  let start = points[0].time;
  let end = points[points.length - 1].time;
  if (end - start < HOUR) {
    start -= 6 * HOUR;
    end += 6 * HOUR;
  } else {
    const pad = (end - start) * 0.04;
    start -= pad;
    end += pad;
  }
  const { ticks: yTicks, top } = prTicks(Math.max(...points.map((point) => point.pr)));
  const x = (time) => plot.left + ((time - start) / (end - start)) * (plot.right - plot.left);
  const y = (value) => plot.bottom - (value / top) * (plot.bottom - plot.top);

  const chart = svg('svg', {
    viewBox: `0 0 ${width} ${height}`, width, height, role: 'img',
    'aria-label': `Performance rating of ${points.length} matches over time`
  }, container);

  // Recessive grid and axes.
  for (const value of yTicks) {
    svg('line', { x1: plot.left, x2: plot.right, y1: y(value), y2: y(value), class: 'pr-grid' }, chart);
    svg('text', { x: plot.left - 8, y: y(value), class: 'pr-axis', 'text-anchor': 'end', 'dominant-baseline': 'middle' }, chart)
      .textContent = String(value);
  }
  const { ticks: xTicks, hourly } = timeTicks(start, end, Math.max(2, Math.floor((plot.right - plot.left) / 70)));
  for (const time of xTicks) {
    svg('line', { x1: x(time), x2: x(time), y1: plot.bottom, y2: plot.bottom + 4, class: 'pr-grid' }, chart);
    svg('text', { x: x(time), y: plot.bottom + 18, class: 'pr-axis', 'text-anchor': 'middle' }, chart)
      .textContent = hourly ? new Date(time).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : formatWhen(time, false);
  }

  // The line, then the dots on top with a ring in the surface color.
  if (points.length > 1) {
    svg('path', {
      d: points.map((point, index) => `${index ? 'L' : 'M'}${x(point.time).toFixed(1)},${y(point.pr).toFixed(1)}`).join(' '),
      class: 'pr-line'
    }, chart);
  }
  const crosshair = svg('line', { y1: plot.top, y2: plot.bottom, class: 'pr-crosshair', visibility: 'hidden' }, chart);
  const dots = points.map((point) => svg('circle', {
    cx: x(point.time), cy: y(point.pr), r: 5,
    class: point.entry.status === 'finished' ? 'pr-dot' : 'pr-dot pr-dot-unfinished'
  }, chart));

  // Hover: the match nearest to the pointer, with a crosshair and a tooltip.
  const tooltip = document.createElement('div');
  tooltip.className = 'pr-tooltip';
  tooltip.hidden = true;
  container.appendChild(tooltip);
  const show = (index) => {
    const point = points[index];
    const { entry } = point;
    dots.forEach((dot, dotIndex) => dot.classList.toggle('pr-dot-active', dotIndex === index));
    crosshair.setAttribute('x1', x(point.time));
    crosshair.setAttribute('x2', x(point.time));
    crosshair.setAttribute('visibility', 'visible');
    const status = entry.status === 'finished'
      ? (entry.score.you > entry.score.engine ? 'won' : 'lost')
      : 'unfinished';
    tooltip.replaceChildren();
    const value = document.createElement('strong');
    value.textContent = `PR ${point.pr.toFixed(1)}`;
    tooltip.append(value, ` ${prLabel(point.pr)}`);
    for (const line of [
      formatWhen(point.time, true),
      `${entry.length}-point match, ${entry.plies}-ply, ${status} ${entry.score.you}:${entry.score.engine}`,
      `${entry.flagged} flagged of ${entry.rated} decisions`
    ]) {
      const row = document.createElement('div');
      row.textContent = line;
      tooltip.appendChild(row);
    }
    tooltip.hidden = false;
    const left = x(point.time) + 12;
    const flip = left + tooltip.offsetWidth > width;
    tooltip.style.left = `${flip ? x(point.time) - 12 - tooltip.offsetWidth : left}px`;
    tooltip.style.top = `${Math.max(0, Math.min(y(point.pr) - tooltip.offsetHeight / 2, height - tooltip.offsetHeight))}px`;
  };
  const hide = () => {
    tooltip.hidden = true;
    crosshair.setAttribute('visibility', 'hidden');
    dots.forEach((dot) => dot.classList.remove('pr-dot-active'));
  };
  chart.addEventListener('pointermove', (event) => {
    const box = chart.getBoundingClientRect();
    const pointerX = ((event.clientX - box.left) / box.width) * width;
    let nearest = 0;
    points.forEach((point, index) => {
      if (Math.abs(x(point.time) - pointerX) < Math.abs(x(points[nearest].time) - pointerX)) nearest = index;
    });
    show(nearest);
  });
  chart.addEventListener('pointerleave', hide);
}
