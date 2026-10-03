(function () {
  'use strict';

  var vscode = acquireVsCodeApi();

  var MAX_HISTORY = 90;
  var MAX_PROCESS_CHIPS = 12;

  var state = { status: 'idle', host: '' };
  var config = { refreshInterval: 5, mergeProcesses: false };
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

  // 语义色只在异常时使用：温度 ≥65 暖 / ≥80 热，利用率 ≥90 暖 / ≥98 热
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

  /** 把同一用户的多个进程合并为一条（显存合计），供「合并同一用户的进程」开关使用。 */
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
    return order
      .map(function (key) {
        return byUser[key];
      })
      .sort(function (a, b) {
        return b.memory - a.memory;
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
    sysSection.appendChild(sysHead);

    var sysRows = el('div', 'sys-rows');
    sysRows.appendChild(buildCpuRow());
    sysRows.appendChild(buildMemoryRow());
    sysSection.appendChild(sysRows);
    content.appendChild(sysSection);

    skeletonBuilt = true;
  }

  function buildCpuRow() {
    var row = el('article', 'sys-row');
    row.innerHTML =
      '<div class="sys-label">CPU</div>' +
      '<div class="sys-body">' +
      '  <div class="sys-line">' +
      '    <span class="sys-value"><span class="cpu-num">—</span><span class="unit">%</span></span>' +
      '    <span class="sys-meta cpu-sub"></span>' +
      '  </div>' +
      '  <canvas class="cpu-chart"></canvas>' +
      '</div>';

    refs.cpu = {
      root: row,
      sub: row.querySelector('.cpu-sub'),
      num: row.querySelector('.cpu-num'),
      chart: row.querySelector('.cpu-chart')
    };
    return row;
  }

  function buildMemoryRow() {
    var row = el('article', 'sys-row');
    row.innerHTML =
      '<div class="sys-label">内存</div>' +
      '<div class="sys-body">' +
      '  <div class="sys-line">' +
      '    <span class="sys-value"><span class="mem-used">—</span><span class="unit mem-unit"></span></span>' +
      '    <span class="sys-meta mem-sub"></span>' +
      '  </div>' +
      '  <div class="meter"><i class="mem-bar"></i></div>' +
      '</div>';

    refs.mem = {
      root: row,
      sub: row.querySelector('.mem-sub'),
      used: row.querySelector('.mem-used'),
      unit: row.querySelector('.mem-unit'),
      bar: row.querySelector('.mem-bar')
    };
    return row;
  }

  function buildGpuCard() {
    var root = el('article', 'gpu-row');
    root.innerHTML =
      '<div class="gpu-idx"></div>' +
      '<div class="gpu-body">' +
      '  <div class="gpu-head">' +
      '    <span class="gpu-name"></span>' +
      '    <span class="gpu-meta temp"><span class="lbl">TEMP</span><span class="val"></span></span>' +
      '    <span class="gpu-meta util"><span class="lbl">UTIL</span><span class="val"></span></span>' +
      '  </div>' +
      '  <div class="gpu-mem">' +
      '    <span class="mem-used"></span><span class="mem-unit"></span><span class="mem-pct"></span>' +
      '  </div>' +
      '  <div class="gpu-bars">' +
      '    <div class="meter"><i class="mem-fill"></i></div>' +
      '    <div class="meter thin"><i class="util-fill"></i></div>' +
      '  </div>' +
      '  <div class="gpu-procs"><span class="procs-label">进程</span></div>' +
      '</div>';

    return {
      root: root,
      index: root.querySelector('.gpu-idx'),
      name: root.querySelector('.gpu-name'),
      temp: root.querySelector('.gpu-meta.temp'),
      tempVal: root.querySelector('.gpu-meta.temp .val'),
      util: root.querySelector('.gpu-meta.util'),
      utilVal: root.querySelector('.gpu-meta.util .val'),
      utilFill: root.querySelector('.util-fill'),
      memUsed: root.querySelector('.mem-used'),
      memUnit: root.querySelector('.mem-unit'),
      memPct: root.querySelector('.mem-pct'),
      memFill: root.querySelector('.mem-fill'),
      users: root.querySelector('.gpu-procs')
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
      line.textContent = '未添加服务器 · 点击右上角「切换服务器」开始';
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
        '添加服务器',
        function () {
          vscode.postMessage({ type: 'selectHost' });
        },
        true
      );
    };

    if (!state.host) {
      show('info', '还没有添加服务器。点「添加服务器」输入地址与用户名，再选择密码或私钥即可。', [hostBtn()]);
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
    card.index.textContent = pad2(gpu.index);
    card.name.textContent = gpu.name || 'GPU';
    card.name.title = gpu.name || '';

    card.temp.className = 'gpu-meta temp ' + tempState(gpu.temperature);
    card.tempVal.textContent = typeof gpu.temperature === 'number' ? gpu.temperature + '°C' : '—';

    card.util.className = 'gpu-meta util ' + utilState(gpu.utilization);
    card.utilVal.textContent = pctText(gpu.utilization);
    var util = typeof gpu.utilization === 'number' ? clamp(gpu.utilization, 0, 100) : 0;
    card.utilFill.style.width = util + '%';

    var memPct = gpu.memoryTotal > 0 ? (gpu.memoryUsed / gpu.memoryTotal) * 100 : 0;
    card.memUsed.textContent = fmtGB((gpu.memoryUsed || 0) * 1024 * 1024);
    card.memUnit.textContent = '/ ' + fmtGB((gpu.memoryTotal || 0) * 1024 * 1024) + ' GB';
    card.memPct.textContent = gpu.memoryTotal > 0 ? memPct.toFixed(1) + '%' : '';
    card.memFill.style.width = clamp(memPct, 0, 100) + '%';

    var procs = sortProcesses(gpu.processes);
    card.users.textContent = '';
    card.users.appendChild(el('span', 'procs-label', '进程'));
    if (!procs.length) {
      card.users.appendChild(el('span', 'procs-empty', '空闲'));
      return;
    }

    // 默认逐个进程显示（与 gpustat 一致）；开启合并后同一用户只占一条，显存合计
    var entries = config.mergeProcesses
      ? mergeProcessesByUser(procs).map(function (group) {
          return {
            user: group.user,
            memory: group.memory,
            title:
              group.user +
              '：' +
              group.items.length +
              ' 个进程 · 合计 ' +
              group.memory +
              ' MB\n' +
              group.items
                .map(function (p) {
                  return 'PID ' + p.pid + ' · ' + p.memory + 'M · ' + (p.command || '?');
                })
                .join('\n')
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
      var cell = el('span', 'proc');
      cell.appendChild(el('b', null, entry.user));
      cell.appendChild(el('span', null, entry.memory + 'M'));
      cell.title = entry.title;
      card.users.appendChild(cell);
    });

    // 条目过多时只折叠尾部，悬停可查看全部明细
    var rest = entries.slice(MAX_PROCESS_CHIPS);
    if (rest.length) {
      var restMemory = rest.reduce(function (a, entry) {
        return a + (entry.memory || 0);
      }, 0);
      var unit = config.mergeProcesses ? ' 个用户' : ' 进程';
      var more = el('span', 'proc more', '+' + rest.length + unit + ' · ' + restMemory + 'M');
      more.title = rest
        .map(function (entry) {
          return entry.user + ' · ' + entry.memory + 'M';
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
    mem.used.textContent = fmtGB(memory.used);
    mem.unit.textContent = '/ ' + fmtGB(memory.total) + ' GB';
    var memPct = memory.total > 0 ? (memory.used / memory.total) * 100 : 0;
    mem.bar.style.width = clamp(memPct, 0, 100) + '%';
    mem.sub.textContent =
      '已用 ' +
      memPct.toFixed(1) +
      '% · 缓存 ' +
      fmtGB(memory.cached) +
      ' GB · 可用 ' +
      fmtGB(memory.available) +
      ' GB';
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
    if (state.snapshot && state.durationMs) {
      // 两位小数：这是「一次刷新的耗时」而不是时钟，保留两位才能看出每次的波动
      right.textContent = '刷新耗时 ' + (state.durationMs / 1000).toFixed(2) + 's';
      right.title = '最近一次刷新的实际耗时（SSH 连接 + 远程采集脚本），与刷新间隔无关';
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

    var accent = cssVar('--accent', '#2c6e94');
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 参考线：仅 50% 一条，发丝级
    ctx.strokeStyle = 'rgba(127,127,127,0.22)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    var mid = Math.round(h - 0.5 * h) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(w, mid);
    ctx.stroke();
    ctx.setLineDash([]);

    var cpuPts = history
      .map(function (p) {
        return p.cpu;
      })
      .filter(function (v) {
        return typeof v === 'number';
      });

    if (cpuPts.length < 2) {
      ctx.fillStyle = 'rgba(127,127,127,0.7)';
      ctx.font = '10px ' + cssVar('--mono', 'monospace');
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
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.25;
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.lineTo((cpuPts.length - 1) * stepX, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    var grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, withAlpha(accent, 0.14));
    grad.addColorStop(1, withAlpha(accent, 0.01));
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
    // 刷新间隔锚定在数据到达时刻，与后台 setTimeout 链一致
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