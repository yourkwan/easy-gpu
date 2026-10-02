/* 开发预览用的模拟数据：4×RTX 3090，参考 gpustat 真实输出 */
(function () {
  'use strict';

  var jitter = function (base, range) {
    return Math.max(0, Math.min(100, base + (Math.random() - 0.5) * range));
  };
  var jitterMem = function (base, range) {
    return Math.max(0, Math.round(base + (Math.random() - 0.5) * range));
  };

  function makeSnapshot() {
    var users = ['lj', 'wzs', 'gfr'];
    return {
      hostname: 'gpu-node-01',
      timestamp: Date.now(),
      nvidiaSmi: true,
      cpu: {
        usage: jitter(52, 26),
        cores: 64,
        load1: 32.41 + Math.random() * 4,
        load5: 28.12 + Math.random() * 3,
        load15: 25.87 + Math.random() * 2,
        model: 'Intel(R) Xeon(R) Platinum 8358P @ 2.60GHz'
      },
      memory: {
        total: 134766589952,
        used: 99070000000 + Math.random() * 3e9,
        available: 35696589824,
        cached: 1105954981
      },
      gpus: [
        {
          index: 0,
          name: 'NVIDIA GeForce RTX 3090',
          temperature: Math.round(jitter(71, 6)),
          utilization: Math.round(jitter(61, 18)),
          memoryUsed: jitterMem(18610, 200),
          memoryTotal: 24576,
          processes: [
            { pid: 1001, user: users[0], memory: 12454, command: 'python3' },
            { pid: 1002, user: users[1], memory: 6140, command: 'python' }
          ]
        },
        {
          index: 1,
          name: 'NVIDIA GeForce RTX 3090',
          temperature: Math.round(jitter(87, 4)),
          utilization: Math.round(jitter(100, 6)),
          memoryUsed: jitterMem(13692, 200),
          memoryTotal: 24576,
          processes: [
            { pid: 1003, user: users[2], memory: 1788, command: 'train.py' },
            { pid: 1004, user: users[0], memory: 11886, command: 'python3' }
          ]
        },
        {
          index: 2,
          name: 'NVIDIA GeForce RTX 3090',
          temperature: Math.round(jitter(78, 5)),
          utilization: Math.round(jitter(97, 6)),
          memoryUsed: jitterMem(20319, 200),
          memoryTotal: 24576,
          processes: [
            { pid: 1005, user: users[1], memory: 3502, command: 'python' },
            { pid: 1006, user: users[0], memory: 10662, command: 'python' },
            { pid: 1007, user: users[1], memory: 6134, command: 'python' }
          ]
        },
        {
          index: 3,
          name: 'NVIDIA GeForce RTX 3090',
          temperature: Math.round(jitter(83, 4)),
          utilization: Math.round(jitter(100, 6)),
          memoryUsed: jitterMem(19399, 200),
          memoryTotal: 24576,
          processes: [
            { pid: 1008, user: users[1], memory: 3502, command: 'python' },
            { pid: 1009, user: users[1], memory: 6110, command: 'python' },
            { pid: 1010, user: users[1], memory: 6876, command: 'python' },
            { pid: 1011, user: users[2], memory: 684, command: 'jupyter-lab' },
            { pid: 1012, user: users[1], memory: 682, command: 'python' },
            { pid: 1013, user: users[0], memory: 814, command: 'python' },
            { pid: 1014, user: 'lxy', memory: 512, command: 'python' },
            { pid: 1015, user: 'cy', memory: 468, command: 'python' },
            { pid: 1016, user: 'zhao', memory: 402, command: 'jupyter-lab' },
            { pid: 1017, user: 'sunq', memory: 358, command: 'python' },
            { pid: 1018, user: 'qian', memory: 296, command: 'python' },
            { pid: 1019, user: users[1], memory: 1240, command: 'python' },
            { pid: 1020, user: users[1], memory: 986, command: 'python' },
            { pid: 1021, user: users[1], memory: 758, command: 'python' },
            { pid: 1022, user: users[0], memory: 320, command: 'python' }
          ]
        }
      ]
    };
  }

  window.__easyGpuFeed = function () {
    var push = function () {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'state',
            state: {
              status: 'ok',
              host: 'gpu-lab',
              snapshot: makeSnapshot(),
              updatedAt: Date.now()
            },
            config: { refreshInterval: 3 }
          }
        })
      );
    };
    push();
    setInterval(push, 3000);
  };
})();