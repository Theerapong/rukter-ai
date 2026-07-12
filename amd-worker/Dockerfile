ARG ROCM_BASE_IMAGE=rocm/pytorch:latest
FROM --platform=linux/amd64 ${ROCM_BASE_IMAGE}

WORKDIR /opt/rukter
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg tesseract-ocr tesseract-ocr-tha \
  && rm -rf /var/lib/apt/lists/*
COPY requirements.txt ./
RUN python3 -m pip install --no-cache-dir -r requirements.txt
COPY app.py gpu_telemetry.py identity_guard.py run_story_pipeline.py run_story_pipeline.sh ./
RUN chmod 0755 run_story_pipeline.sh

ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=6 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["sh", "-c", "uvicorn app:app --host 0.0.0.0 --port ${PORT}"]
