import express from "express";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config ---
const configPath =
  process.env.PINGPAGE_CONFIG || join(__dirname, "pingpage.config.json");
if (!existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, "utf-8"));
const PORT = parseInt(process.env.PORT || "3300", 10);
const CHECK_INTERVAL = (config.checkIntervalSeconds || 60) * 1000;

// --- JSON-file storage ---
const dataPath = process.env.PINGPAGE_DATA || join(__dirname, "pingpage-data.json");

function loadData() {
  if (!existsSync(dataPath)) return {};
  try {
    return JSON.parse(readFileSync(dataPath, "utf-8"));
  } catch {
    return {};
  }
}

function saveData(data) {
  writeFileSync(dataPath, JSON.stringify(data), "utf-8");
}

// Data shape: { [monitorName]: { checks: [ { status, responseMs, isUp, error, checkedAt } ] } }
let store = loadData();

function addCheck(monitorName, check) {
  if (!store[monitorName]) store[monitorName] = { checks: [] };
  store[monitorName].checks.push(check);
  // Keep only last 90 days of data (at 1 check/min = ~129,600 entries max)
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  store[monitorName].checks = store[monitorName].checks.filter(
    (c) => c.checkedAt >= cutoff
  );
  saveData(store);
}

// --- Monitor Logic ---
async function checkMonitor(monitor) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(monitor.url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timeout);
    const elapsed = Date.now() - start;
    const expectedStatus = monitor.expectedStatus || 200;
    const isUp =
      expectedStatus === 200
        ? res.status >= 200 && res.status < 300
        : res.status === expectedStatus;
    addCheck(monitor.name, {
      status: res.status,
      responseMs: elapsed,
      isUp,
      error: null,
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    const elapsed = Date.now() - start;
    addCheck(monitor.name, {
      status: null,
      responseMs: elapsed,
      isUp: false,
      error: err.message || "Unknown error",
      checkedAt: new Date().toISOString(),
    });
  }
}

async function runAllChecks() {
  await Promise.allSettled(config.monitors.map((m) => checkMonitor(m)));
}

// --- API ---
const app = express();

app.get("/api/status", (_req, res) => {
  const monitors = config.monitors.map((m) => {
    const checks = store[m.name]?.checks || [];
    const latest = checks.length > 0 ? checks[checks.length - 1] : null;

    // 90-day uptime
    const totalChecks = checks.length;
    const upChecks = checks.filter((c) => c.isUp).length;
    const uptimePercent =
      totalChecks > 0 ? parseFloat(((upChecks / totalChecks) * 100).toFixed(3)) : null;

    // Daily history (last 90 days)
    const dailyMap = {};
    for (const c of checks) {
      const day = c.checkedAt.slice(0, 10);
      if (!dailyMap[day]) dailyMap[day] = { total: 0, up: 0, totalMs: 0 };
      dailyMap[day].total++;
      if (c.isUp) dailyMap[day].up++;
      if (c.responseMs) dailyMap[day].totalMs += c.responseMs;
    }
    const dailyHistory = Object.entries(dailyMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, d]) => ({
        day,
        uptimeRatio: d.total > 0 ? d.up / d.total : null,
        avgMs: d.total > 0 ? Math.round(d.totalMs / d.total) : null,
      }));

    return {
      name: m.name,
      url: m.url,
      current: latest
        ? {
            isUp: latest.isUp,
            status: latest.status,
            responseMs: latest.responseMs,
            error: latest.error,
            checkedAt: latest.checkedAt,
          }
        : null,
      uptimePercent,
      dailyHistory,
    };
  });

  const allUp = monitors.every((m) => m.current?.isUp);
  const anyDown = monitors.some((m) => m.current && !m.current.isUp);

  res.json({
    title: config.title || "Status",
    description: config.description || "",
    overallStatus: !monitors.some((m) => m.current)
      ? "unknown"
      : allUp
        ? "operational"
        : anyDown
          ? "degraded"
          : "unknown",
    monitors,
    generatedAt: new Date().toISOString(),
  });
});

// Serve the status page
app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(statusPageHTML());
});

