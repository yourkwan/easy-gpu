(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  var MAX_HISTORY = 90;
  var MAX_PROCESS_CHIPS = 12;

  var state = { status: 'idle', host: '' };
  var config = { refreshInterval: 5, mergeProcesses: false, accentColor: 'blue' };
  var history = [];
  var lastSampleKey = '';
  var skeletonBuilt = false;
  var currentView = 'capsule';

  var gpuCards = {};
  var refs = {};

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  /** bytes → GB 字符串（系统内存用 bytes，GPU 显存用 MB 需先 ×1024×1024） */
  function fmtGB(bytes, digits) {
    var gb = (bytes || 0) / 1024 / 1024 / 1024;
    var d = digits === undefined ? (gb >= 100 ? 0 : gb >= 10 ? 1 : 2) : digits;
    return gb.toFixed(d);
  }

  function pctText(value) {
    return typeof value === 'number' && isFinite(value) ? Math.round(value) + '%' : '—';
  }

  function tempState(temp) {
    if (typeof temp !== 'number') return '';
    if (temp >= 80) return 'hot';
    if (temp >= 65) return 'warm';
    return '';
  }

  function utilState(util) {
    if (typeof util !== 'number') return '';
    if (util >= 98) return 'hot';
    if (util >= 90) return 'warm';
    return '';
  }

  function pad2(value) {
    var text = String(value);
    return text.length < 2 ? '0' + text : text;
  }

  function cssVar(name, fallback) {
    var value = getComputedStyle(document.body).getPropertyValue(name);
    value = (value || '').trim();
    return value || fallback;
  }

  function withAlpha(color, alpha) {
    var match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
    if (!match) return color;
    var num = parseInt(match[1], 16);
    return 'rgba(' + ((num >> 16) & 255) + ',' + ((num >> 8) & 255) + ',' + (num & 255) + ',' + alpha + ')';
  }

  function sortProcesses(processes) {
    return (processes || []).slice().sort(function (a, b) {
      return (b.memory || 0) - (a.memory || 0);
    });
  }

  function mergeProcessesByUser(processes) {
    var order = [];
    var byUser = {};
    processes.forEach(function (p) {
      var key = p.user || '?';
      if (!byUser[key]) {
        byUser[key] = { user: key, memory: 0, items: [] };
        order.push(key);
      }
      byUser[key].memory += p.memory || 0;
      byUser[key].items.push(p);
    });
    return order.map(function (key) { return byUser[key]; }).sort(function (a, b) {
      return b.memory - a.memory;
    });
  }

  // ---------------- accent color ----------------

  function applyAccent() {
    document.body.setAttribute('data-color', config.accentColor || 'blue');
  }

  // ---------------- island capsule ----------------

  function toggleIsland() {
    var island = $('island');
    island.classList.toggle('expanded');
    document.body.classList.toggle('island-expanded', island.classList.contains('expanded'));
  }

  function renderIsland() {
    var s = state.snapshot;
    var dot = $('dot');
    dot.className = 'dot ' + state.status;

    var shortText;
    if (state.status === 'connecting') shortText = '连接中…';
    else if (state.status === 'error') shortText = '连接失败';
    else if (state.status === 'idle' || !s) shortText = '未连接';
    else {
      var memTotal = 0, memUsed = 0;
      s.gpus.forEach(function (g) { memTotal += g.memoryTotal; memUsed += g.memoryUsed; });
      shortText = fmtGB(memUsed * 1024 * 1024) + '/' + fmtGB(memTotal * 1024 * 1024) + 'G';
    }
    $('short-text').textContent = shortText;

    $('long-host').textContent = state.host || '未配置服务器';
    $('long-summary').textContent = (state.status === 'ok' && s) ? summaryText(s) : shortText;

    // capsule page hero
    $('hero-mem').textContent = state.status === 'ok' ? shortText : '——';
    $('hero-sub').textContent =
      state.status === 'ok' ? summaryText(s) :
      state.status === 'connecting' ? '正在连接监控服务器…' :
      state.status === 'error' ? '连接失败，请在窗口页查看错误详情' : '尚未连接服务器';
  }

  function summaryText(s) {
    var memTotal = 0, memUsed = 0, tempMax = 0;
    s.gpus.forEach(function (g) {
      memTotal += g.memoryTotal; memUsed += g.memoryUsed;
      if (g.temperature > tempMax) tempMax = g.temperature;
    });
    return 'GPU×' + s.gpus.length +
      ' 显存 ' + fmtGB(memUsed * 1024 * 1024) + '/' + fmtGB(memTotal * 1024 * 1024) + 'G' +
      (tempMax ? ' · ' + tempMax + '°C' : '') +
      ' | CPU ' + (typeof s.cpu.usage === 'number' ? Math.round(s.cpu.usage) : '—') + '%' +
      ' | RAM ' + fmtGB(s.memory.used) + '/' + fmtGB(s.memory.total) + 'G';
  }

  // ---------------- view switching ----------------

  function setView(next) {
    currentView = next;
    $('view-capsule').classList.toggle('hidden', next !== 'capsule');
    $('view-window').classList.toggle('hidden', next !== 'window');
    if (next === 'window') {
      buildSkeleton();
      renderWindowPage();
      drawChart();
      window.scrollTo({ top: 0 });
    }
  }

  // ---------------- skeleton (window page) ----------------

  function buildSkeleton() {
    if (skeletonBuilt) return;

    // CPU card
    var sysGrid = $('sys-grid');
    var cpuCard = el('div', 'sys-card');
    cpuCard.innerHTML =
      '<div class="sys-top">' +
      '  <span class="sys-label">CPU</span>' +
      '  <span class="diag" id="cpu-cores"></span>' +
      '</div>' +
      '<div class="sys-big num"><span id="cpu-value">—</span><small>%</small></div>' +
      '<canvas class="cpu-chart" id="cpu-chart"></canvas>';
    sysGrid.appendChild(cpuCard);

    // Memory card
    var memCard = el('div', 'sys-card');
    memCard.innerHTML =
      '<div class="sys-top">' +
      '  <span class="sys-label">内存</span>' +
      '  <span class="diag" id="mem-pct"></span>' +
      '</div>' +
      '<div class="sys-big num"><span id="mem-used">—</span><small>GB / <span id="mem-total">—</span> GB</small></div>' +
      '<div class="meter"><i id="mem-meter" style="width:0%"></i></div>' +
      '<div class="sys-meta">' +
      '  <span id="mem-cache"></span>' +
      '  <span id="mem-avail"></span>' +
      '</div>';
    sysGrid.appendChild(memCard);

    refs.cpuValue = $('cpu-value');
    refs.cpuCores = $('cpu-cores');
    refs.cpuChart = $('cpu-chart');
    refs.memUsed = $('mem-used');
    refs.memTotal = $('mem-total');
    refs.memPct = $('mem-pct');
    refs.memMeter = $('mem-meter');
    refs.memCache = $('mem-cache');
    refs.memAvail = $('mem-avail');

    skeletonBuilt = true;
  }

  // ---------------- GPU card ----------------

  function buildGpuCard(index) {
    var card = el('article', 'gcard');
    card.title = '点击收起 / 展开用户显存';
    card.innerHTML =
      '<div class="gcard-head">' +
        '<div><span class="gpu-id">GPU <i class="num">' + index + '</i></span><span class="gpu-name"></span></div>' +
        '<div class="gpu-metrics">' +
          '<div class="metric"><span class="m-label">Temp</span><span class="m-value" data-f="temp">--</span></div>' +
          '<div class="metric"><span class="m-label">Util</span><span class="m-value" data-f="util">--</span></div>' +
          '<span class="gcard-toggle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>' +
        '</div>' +
      '</div>' +
      '<div class="vram-row">' +
        '<span class="vram-used num" data-f="used">--</span>' +
        '<span class="vram-unit" data-f="unit">GB</span>' +
        '<span class="vram-pct num" data-f="pct">--</span>' +
      '</div>' +
      '<div class="meter"><i data-f="meter"></i></div>' +
      '<div class="procs" data-f="procs"></div>';

    card.addEventListener('click', function () {
      card.classList.toggle('collapsed');
    });

    return {
      el: card,
      name: card.querySelector('.gpu-name'),
      temp: card.querySelector('[data-f="temp"]'),
      util: card.querySelector('[data-f="util"]'),
      used: card.querySelector('[data-f="used"]'),
      unit: card.querySelector('[data-f="unit"]'),
      pct: card.querySelector('[data-f="pct"]'),
      meter: card.querySelector('[data-f="meter"]'),
      procs: card.querySelector('[data-f="procs"]')
    };
  }

  function updateGpuCard(card, gpu) {
    card.name.textContent = gpu.name || 'GPU';
    card.name.title = gpu.name || '';

    card.temp.textContent = typeof gpu.temperature === 'number' ? gpu.temperature + '°C' : '—';
    card.temp.className = 'm-value' + (gpu.temperature >= 80 ? ' hot' : gpu.temperature >= 65 ? ' warm' : '');

    card.util.textContent = pctText(gpu.utilization);
    card.util.className = 'm-value' + (gpu.utilization >= 98 ? ' hot' : gpu.utilization >= 90 ? ' warm' : '');

    card.used.textContent = fmtGB((gpu.memoryUsed || 0) * 1024 * 1024);
    card.unit.textContent = 'GB / ' + fmtGB((gpu.memoryTotal || 0) * 1024 * 1024) + ' GB';
    var pct = gpu.memoryTotal > 0 ? Math.round((gpu.memoryUsed / gpu.memoryTotal) * 100) : 0;
    card.pct.textContent = pct + '%';
    card.meter.style.width = clamp(pct, 0, 100) + '%';

    var procs = sortProcesses(gpu.processes);
    card.procs.innerHTML = '';
    if (!procs.length) {
      card.procs.appendChild(el('span', 'procs-empty', '空闲'));
      return;
    }

    var entries = config.mergeProcesses
      ? mergeProcessesByUser(procs).map(function (group) {
          return {
            user: group.user,
            memory: group.memory,
            title: group.user + '：' + group.items.length + ' 个进程 · 合计 ' + group.memory + ' MB\n' +
              group.items.map(function (p) { return 'PID ' + p.pid + ' · ' + p.memory + 'M · ' + (p.command || '?'); }).join('\n')
          };
        })
      : procs.map(function (p) {
          return {
            user: p.user,
            memory: p.memory,
            title: 'PID ' + p.pid + ' · ' + (p.command || '?') + ' · ' + p.memory + ' MB'
          };
        });

    entries.slice(0, MAX_PROCESS_CHIPS).forEach(function (entry) {
      var chip = el('span', 'proc');
      chip.appendChild(el('b', null, entry.user));
      chip.appendChild(el('span', null, entry.memory + 'M'));
      chip.title = entry.title;
      card.procs.appendChild(chip);
    });

    var rest = entries.slice(MAX_PROCESS_CHIPS);
    if (rest.length) {
      var restMem = rest.reduce(function (a, e) { return a + (e.memory || 0); }, 0);
      var unit = config.mergeProcesses ? ' 个用户' : ' 进程';
      var more = el('span', 'proc more', '+' + rest.length + unit + ' · ' + restMem + 'M');
      more.title = rest.map(function (e) { return e.user + ' · ' + e.memory + 'M'; }).join('\n');
      card.procs.appendChild(more);
    }
  }

  // ---------------- window page rendering ----------------

  function renderWindowPage() {
    var s = state.snapshot;

    $('win-host').textContent = state.host || '未配置服务器';

    var badge = $('win-badge');
    var badgeText =
      state.status === 'ok' ? '已连接' :
      state.status === 'connecting' ? '连接中…' :
      state.status === 'error' ? '连接失败' : '未连接';
    $('win-badge-text').textContent = badgeText;
    badge.className = 'badge' + (state.status === 'error' ? ' error' : state.status === 'idle' ? ' idle' : '');
    badge.querySelector('.dot').className = 'dot ' + state.status;

    var diagText = '';
    if (state.channel) {
      diagText = (state.channel === 'builtin' ? '内置客户端' : '系统 ssh');
    }
    if (state.durationMs) {
      diagText += (diagText ? ' · ' : '') + '刷新耗时 ' + (state.durationMs / 1000).toFixed(2) + 's';
    }
    $('win-diag').textContent = diagText;

    // banner
    var banner = $('banner');
    if (state.status === 'error') {
      banner.classList.remove('hidden');
      banner.textContent = '连接失败：' + (state.error || '未知错误');
    } else if (!state.host) {
      banner.classList.remove('hidden');
      banner.textContent = '尚未添加服务器，点击胶囊「切换服务器」开始。';
    } else if (s && !s.nvidiaSmi) {
      banner.classList.remove('hidden');
      banner.textContent = '远程服务器未检测到 nvidia-smi：可能没有 NVIDIA 驱动或无执行权限。';
    } else {
      banner.classList.add('hidden');
    }

    if (!s) return;

    // GPU list
    var list = $('gpu-list');
    var gpus = s.gpus || [];
    var seen = {};
    gpus.forEach(function (gpu) {
      var key = String(gpu.index);
      seen[key] = true;
      var card = gpuCards[key];
      if (!card) {
        card = buildGpuCard(gpu.index);
        gpuCards[key] = card;
      }
      updateGpuCard(card, gpu);
      if (card.el.parentNode !== list) list.appendChild(card.el);
    });
    Object.keys(gpuCards).forEach(function (key) {
      if (!seen[key]) {
        if (gpuCards[key].el.parentNode) gpuCards[key].el.remove();
        delete gpuCards[key];
      }
    });

    // CPU
    var cpu = s.cpu || {};
    refs.cpuValue.textContent = (cpu.usage === null || cpu.usage === undefined) ? '—' : Math.round(cpu.usage);
    refs.cpuCores.textContent = cpu.cores ? cpu.cores + ' 核' : '';
    if (cpu.model) refs.cpuCores.title = cpu.model;

    // Memory
    var mem = s.memory || {};
    refs.memUsed.textContent = fmtGB(mem.used);
    refs.memTotal.textContent = fmtGB(mem.total);
    var memPct = mem.total > 0 ? (mem.used / mem.total) * 100 : 0;
    refs.memPct.textContent = memPct.toFixed(1) + '%';
    refs.memMeter.style.width = clamp(memPct, 0, 100) + '%';
    refs.memCache.textContent = '缓存 ' + fmtGB(mem.cached) + 'G';
    refs.memAvail.textContent = '可用 ' + fmtGB(mem.available) + 'G';

    // Footer
    var foot = $('foot');
    if (state.updatedAt) {
      var t = new Date(state.updatedAt);
      var hh = pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds());
      foot.textContent = '数据 ' + hh + ' · 刷新耗时 ' + (state.durationMs ? (state.durationMs / 1000).toFixed(2) + 's' : '—') + ' · Easy GPU';
    } else {
      foot.textContent = '等待数据…';
    }
  }

  // ---------------- history & chart ----------------

  function pushHistory(snapshot) {
    var key = String(snapshot.timestamp) + '|' + String(state.updatedAt || '');
    if (key === lastSampleKey) return;
    lastSampleKey = key;
    var cpu = typeof snapshot.cpu.usage === 'number' ? snapshot.cpu.usage : null;
    history.push({ cpu: cpu, t: Date.now() });
    if (history.length > MAX_HISTORY) history.shift();
  }

  function drawChart() {
    var canvas = refs.cpuChart;
    if (!canvas) return;
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    if (!w || !h) return;

    var accent = cssVar('--accent', '#007aff');
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 50% 参考线
    ctx.strokeStyle = cssVar('--track', 'rgba(127,127,127,0.22)');
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 4]);
    var mid = h / 2 + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
    ctx.setLineDash([]);

    var cpuPts = history.map(function (p) { return p.cpu; }).filter(function (v) { return typeof v === 'number'; });
    if (cpuPts.length < 2) return;

    var stepX = w / (MAX_HISTORY - 1);
    ctx.beginPath();
    cpuPts.forEach(function (v, i) {
      var x = i * stepX;
      var y = h - (clamp(v, 0, 100) / 100) * (h - 6) - 3;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.lineTo((cpuPts.length - 1) * stepX, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    var grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, withAlpha(accent, 0.35));
    grad.addColorStop(1, withAlpha(accent, 0.01));
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // ---------------- countdown ----------------

  function tickCountdown() {
    var node = $('countdown');
    if (!node) return;
    if (!state.host) { node.textContent = ''; return; }
    if (state.status === 'connecting') { node.textContent = '刷新中'; return; }
    if (!state.updatedAt) { node.textContent = ''; return; }
    var next = state.updatedAt + config.refreshInterval * 1000;
    var remain = Math.max(0, Math.ceil((next - Date.now()) / 1000));
    node.textContent = remain > 0 ? remain + 's 后刷新' : '即将刷新';
  }

  // ---------------- main render ----------------

  function render() {
    applyAccent();
    renderIsland();
    if (currentView === 'window') {
      buildSkeleton();
      renderWindowPage();
      drawChart();
    }
    tickCountdown();
  }

  // ---------------- events ----------------

  window.addEventListener('message', function (event) {
    var message = event.data || {};
    if (message.type === 'state') {
      state = message.state || state;
      config = message.config || config;
      if (state.snapshot) pushHistory(state.snapshot);
      render();
    }
  });

  window.addEventListener('resize', function () {
    drawChart();
  });

  // island click (toggle expand/collapse, but not when clicking icon buttons)
  $('island').addEventListener('click', function (e) {
    if (e.target.closest('.icon-btn')) return;
    toggleIsland();
  });

  $('btn-host').addEventListener('click', function () {
    vscode.postMessage({ type: 'selectHost' });
  });
  $('btn-refresh').addEventListener('click', function () {
    vscode.postMessage({ type: 'refresh' });
  });
  $('btn-settings').addEventListener('click', function () {
    vscode.postMessage({ type: 'openSettings' });
  });
  $('btn-window').addEventListener('click', function () {
    setView(currentView === 'window' ? 'capsule' : 'window');
  });

  setInterval(tickCountdown, 1000);
  applyAccent();
  vscode.postMessage({ type: 'ready' });
})();
