(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  var MAX_HISTORY = 90;
  var MAX_PROCESS_CHIPS = 12;

  var state = { status: 'idle', host: '' };
  var config = { refreshInterval: 10, mergeProcesses: false, accentColor: 'blue' };
  var profiles = [];
  var history = [];
  var lastSampleKey = '';
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

  /** bytes → GB（系统内存 bytes；GPU 显存 MB 需先 ×1024×1024） */
  function fmtGB(bytes, digits) {
    var gb = (bytes || 0) / 1024 / 1024 / 1024;
    var d = digits === undefined ? (gb >= 100 ? 0 : gb >= 10 ? 1 : 2) : digits;
    return gb.toFixed(d);
  }

  function pctText(value) {
    return typeof value === 'number' && isFinite(value) ? Math.round(value) + '%' : '—';
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

  // ---------------- GPU 卡片 ----------------

  function buildGpuCard(index) {
    var card = el('article', 'gcard');
    card.title = '点击收起 / 展开用户显存';
    card.innerHTML =
      '<div class="gcard-head">' +
        '<span class="gpu-id">GPU ' + index + '</span>' +
        '<span class="gpu-name"></span>' +
        '<div class="gpu-metrics">' +
          '<div class="metric"><span class="m-label">Temp</span><span class="m-value" data-f="temp">--</span></div>' +
          '<div class="metric"><span class="m-label">Util</span><span class="m-value" data-f="util">--</span></div>' +
          '<span class="gcard-toggle"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>' +
        '</div>' +
      '</div>' +
      '<div class="vram-row">' +
        '<span class="vram-used" data-f="used">--</span>' +
        '<span class="vram-unit" data-f="unit">GB</span>' +
        '<span class="vram-pct" data-f="pct">--</span>' +
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

  function renderProcs(card, gpu) {
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

    renderProcs(card, gpu);
  }

  // ---------------- CPU 曲线 ----------------

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

  // ---------------- 渲染 ----------------

  function vramTotal(s) {
    var used = 0, total = 0;
    s.gpus.forEach(function (g) { used += g.memoryUsed; total += g.memoryTotal; });
    return fmtGB(used * 1024 * 1024) + '/' + fmtGB(total * 1024 * 1024) + 'G';
  }

  function render() {
    document.body.setAttribute('data-color', config.accentColor || 'blue');
    document.body.setAttribute('data-status', state.status);

    // 头部
    $('host').textContent = state.host || '未配置服务器';
    $('status-text').textContent =
      state.status === 'ok' ? '已连接' :
      state.status === 'connecting' ? '连接中…' :
      state.status === 'error' ? '连接失败' : '未连接';

    // banner
    var banner = $('banner');
    if (state.status === 'error') {
      banner.className = 'banner err';
      banner.innerHTML = '连接失败：' + (state.error || '未知错误') + '　<span class="link">新建连接</span>';
    } else if (!state.host) {
      banner.className = 'banner info';
      banner.innerHTML = '尚未添加服务器，点击<span class="link">新建连接</span>开始。';
    } else {
      banner.className = 'banner hidden';
    }

    var s = state.snapshot;
    if (s) {
      if (!s.nvidiaSmi) {
        banner.className = 'banner info';
        banner.textContent = '远程服务器未检测到 nvidia-smi：可能没有 NVIDIA 驱动或无执行权限。';
      }

      // GPU 卡片（缓存增删）
      var list = $('gpu-list');
      var seen = {};
      s.gpus.forEach(function (gpu) {
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

      // 系统
      var cpu = s.cpu || {};
      refs.cpuValue.textContent = (cpu.usage === null || cpu.usage === undefined) ? '—' : Math.round(cpu.usage);
      refs.cpuCores.textContent = cpu.cores ? cpu.cores + ' 核' : '';
      if (cpu.model) refs.cpuCores.title = cpu.model;

      var mem = s.memory || {};
      refs.memUsed.textContent = fmtGB(mem.used);
      refs.memTotal.textContent = fmtGB(mem.total);
      var memPct = mem.total > 0 ? (mem.used / mem.total) * 100 : 0;
      refs.memPct.textContent = memPct.toFixed(1) + '%';
      refs.memMeter.style.width = clamp(memPct, 0, 100) + '%';
      refs.memCache.textContent = '缓存 ' + fmtGB(mem.cached) + 'G';
      refs.memAvail.textContent = '可用 ' + fmtGB(mem.available) + 'G';
    }

    // 页脚
    if (state.updatedAt) {
      var t = new Date(state.updatedAt);
      $('foot').textContent = '数据 ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes()) + ':' + pad2(t.getSeconds()) +
        ' · ' + (state.durationMs ? (state.durationMs / 1000).toFixed(2) + 's' : '—');
    } else {
      $('foot').textContent = '等待数据…';
    }

    // 合并开关与配置回显
    $('btn-merge').classList.toggle('on', Boolean(config.mergeProcesses));
    syncIntervalUI();
  }

  // ---------------- toast ----------------

  var toastTimer = null;
  function toast(msg) {
    var node = $('toast');
    node.textContent = msg;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.classList.remove('show'); }, 1800);
  }

  // ---------------- 设置 sheet ----------------

  var PRESETS = [5, 10, 30, 60];

  function applyInterval(value) {
    config.refreshInterval = value;
    syncIntervalUI();
  }

  function syncIntervalUI() {
    var value = config.refreshInterval;
    $('interval-label').textContent = value + 's';
    var isPreset = PRESETS.indexOf(value) !== -1;
    Array.prototype.forEach.call($('interval-chips').querySelectorAll('.chip'), function (c) {
      c.classList.toggle('on', Number(c.dataset.iv) === value);
    });
    var input = $('interval-custom');
    input.classList.toggle('on', !isPreset);
    if (document.activeElement !== input) {
      input.value = isPreset ? '' : value;
    }
  }

  function closeSheets() {
    document.body.classList.remove('sheet-open', 'server-open');
  }

  // ---------------- 选择服务器 sheet ----------------

  function renderServerList() {
    var list = $('server-list');
    list.innerHTML = '';
    if (!profiles.length) {
      list.appendChild(el('div', 'procs-empty', '尚未添加服务器'));
      return;
    }
    profiles.forEach(function (sv) {
      var row = el('div', 'server-row' + (sv.current ? ' current' : ''));
      row.innerHTML =
        '<div class="server-main"><div class="server-name"></div><div class="server-sub"></div></div>' +
        '<svg class="server-check" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
      row.querySelector('.server-name').textContent = sv.label;
      row.querySelector('.server-sub').textContent = sv.sub || '';
      row.addEventListener('click', function () {
        closeSheets();
        if (sv.current) return;
        toast('已切换到 ' + sv.label);
        vscode.postMessage({ type: 'switchProfile', id: sv.id });
      });
      list.appendChild(row);
    });
  }

  // ---------------- 骨架 refs ----------------

  function cacheRefs() {
    refs.cpuValue = $('cpu-value');
    refs.cpuCores = $('cpu-cores');
    refs.cpuChart = $('cpu-chart');
    refs.memUsed = $('mem-used');
    refs.memTotal = $('mem-total');
    refs.memPct = $('mem-pct');
    refs.memMeter = $('mem-meter');
    refs.memCache = $('mem-cache');
    refs.memAvail = $('mem-avail');
  }

  // ---------------- 事件 ----------------

  window.addEventListener('message', function (event) {
    var message = event.data || {};
    if (message.type !== 'state') return;
    state = message.state || state;
    config = message.config || config;
    if (Array.isArray(message.profiles)) profiles = message.profiles;
    if (state.snapshot) pushHistory(state.snapshot);
    render();
    drawChart();
    if (document.body.classList.contains('server-open')) renderServerList();
  });

  window.addEventListener('resize', function () {
    drawChart();
  });

  $('btn-refresh').addEventListener('click', function () {
    vscode.postMessage({ type: 'refresh' });
  });

  $('btn-settings').addEventListener('click', function () {
    closeSheets();
    document.body.classList.add('sheet-open');
  });

  $('btn-sheet-close').addEventListener('click', closeSheets);
  $('sheet-backdrop').addEventListener('click', closeSheets);

  $('btn-merge').addEventListener('click', function () {
    config.mergeProcesses = !config.mergeProcesses;
    $('btn-merge').classList.toggle('on', config.mergeProcesses);
    var s = state.snapshot;
    if (s) {
      s.gpus.forEach(function (gpu) {
        var card = gpuCards[String(gpu.index)];
        if (card) renderProcs(card, gpu);
      });
    }
    toast(config.mergeProcesses ? '合并进程：开' : '合并进程：关');
    vscode.postMessage({ type: 'updateConfig', key: 'mergeProcesses', value: config.mergeProcesses });
  });

  $('interval-chips').addEventListener('click', function (e) {
    var chip = e.target.closest('.chip');
    if (!chip) return;
    applyInterval(Number(chip.dataset.iv));
    vscode.postMessage({ type: 'updateConfig', key: 'refreshInterval', value: config.refreshInterval });
  });

  $('interval-custom').addEventListener('change', function () {
    var v = Math.round(Number($('interval-custom').value));
    if (!Number.isFinite(v) || v < 2 || v > 600) {
      syncIntervalUI();
      return;
    }
    applyInterval(v);
    vscode.postMessage({ type: 'updateConfig', key: 'refreshInterval', value: v });
  });

  $('interval-custom').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('interval-custom').blur();
  });

  $('swatches').addEventListener('click', function (e) {
    var sw = e.target.closest('.swatch');
    if (!sw) return;
    config.accentColor = sw.dataset.c;
    document.body.setAttribute('data-color', config.accentColor);
    Array.prototype.forEach.call($('swatches').children, function (c) {
      c.classList.toggle('on', c === sw);
    });
    drawChart();
    vscode.postMessage({ type: 'updateConfig', key: 'accentColor', value: config.accentColor });
  });

  $('more-row').addEventListener('click', function () {
    closeSheets();
    vscode.postMessage({ type: 'openMoreSettings' });
  });

  $('btn-servers').addEventListener('click', function () {
    closeSheets();
    renderServerList();
    document.body.classList.add('server-open');
  });

  $('btn-server-close').addEventListener('click', closeSheets);

  $('server-add').addEventListener('click', function () {
    closeSheets();
    vscode.postMessage({ type: 'openConnect' });
  });

  document.addEventListener('click', function (e) {
    if (e.target.closest('.banner .link')) {
      vscode.postMessage({ type: 'openConnect' });
    }
  });

  // ---------------- 启动 ----------------

  cacheRefs();
  render();
  vscode.postMessage({ type: 'ready' });
})();