#!/usr/bin/env bash
set -euo pipefail

source /etc/rukter-amd-worker.env
: "${RUKTER_WORKER_SOURCE_BASE:?RUKTER_WORKER_SOURCE_BASE is required}"
ROCM_WORKER_IMAGE="${ROCM_WORKER_IMAGE:-rocm/pytorch:latest}"

install -d -m 0755 /opt/rukter /var/lib/rukter-models /var/lib/rukter-outputs

install_digitalocean_metrics_agent() {
  if ! command -v systemctl >/dev/null 2>&1; then
    echo "systemd is unavailable; skipping DigitalOcean metrics agent install." >&2
    return 0
  fi
  if systemctl is-active --quiet do-agent 2>/dev/null; then
    echo "DigitalOcean metrics agent is already active."
    return 0
  fi

  echo "Installing DigitalOcean metrics agent for Droplet and GPU Insights."
  if curl -fsSL https://repos.insights.digitalocean.com/install.sh -o /tmp/do-agent-install.sh; then
    bash /tmp/do-agent-install.sh || echo "DigitalOcean metrics agent installer failed; worker bootstrap will continue." >&2
    rm -f /tmp/do-agent-install.sh
  else
    echo "Could not download DigitalOcean metrics agent installer; worker bootstrap will continue." >&2
  fi
  systemctl enable --now do-agent 2>/dev/null || true
  if systemctl is-active --quiet do-agent 2>/dev/null; then
    echo "DigitalOcean metrics agent is active."
  else
    echo "DigitalOcean metrics agent is not active yet; GPU rendering can continue but Insights may show No Data." >&2
  fi
}

install_digitalocean_metrics_agent

for file in app.py gpu_telemetry.py identity_guard.py requirements.txt run_story_pipeline.py run_story_pipeline.sh; do
  if ! curl -fsSL "${RUKTER_WORKER_SOURCE_BASE%/}/${file}?v=${WORKER_VERSION:-unknown}" -o "/opt/rukter/${file}.download"; then
    if [[ ! -s "/opt/rukter/${file}" ]]; then
      echo "Unable to download ${file} and no preloaded copy exists." >&2
      exit 1
    fi
    continue
  fi
  mv "/opt/rukter/${file}.download" "/opt/rukter/${file}"
done
chmod 0755 /opt/rukter/run_story_pipeline.sh

if ! docker image inspect "${ROCM_WORKER_IMAGE}" >/dev/null 2>&1; then
  docker pull "${ROCM_WORKER_IMAGE}"
fi

cat >/etc/systemd/system/rukter-amd-worker.service <<UNIT
[Unit]
Description=Rukter AMD Product Story Worker
After=docker.service network-online.target
Requires=docker.service
Wants=network-online.target

[Service]
Type=simple
Restart=on-failure
RestartSec=10
TimeoutStartSec=20min
EnvironmentFile=/etc/rukter-amd-worker.env
ExecStartPre=-/usr/bin/docker rm -f rukter-amd-worker
ExecStart=/usr/bin/docker run --rm --name rukter-amd-worker --network host --ipc host --device=/dev/kfd --device=/dev/dri --group-add video --security-opt seccomp=unconfined --env-file /etc/rukter-amd-worker.env -v /opt/rukter:/opt/rukter -v /var/lib/rukter-models:/root/.cache/huggingface -v /var/lib/rukter-outputs:/var/lib/rukter-outputs -w /opt/rukter ${ROCM_WORKER_IMAGE} bash -lc "apt-get update && apt-get install -y --no-install-recommends ffmpeg tesseract-ocr tesseract-ocr-tha && rm -rf /var/lib/apt/lists/* && python3 -m pip install --no-cache-dir -r requirements.txt && exec uvicorn app:app --host 0.0.0.0 --port 8080"
ExecStop=-/usr/bin/docker stop -t 20 rukter-amd-worker

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable rukter-amd-worker.service
systemctl restart rukter-amd-worker.service
