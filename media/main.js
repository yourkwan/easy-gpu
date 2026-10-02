(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  var USER_COLORS = ['#4C9AFF', '#F4801A', '#2EA043', '#A371F7', '#E5484D', '#D29922', '#39C5CF', '#DB61A2'];
  var MAX_HISTORY = 90;
  var MAX_PROCESS_CHIPS = 12;

  var state = { status: 'idle', host: '' };
  var config = { refreshInterval: 5 };
  var history = [];
  var lastSampleKey = '';
  var skeletonBuilt = false;

  var gpuCards = {}; // index -> card refs
  var refs = {};

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text !== undefined && text !== null) {
      node.textContent = String(text);
    }
    return node;
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function fmtGB(bytes, digits) {
    var gb = (bytes || 0) / 1024 / 1024 / 1024;
    var d = digits === undefined ? (gb >= 100 ? 0 : gb >= 10 ? 1 : 2) : digits;
    return gb.toFixed(d);
  }

  function pctText(value) {
    return typeof value === 'number' && isFinite(value) ? Math.round(value) + '%' : '—';
  }

  function tempClass(temp) {
    if (typeof temp !== 'number') return 'cool';
    if (temp >= 80) return 'hot';
    if (temp >= 65) return 'warm';
    return 'cool';
  }

  function barColor(value) {
    if (typeof value !== 'number') return '#8b949e';
    if (value >= 85) return '#E5484D';
    if (value >= 55) return '#D29922';
    return '#2EA043';
  }

  function userColor(name) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) {
      hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    }
    return USER_COLORS[hash % USER_COLORS.length];
  }

  function sortProcesses(processes) {
    return (processes || []).slice().sort(function (a, b) {
      return (b.memory || 0) - (a.memory || 0);
    });
  }

  // ---------------- skeleton ----------------

  function buildSkeleton() {
    if (skeletonBuilt) return;
    var content = $('content');

    // GPU section
    var gpuSection = el('section', 'section');
    var gpuHead = el('div', 'section-head');
    gpuHead.appendChild(el('h2', null, 'GPU'));
    refs.gpuSummary = el('span', 'section-sub', '');
    gpuHead.appendChild(refs.gpuSummary);
    refs.gpuGrid = el('div', 'gpu-grid');
    gpuSection.appendChild(gpuHead);
    gpuSection.appendChild(refs.gpuGrid);
    content.appendChild(gpuSection);

    // System section
    var sysSection = el('section', 'section');
    var sysHead = el('div', 'section-head');
    sysHead.appendChild(el('h2', null, '系统'));
    refs.sysSummary = el('span', 'section-sub', '');
    sysHead.appendChild(refs.sysSummary);
    sysSection.appendChild(sysHead);

    var sysGrid = el('div', 'sys-grid');
    sysGrid.appendChild(buildCpuCard());
    sysGrid.appendChild(buildMemoryCard());
    sysSection.appendChild(sysGrid);
    content.appendChild(sysSection);

    skeletonBuilt = true;
  }

  function buildCpuCard() {
    var card = el('article', 'sys-card');
    card.innerHTML =
      '<div class="sys-head"><span class="sys-title">CPU</span><span class="sys-sub cpu-sub"></span></div>' +
      '<div class="cpu-main">' +
      '  <div class="cpu-value"><span class="cpu-num">—</span><span class="unit">%</span></div>' +
      '  <canvas class="cpu-chart"></canvas>' +
      '</div>';

    refs.cpu = {
      root: card,
      sub: card.querySelector('.cpu-sub'),
      num: card.querySelector('.cpu-num'),
      chart: card.querySelector('.cpu-chart')
    };
    return card;
  }

  function buildMemoryCard() {
    var card = el('article', 'sys-card');
    card.innerHTML =
      '<div class="sys-head"><span class="sys-title">内存</span><span class="sys-sub mem-sub"></span></div>' +
      '<div class="mem-value"><span class="used">—</span><span class="sep">/</span><span class="total">—</span></div>' +
      '<div class="bar big"><div class="bar-fill mem-bar"></div></div>' +
      '<div class="mem-foot"><span class="mem-pct"></span><span class="mem-cache"></span></div>';

    refs.mem = {
      root: card,
      sub: card.querySelector('.mem-sub'),
      used: card.querySelector('.used'),
      total: card.querySelector('.total'),
      bar: card.querySelector('.mem-bar'),
      pct: card.querySelector('.mem-pct'),
      cache: card.querySelector('.mem-cache')
    };
    refs.mem.bar.style.background = 'linear-gradient(90deg, #F4801A, #FFA94D)';
    return card;
  }

  function buildGpuCard() {
    var root = el('article', 'gpu-card');
    root.innerHTML =
      '<div class="gpu-head">' +
      '  <span class="gpu-index"></span>' +
      '  <span class="gpu-name"></span>' +
      '  <span class="temp-pill"></span>' +
      '</div>' +
      '<div class="metric metric-primary">' +
      '  <div class="metric-row"><span class="metric-label">显存</span>' +
      '  <span class="metric-value"><span class="mem-val"></span> <span class="mem-pct"></span></span></div>' +
      '  <div class="bar big"><div class="bar-fill mem-fill"></div></div>' +
      '</div>' +
      '<div class="metric metric-sub">' +
      '  <div class="metric-row"><span class="metric-label">利用率</span><span class="metric-value util-val"></span></div>' +
      '  <div class="bar thin"><div class="bar-fill util-fill"></div></div>' +
      '</div>' +
      '<div class="gpu-users"></div>';

    return {
      root: root,
      index: root.querySelector('.gpu-index'),
      name: root.querySelector('.gpu-name'),
      temp: root.querySelector('.temp-pill'),
      utilVal: root.querySelector('.util-val'),
      utilFill: root.querySelector('.util-fill'),
      memVal: root.querySelector('.mem-val'),
      memPct: root.querySelector('.mem-pct'),
      memFill: root.querySelector('.mem-fill'),
      users: root.querySelector('.gpu-users')
    };
  }

  // ---------------- rendering ----------------

  function pushHistory(snapshot) {
    var key = String(snapshot.timestamp) + '|' + String(state.updatedAt || '');
    if (key === lastSampleKey) return;
    lastSampleKey = key;

    var cpu = typeof snapshot.cpu.usage === 'number' ? snapshot.cpu.usage : null;
    history.push({ cpu: cpu, t: Date.now() });
    if (history.length > MAX_HISTORY) {
      history.shift();
    }
  }

  function renderStatusPill() {
    var pill = $('status-pill');
    var text = $('status-text');
    pill.className = 'status-pill';
    var status = state.status;

    if (!state.host || status === 'idle') {
      text.textContent = '未配置';
      return;
    }
    if (status === 'error') {
      pill.classList.add('error');
      text.textContent = '连接失败';
      return;
    }
    if (status === 'connecting') {
      pill.classList.add('connecting');
      text.textContent = state.snapshot ? '刷新中' : '连接中';
      return;
    }
    pill.classList.add('ok');
    text.textContent = '已连接';
  }

  function renderHostLine() {
    var line = $('host-line');
    if (!state.host) {
      line.textContent = '未配置服务器 · 点击右上角"切换服务器"开始';
      return;
    }
    var text = state.host;
    if (state.snapshot && state.snapshot.hostname && state.snapshot.hostname !== 'unknown') {
      text += '  ·  ' + state.snapshot.hostname;
    }
    line.textContent = text;
    line.title = text;
  }

  function bannerButton(label, handler, ghost) {
    var btn = el('button', 'btn' + (ghost ? ' ghost' : ''), label);
    btn.addEventListener('click', handler);
    return btn;
  }

  function renderBanner() {
    var banner = $('banner');
    banner.textContent = '';
    banner.className = 'banner hidden';

    function show(kind, text, buttons) {
      banner.className = 'banner ' + kind;
      banner.appendChild(el('span', 'banner-text', text));
      (buttons || []).forEach(function (b) {
        banner.appendChild(b);
      });
    }

    var refreshBtn = function () {
      return bannerButton('立即重试', function () {
        vscode.postMessage({ type: 'refresh' });
      });
    };
    var hostBtn = function () {
      return bannerButton(
        '选择服务器',
        function () {
          vscode.postMessage({ type: 'selectHost' });
        },
        true
      );
    };

    if (!state.host) {
      show('info', '尚未配置要监控的服务器。扩展会复用你本机的 ~/.ssh/config 与密钥。', [hostBtn()]);
      return;
    }
    if (state.status === 'error') {
      show('error', '连接失败：' + (state.error || '未知错误'), [refreshBtn(), hostBtn()]);
      return;
    }
    var snapshot = state.snapshot;
    if (snapshot && !snapshot.nvidiaSmi) {
      show('warn', '远程服务器未检测到 nvidia-smi：可能没有安装 NVIDIA 驱动，或当前账号无执行权限。', []);
      return;
    }
    if (snapshot && snapshot.gpus.length === 0) {
      show('warn', 'nvidia-smi 未返回任何 GPU 信息。', [refreshBtn()]);
    }
  }

  function updateGpuCard(card, gpu) {
    card.index.textContent = '[' + gpu.index + ']';
    card.name.textContent = gpu.name || 'GPU';
    card.name.title = gpu.name || '';

    card.temp.textContent = typeof gpu.temperature === 'number' ? gpu.temperature + '°C' : '—';
    card.temp.className = 'temp-pill ' + tempClass(gpu.temperature);

    card.utilVal.textContent = pctText(gpu.utilization);
    var util = typeof gpu.utilization === 'number' ? clamp(gpu.utilization, 0, 100) : 0;
    card.utilFill.style.width = util + '%';
    card.utilFill.style.background = barColor(gpu.utilization);

    var memPct = gpu.memoryTotal > 0 ? (gpu.memoryUsed / gpu.memoryTotal) * 100 : 0;
    card.memVal.textContent = gpu.memoryUsed + ' / ' + gpu.memoryTotal + ' MB';
    card.memPct.textContent = gpu.memoryTotal > 0 ? '(' + memPct.toFixed(1) + '%)' : '';
    card.memFill.style.width = clamp(memPct, 0, 100) + '%';

    var procs = sortProcesses(gpu.processes);
    card.users.textContent = '';
    card.users.appendChild(el('span', 'users-label', '用户'));
    if (!procs.length) {
      card.users.appendChild(el('span', 'muted', '空闲'));
      return;
    }
    // 与 gpustat 一致：每个进程单独显示（同一用户的多个进程不合并）
    procs.slice(0, MAX_PROCESS_CHIPS).forEach(function (p) {
      var chip = el('span', 'user-chip');
      var dot = el('i');
      dot.style.background = userColor(p.user);
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(p.user + '(' + p.memory + 'M)'));
      chip.title = 'PID ' + p.pid + ' · ' + (p.command || '?') + ' · ' + p.memory + ' MB';
      card.users.appendChild(chip);
    });

    // 进程极多时仅折叠尾部（不是按用户合并），悬停可查看全部明细
    var restProcs = procs.slice(MAX_PROCESS_CHIPS);
    if (restProcs.length) {
      var restMemory = restProcs.reduce(function (a, p) {
        return a + (p.memory || 0);
      }, 0);
      var more = el('span', 'user-chip more', '+' + restProcs.length + ' 进程 · ' + restMemory + 'M');
      more.title = restProcs
        .map(function (p) {
          return p.user + '(' + p.memory + 'M) · PID ' + p.pid + ' · ' + (p.command || '?');
        })
        .join('\n');
      card.users.appendChild(more);
    }
  }

  function renderGpuSection() {
    var snapshot = state.snapshot;
    var grid = refs.gpuGrid;

    if (!snapshot) {
      return;
    }

    var gpus = snapshot.gpus || [];
    var usedMem = gpus.reduce(function (a, g) {
      return a + (g.memoryUsed || 0);
    }, 0);
    var totalMem = gpus.reduce(function (a, g) {
      return a + (g.memoryTotal || 0);
    }, 0);

    refs.gpuSummary.textContent = gpus.length
      ? gpus.length +
        ' 张卡 · 显存 ' +
        (usedMem / 1024).toFixed(1) +
        ' / ' +
        (totalMem / 1024).toFixed(1) +
        ' GB' +
        (totalMem > 0 ? ' · 已用 ' + ((usedMem / totalMem) * 100).toFixed(1) + '%' : '')
      : '';

    if (!gpus.length) {
      grid.textContent = '';
      Object.keys(gpuCards).forEach(function (key) {
        delete gpuCards[key];
      });
      grid.appendChild(
        el('div', 'empty-card', snapshot.nvidiaSmi ? 'nvidia-smi 未返回 GPU 信息' : '未检测到 NVIDIA GPU')
      );
      return;
    }

    var emptyCard = grid.querySelector('.empty-card');
    if (emptyCard) {
      emptyCard.remove();
    }

    var seen = {};
    gpus.forEach(function (gpu) {
      var key = String(gpu.index);
      seen[key] = true;
      var card = gpuCards[key];
      if (!card) {
        card = buildGpuCard();
        gpuCards[key] = card;
      }
      updateGpuCard(card, gpu);
      if (card.root.parentNode !== grid) {
        grid.appendChild(card.root);
      }
    });

    Object.keys(gpuCards).forEach(function (key) {
      if (!seen[key]) {
        if (gpuCards[key].root.parentNode) {
          gpuCards[key].root.remove();
        }
        delete gpuCards[key];
      }
    });
  }

  function renderSystemSection() {
    var snapshot = state.snapshot;
    var cpu = refs.cpu;
    var mem = refs.mem;
    if (!snapshot) {
      return;
    }

    var cpuInfo = snapshot.cpu || {};
    cpu.num.textContent = cpuInfo.usage === null || cpuInfo.usage === undefined ? '—' : Math.round(cpuInfo.usage);
    var coreText = cpuInfo.cores ? cpuInfo.cores + ' 核' : '';
    cpu.sub.textContent = [coreText, cpuInfo.model].filter(Boolean).join(' · ');
    cpu.sub.title = cpuInfo.model || '';

    var memory = snapshot.memory || {};
    mem.used.textContent = fmtGB(memory.used) + ' GB';
    mem.total.textContent = fmtGB(memory.total) + ' GB';
    var memPct = memory.total > 0 ? (memory.used / memory.total) * 100 : 0;
    mem.bar.style.width = clamp(memPct, 0, 100) + '%';
    mem.pct.textContent = '已用 ' + memPct.toFixed(1) + '%';
    mem.cache.textContent = '缓存 ' + fmtGB(memory.cached) + ' GB';
    mem.sub.textContent = '可用 ' + fmtGB(memory.available) + ' GB';

    var gpuCount = (snapshot.gpus || []).length;
    refs.sysSummary.textContent = gpuCount ? 'GPU ' + gpuCount + ' 张 · nvidia-smi 采集' : 'nvidia-smi 采集';
  }

  function renderFooter() {
    var footer = $('footer');
    footer.textContent = '';
    var left = el('span');
    if (state.updatedAt) {
      var time = new Date(state.updatedAt).toLocaleTimeString('zh-CN', { hour12: false });
      left.textContent = '最后更新 ' + time + ' · 刷新间隔 ' + config.refreshInterval + 's';
    } else {
      left.textContent = '等待数据…';
    }
    var right = el('span');
    if (state.snapshot) {
      right.textContent = 'GPU 数据来自 nvidia-smi · SSH 复用系统配置';
    }
    footer.appendChild(left);
    footer.appendChild(right);
  }

  // ---------------- chart ----------------

  function drawChart() {
    var canvas = refs.cpu && refs.cpu.chart;
    if (!canvas) return;
    var w = canvas.clientWidth;
    var h = canvas.clientHeight;
    if (!w || !h) return;

    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(127,127,127,0.22)';
    ctx.lineWidth = 1;
    [25, 50, 75].forEach(function (p) {
      var y = Math.round(h - (p / 100) * h) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    });

    var cpuPts = history
      .map(function (p) {
        return p.cpu;
      })
      .filter(function (v) {
        return typeof v === 'number';
      });

    if (cpuPts.length < 2) {
      ctx.fillStyle = 'rgba(127,127,127,0.75)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('等待更多采样数据…', w / 2, h / 2);
      return;
    }

    var stepX = w / (MAX_HISTORY - 1);
    // 未满窗口时从左向右生长，满窗口后随新样本向左滚动
    ctx.beginPath();
    cpuPts.forEach(function (v, i) {
      var x = i * stepX;
      var y = h - (clamp(v, 0, 100) / 100) * h;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    });
    ctx.strokeStyle = '#2EA043';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.lineTo((cpuPts.length - 1) * stepX, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    var grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(46,160,67,0.42)');
    grad.addColorStop(1, 'rgba(46,160,67,0.03)');
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // ---------------- countdown ----------------

  function tickCountdown() {
    var node = $('countdown');
    if (!node) return;
    if (!state.host) {
      node.textContent = '';
      return;
    }
    if (state.status === 'connecting') {
      node.textContent = '刷新中…';
      return;
    }
    if (!state.updatedAt) {
      node.textContent = '';
      return;
    }
    var next = state.updatedAt + config.refreshInterval * 1000;
    var remain = Math.max(0, Math.ceil((next - Date.now()) / 1000));
    node.textContent = remain > 0 ? remain + 's 后刷新' : '即将刷新';
  }

  // ---------------- main render ----------------

  function render() {
    buildSkeleton();
    renderStatusPill();
    renderHostLine();
    renderBanner();
    renderGpuSection();
    renderSystemSection();
    renderFooter();
    drawChart();
    tickCountdown();
  }

  window.addEventListener('message', function (event) {
    var message = event.data || {};
    if (message.type === 'state') {
      state = message.state || state;
      config = message.config || config;
      if (state.snapshot) {
        pushHistory(state.snapshot);
      }
      render();
    }
  });

  window.addEventListener('resize', function () {
    drawChart();
  });

  $('btn-refresh').addEventListener('click', function () {
    vscode.postMessage({ type: 'refresh' });
  });
  $('btn-host').addEventListener('click', function () {
    vscode.postMessage({ type: 'selectHost' });
  });
  $('btn-settings').addEventListener('click', function () {
    vscode.postMessage({ type: 'openSettings' });
  });

  setInterval(tickCountdown, 1000);
  vscode.postMessage({ type: 'ready' });
})();