#!/usr/bin/env bash
# easy-gpu remote collector
# 通过 ssh 管道在远程服务器上以 `bash -s` 执行，输出带标记的单行 JSON。
# 仅依赖 bash / awk / ps / procfs / nvidia-smi，无需 jq 或 python。
export LC_ALL=C

BEGIN='@@EASYGPU_BEGIN@@'
END='@@EASYGPU_END@@'

esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
num() { case "$1" in '' | *[!0-9.]*) printf 'null' ;; *) printf '%s' "$1" ;; esac; }

HOST=$(hostname 2>/dev/null | head -n1)
[ -n "$HOST" ] || HOST=unknown

# ---------------- memory ----------------
MEM_TOTAL=0
MEM_USED=0
MEM_AVAIL=0
MEM_CACHED=0
if [ -r /proc/meminfo ]; then
  MEM_TOTAL=$(awk '/^MemTotal:/{printf "%d", $2*1024}' /proc/meminfo)
  MEM_AVAIL=$(awk '/^MemAvailable:/{printf "%d", $2*1024}' /proc/meminfo)
  MEM_CACHED=$(awk '/^Cached:/{printf "%d", $2*1024}' /proc/meminfo)
  [ -n "$MEM_TOTAL" ] || MEM_TOTAL=0
  [ -n "$MEM_AVAIL" ] || MEM_AVAIL=0
  [ -n "$MEM_CACHED" ] || MEM_CACHED=0
  MEM_USED=$((MEM_TOTAL - MEM_AVAIL))
  if [ "$MEM_USED" -lt 0 ]; then MEM_USED=0; fi
fi

# ---------------- cpu ----------------
CORES=$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 0)
CORES=$(printf '%s' "$CORES" | head -n1 | tr -dc '0-9')
[ -n "$CORES" ] || CORES=0

CPU_MODEL=$(awk -F: '/^model name/{sub(/^ /, "", $2); print $2; exit}' /proc/cpuinfo 2>/dev/null)
[ -n "$CPU_MODEL" ] || CPU_MODEL=$(awk -F: '/^Model/{sub(/^ /, "", $2); print $2; exit}' /proc/cpuinfo 2>/dev/null)

cpu_snapshot() {
  awk '/^cpu /{u=$2;n=$3;s=$4;i=$5;w=$6;q=$7;x=$8;y=$9; printf "%d %d", u+n+s+i+w+q+x+y, i+w}' /proc/stat 2>/dev/null
}

CPU_USAGE=null
SNAP1=$(cpu_snapshot)
if [ -n "$SNAP1" ]; then
  sleep 0.4
  SNAP2=$(cpu_snapshot)
  set -- $SNAP1
  T1=$1
  I1=$2
  set -- $SNAP2
  T2=$1
  I2=$2
  if [ -n "$T2" ] && [ "$T2" -gt "$T1" ]; then
    CPU_USAGE=$(awk -v dt=$((T2 - T1)) -v di=$((I2 - I1)) 'BEGIN{v=(dt-di)*100/dt; if(v<0)v=0; if(v>100)v=100; printf "%.1f", v}')
  fi
fi

LOAD_LINE=$(awk '{print $1, $2, $3}' /proc/loadavg 2>/dev/null)
set -- $LOAD_LINE
LOAD1=${1:-0}
LOAD5=${2:-0}
LOAD15=${3:-0}

# ---------------- gpu ----------------
smi() {
  if command -v timeout >/dev/null 2>&1; then
    timeout 12 nvidia-smi "$@"
  else
    nvidia-smi "$@"
  fi
}

HAS_SMI=0
GPU_CSV=""
UUID_CSV=""
PROC_CSV=""
if command -v nvidia-smi >/dev/null 2>&1; then
  GPU_CSV=$(smi --query-gpu=index,name,temperature.gpu,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null)
  if [ -n "$GPU_CSV" ]; then
    HAS_SMI=1
    UUID_CSV=$(smi --query-gpu=index,uuid --format=csv,noheader 2>/dev/null)
    PROC_CSV=$(smi --query-compute-apps=gpu_uuid,pid,used_memory --format=csv,noheader,nounits 2>/dev/null)
  fi
