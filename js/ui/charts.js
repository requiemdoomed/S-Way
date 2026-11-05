/**
 * Chart.js (vendored, served from this site) with the S-Way palette.
 * Charts only ever display measurements computed from the user's documents.
 */
let loading;
const live = new Set();

function loadChartJs() {
  loading ??= new Promise((resolve, reject) => {
    if (globalThis.Chart) { resolve(globalThis.Chart); return; }
    const s = document.createElement('script');
    s.src = 'vendor/chartjs/chart.umd.min.js';
    s.onload = () => resolve(globalThis.Chart);
    s.onerror = () => reject(new Error('Chart library unavailable'));
    document.head.append(s);
  });
  return loading;
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * Horizontal bar chart.
 * @param {HTMLCanvasElement} canvas
 * @param {{labels:string[], datasets:{label:string,data:number[]}[], xTitle?:string, max?:number}} spec
 */
export async function barChart(canvas, spec) {
  const Chart = await loadChartJs();
  if (!canvas.isConnected) return null;
  const palette = [css('--accent'), css('--brass'), css('--moss'), css('--text-soft')];
  const patterns = [[], [6, 3], [2, 2], [8, 2, 2, 2]];
  const chart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: spec.labels,
      datasets: spec.datasets.map((d, i) => ({
        label: d.label,
        data: d.data,
        backgroundColor: `${palette[i % palette.length]}55`,
        borderColor: palette[i % palette.length],
        borderWidth: 2,
        borderDash: patterns[i % patterns.length],
        borderSkipped: false,
      })),
    },
    options: {
      indexAxis: spec.vertical ? 'x' : 'y',
      responsive: true,
      maintainAspectRatio: false,
      animation: matchMedia('(prefers-reduced-motion: reduce)').matches ? false : { duration: 400 },
      scales: {
        x: { min: spec.min ?? 0, max: spec.max, grid: { color: `${css('--rule')}66` }, ticks: { color: css('--text-soft'), font: { family: 'Courier Prime' } }, title: { display: Boolean(spec.xTitle), text: spec.xTitle, color: css('--text-soft') } },
        y: { grid: { display: false }, ticks: { color: css('--text'), font: { family: 'Courier Prime', size: 12 }, autoSkip: false } },
      },
      plugins: {
        legend: { display: spec.datasets.length > 1, labels: { color: css('--text'), font: { family: 'Courier Prime' } } },
        tooltip: { titleFont: { family: 'Courier Prime' }, bodyFont: { family: 'Courier Prime' } },
      },
    },
  });
  live.add(chart);
  return chart;
}

export function destroyCharts() {
  for (const c of live) c.destroy();
  live.clear();
}