// --- Status Page HTML ---
function statusPageHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(config.title || "Status")}</title>
  <style>
    :root {
      --green: #22c55e;
      --red: #ef4444;
      --yellow: #eab308;
      --gray: #6b7280;
      --gray-light: #e5e7eb;
      --bg: #fafafa;
      --card: #ffffff;
      --text: #111827;
      --text-secondary: #6b7280;
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 0;
    }
    .container { max-width: 720px; margin: 0 auto; padding: 2rem 1rem; }
    .header { text-align: center; margin-bottom: 2rem; }
    .header h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.25rem; }
    .header p { color: var(--text-secondary); font-size: 0.875rem; }
    .banner {
      border-radius: 0.75rem; padding: 1rem 1.5rem; margin-bottom: 2rem;
      display: flex; align-items: center; gap: 0.75rem;
      font-weight: 600; font-size: 1rem;
    }
    .banner.operational { background: #dcfce7; color: #166534; }
    .banner.degraded { background: #fef3c7; color: #92400e; }
    .banner.unknown { background: var(--gray-light); color: var(--gray); }
    .dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
    .banner.operational .dot { background: var(--green); }
    .banner.degraded .dot { background: var(--red); }
    .banner.unknown .dot { background: var(--gray); }
    .monitor {
      background: var(--card); border: 1px solid var(--gray-light);
      border-radius: 0.75rem; padding: 1.25rem 1.5rem; margin-bottom: 1rem;
    }
    .monitor-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 0.75rem;
    }
    .monitor-name { font-weight: 600; font-size: 0.95rem; }
    .monitor-badge {
      font-size: 0.75rem; font-weight: 600; padding: 0.2rem 0.6rem;
      border-radius: 9999px;
    }
    .badge-up { background: #dcfce7; color: #166534; }
    .badge-down { background: #fee2e2; color: #991b1b; }
    .badge-pending { background: var(--gray-light); color: var(--gray); }
    .monitor-meta {
      display: flex; justify-content: space-between;
      font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.75rem;
    }
    .uptime-bar { display: flex; gap: 1.5px; height: 28px; align-items: stretch; }
    .uptime-bar .day {
      flex: 1; border-radius: 2px; min-width: 2px; position: relative; cursor: pointer;
    }
    .uptime-bar .day:hover::after {
      content: attr(data-tip); position: absolute; bottom: 110%; left: 50%;
      transform: translateX(-50%); background: var(--text); color: white;
      padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.7rem;
      white-space: nowrap; z-index: 10;
    }
    .day-full { background: var(--green); }
    .day-partial { background: var(--yellow); }
    .day-down { background: var(--red); }
    .day-empty { background: var(--gray-light); }
    .uptime-labels {
      display: flex; justify-content: space-between;
      font-size: 0.7rem; color: var(--text-secondary); margin-top: 0.25rem;
    }
    .footer {
      text-align: center; margin-top: 2rem;
      font-size: 0.75rem; color: var(--text-secondary);
    }
    .loading { text-align: center; padding: 3rem; color: var(--text-secondary); }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1 id="page-title">Loading...</h1>
      <p id="page-desc"></p>
    </div>
    <div id="banner" class="banner unknown" style="display:none;">
      <span class="dot"></span>
      <span id="banner-text"></span>
    </div>
    <div id="monitors"><div class="loading">Checking services...</div></div>
    <div class="footer">
      Powered by PingPage &middot; Updated <span id="updated-at">...</span>
    </div>
  </div>
  <script>
    async function loadStatus() {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        render(data);
      } catch (e) {
        document.getElementById('monitors').innerHTML =
          '<div class="loading">Failed to load status</div>';
      }
    }
    function render(data) {
      document.getElementById('page-title').textContent = data.title;
      document.getElementById('page-desc').textContent = data.description;
      document.title = data.title;
      const banner = document.getElementById('banner');
      banner.style.display = 'flex';
      banner.className = 'banner ' + data.overallStatus;
      const texts = { operational: 'All Systems Operational', degraded: 'Some Systems Experiencing Issues', unknown: 'Status Unknown' };
      document.getElementById('banner-text').textContent = texts[data.overallStatus] || 'Status Unknown';
      const container = document.getElementById('monitors');
      container.innerHTML = '';
      for (const m of data.monitors) container.appendChild(renderMonitor(m));
      document.getElementById('updated-at').textContent = new Date(data.generatedAt).toLocaleString();
    }
    function renderMonitor(m) {
      const div = document.createElement('div');
      div.className = 'monitor';
      const isUp = m.current?.isUp;
      const badgeClass = m.current == null ? 'badge-pending' : isUp ? 'badge-up' : 'badge-down';
      const badgeText = m.current == null ? 'Pending' : isUp ? 'Operational' : 'Down';
      const uptimeText = m.uptimePercent != null ? m.uptimePercent + '% uptime' : 'No data yet';
      const latencyText = m.current?.responseMs != null ? m.current.responseMs + 'ms' : '-';
      const today = new Date();
      const bars = [];
      for (let i = 89; i >= 0; i--) {
        const d = new Date(today); d.setDate(d.getDate() - i);
        const dayStr = d.toISOString().slice(0, 10);
        const entry = m.dailyHistory.find(h => h.day === dayStr);
        let cls = 'day-empty', tip = dayStr + ': No data';
        if (entry) {
          if (entry.uptimeRatio >= 1) { cls = 'day-full'; tip = dayStr + ': 100%'; }
          else if (entry.uptimeRatio > 0) { cls = 'day-partial'; tip = dayStr + ': ' + (entry.uptimeRatio * 100).toFixed(1) + '%'; }
          else { cls = 'day-down'; tip = dayStr + ': Down'; }
          if (entry.avgMs) tip += ' (' + entry.avgMs + 'ms)';
        }
        bars.push('<span class="day ' + cls + '" data-tip="' + tip + '"></span>');
      }
      div.innerHTML =
        '<div class="monitor-header"><span class="monitor-name">' + esc(m.name) + '</span>' +
        '<span class="monitor-badge ' + badgeClass + '">' + badgeText + '</span></div>' +
        '<div class="monitor-meta"><span>' + uptimeText + '</span><span>' + latencyText + '</span></div>' +
        '<div class="uptime-bar">' + bars.join('') + '</div>' +
        '<div class="uptime-labels"><span>90 days ago</span><span>Today</span></div>';
      return div;
    }
    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
    loadStatus();
    setInterval(loadStatus, 60000);
  </script>
</body>
</html>`;
}

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// --- Start ---
app.listen(PORT, () => {
  console.log(`
  PingPage running on http://localhost:${PORT}
  Monitoring ${config.monitors.length} endpoint(s) every ${config.checkIntervalSeconds || 60}s
  `);
  runAllChecks().then(() => console.log("Initial checks complete."));
  setInterval(runAllChecks, CHECK_INTERVAL);
});