fi

PID_LIST=$(printf '%s\n' "$PROC_CSV" | awk -F, 'NF>=2 {p=$2; gsub(/ /, "", p); if (p ~ /^[0-9]+$/) print p}' | sort -u | paste -sd, -)
PS_OUT=""
if [ -n "$PID_LIST" ]; then
  PS_OUT=$(ps -o pid=,user=,comm= -p "$PID_LIST" 2>/dev/null)
fi

TS=$(date +%s 2>/dev/null || echo 0)
TS=$((TS * 1000))

# ---------------- emit json ----------------
echo "$BEGIN"
printf '{"hostname":"%s","timestamp":%s,"nvidiaSmi":%s,"cpu":{"usage":%s,"cores":%s,"load1":%s,"load5":%s,"load15":%s,"model":"%s"},"memory":{"total":%s,"used":%s,"available":%s,"cached":%s},"gpus":[' \
  "$(esc "$HOST")" "$TS" "$HAS_SMI" "$CPU_USAGE" "${CORES:-0}" "${LOAD1:-0}" "${LOAD5:-0}" "${LOAD15:-0}" \
  "$(esc "$CPU_MODEL")" "$MEM_TOTAL" "$MEM_USED" "$MEM_AVAIL" "$MEM_CACHED"

FIRST=1
while IFS= read -r line; do
  [ -n "$line" ] || continue
  IFS=',' read -r f_idx f_name f_temp f_util f_mu f_mt <<< "$line"
  idx=$(printf '%s' "$f_idx" | tr -d ' ')
  [ -n "$idx" ] || idx=0
  name=$(printf '%s' "$f_name" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  temp=$(num "$(printf '%s' "$f_temp" | tr -d ' ')")
  util=$(num "$(printf '%s' "$f_util" | tr -d ' ')")
  mu=$(num "$(printf '%s' "$f_mu" | tr -d ' ')")
  mt=$(num "$(printf '%s' "$f_mt" | tr -d ' ')")

  [ "$FIRST" = 1 ] || printf ','
  FIRST=0
  printf '{"index":%s,"name":"%s","temperature":%s,"utilization":%s,"memoryUsed":%s,"memoryTotal":%s,"processes":[' \
    "$idx" "$(esc "$name")" "$temp" "$util" "$mu" "$mt"

  UUID=$(printf '%s\n' "$UUID_CSV" | awk -F, -v i="$idx" '{gsub(/^[ \t]+|[ \t]+$/, "", $1); gsub(/^[ \t]+|[ \t]+$/, "", $2); if ($1 == i) { print $2; exit }}')
  PFIRST=1
  while IFS= read -r pline; do
    [ -n "$pline" ] || continue
    IFS=',' read -r p_uuid p_pid p_mem <<< "$pline"
    p_uuid=$(printf '%s' "$p_uuid" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    p_pid=$(printf '%s' "$p_pid" | tr -d ' ')
    p_mem=$(num "$(printf '%s' "$p_mem" | tr -d ' ')")
    [ "$p_uuid" = "$UUID" ] || continue
    p_user=$(printf '%s\n' "$PS_OUT" | awk -v p="$p_pid" '$1==p {print $2; exit}')
    p_cmd=$(printf '%s\n' "$PS_OUT" | awk -v p="$p_pid" '$1==p {print $3; exit}')
    [ -n "$p_user" ] || p_user=unknown
    [ -n "$p_cmd" ] || p_cmd=unknown
    [ "$PFIRST" = 1 ] || printf ','
    PFIRST=0
    printf '{"pid":%s,"user":"%s","memory":%s,"command":"%s"}' "${p_pid:-0}" "$(esc "$p_user")" "$p_mem" "$(esc "$p_cmd")"
  done <<< "$PROC_CSV"

  printf ']}'
done <<< "$GPU_CSV"
printf ']}\n'
echo "$END"