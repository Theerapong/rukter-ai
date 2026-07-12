import asyncio
import json
import os
import signal
import shutil
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field


app = FastAPI(title="Rukter AMD Product Story Worker", version="1.0.0")
jobs: dict[str, dict] = {}
active_job_id: str | None = None
active_process: asyncio.subprocess.Process | None = None
cancel_requested_jobs: set[str] = set()
worker_state_lock = asyncio.Lock()
TERMINAL_JOB_STATUSES = {"ready", "failed", "cancelled"}


def positive_env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except (TypeError, ValueError):
        return default


MAX_JOB_HISTORY = positive_env_int("MAX_JOB_HISTORY", 100)


class StoryRequest(BaseModel):
    story: dict
    sourceImages: list[dict] = Field(min_length=3, max_length=8)


def require_token(authorization: str | None) -> None:
    expected = os.getenv("WORKER_TOKEN", "")
    if expected and authorization != f"Bearer {expected}":
        raise HTTPException(status_code=401, detail="Invalid worker token.")


def rocm_evidence() -> dict:
    rocminfo = shutil.which("rocminfo")
    smi = shutil.which("rocm-smi")
    if not rocminfo:
        return {"available": False, "device": "", "rocmVersion": "", "reason": "rocminfo is unavailable"}
    result = subprocess.run([rocminfo], capture_output=True, text=True, timeout=15, check=False)
    output = result.stdout + result.stderr
    devices = [line.split(":", 1)[1].strip() for line in output.splitlines() if "Marketing Name:" in line]
    gpu_device = next((device for device in devices if "AMD" in device or "MI300" in device), "")
    version = ""
    version_file = Path("/opt/rocm/.info/version")
    if version_file.exists():
        version = version_file.read_text(encoding="utf-8").strip()
    return {
        "available": result.returncode == 0 and bool(gpu_device),
        "device": gpu_device,
        "rocmVersion": version,
        "rocmSmi": bool(smi),
    }


async def collect_process_stream(stream, job: dict, parse_progress: bool = False) -> str:
    chunks: list[str] = []
    while True:
        line = await stream.readline()
        if not line:
            break
        text = line.decode("utf-8", errors="replace")
        chunks.append(text)
        if parse_progress and text.startswith("RUKTER_PROGRESS "):
            try:
                progress = json.loads(text.removeprefix("RUKTER_PROGRESS "))
                if job.get("status") in TERMINAL_JOB_STATUSES or job.get("status") == "cancelling":
                    continue
                job.update(
                    progress=max(0, min(100, int(progress.get("progress", job.get("progress", 0))))),
                    detail=str(progress.get("detail", "Running Product Story pipeline on AMD GPU"))[:240],
                    stage=str(progress.get("stage", job.get("stage", "video_generation")))[:80],
                    context=progress.get("context") if isinstance(progress.get("context"), dict) else job.get("context"),
                    updatedAt=time.time(),
                )
            except (TypeError, ValueError, json.JSONDecodeError):
                continue
    return "".join(chunks)[-4000:]


class StoryJobCancelled(Exception):
    pass


def raise_if_cancelled(job_id: str) -> None:
    if job_id in cancel_requested_jobs:
        raise StoryJobCancelled("AMD Product Story cancelled.")


def prune_job_history(limit: int = MAX_JOB_HISTORY, preserve_job_id: str | None = None) -> None:
    """Keep recent terminal job records without ever evicting the active job."""
    candidates = sorted(
        (
            (job_id, float(job.get("updatedAt", job.get("createdAt", 0))))
            for job_id, job in jobs.items()
            if job_id != preserve_job_id
            and job_id != active_job_id
            and job.get("status") in TERMINAL_JOB_STATUSES
        ),
        key=lambda item: item[1],
    )
    while len(jobs) > max(0, limit) and candidates:
        job_id, _ = candidates.pop(0)
        jobs.pop(job_id, None)


async def terminate_process(process: asyncio.subprocess.Process | None) -> None:
    if process is None or process.returncode is not None:
        return
    try:
        # The pipeline starts in its own session. Signalling the process group
        # also stops ffmpeg and any model/helper descendants it spawned.
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        await asyncio.wait_for(process.wait(), timeout=10)
    except TimeoutError:
        if process.returncode is None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        await process.wait()
    # The group leader can exit before a descendant that handles SIGTERM
    # poorly. Give descendants a brief grace period, then ensure none survive.
    await asyncio.sleep(0.25)
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


async def execute_story(job_id: str, request: StoryRequest) -> None:
    global active_job_id, active_process
    job = jobs[job_id]
    command = os.getenv("STORY_PIPELINE_COMMAND", "/opt/rukter/run_story_pipeline.sh")
    process: asyncio.subprocess.Process | None = None
    try:
        raise_if_cancelled(job_id)
        job.update(status="running", progress=5, detail="Validating AMD ROCm device", stage="gpu_validation")
        evidence = await asyncio.to_thread(rocm_evidence)
        if not evidence["available"]:
            raise RuntimeError(f"AMD ROCm device is not ready: {evidence.get('reason', 'no compatible GPU found')}")
        if not Path(command).exists():
            raise RuntimeError("STORY_PIPELINE_COMMAND is not installed in this worker image.")
        raise_if_cancelled(job_id)

        with tempfile.TemporaryDirectory(prefix="rukter-story-") as directory:
            input_path = Path(directory) / "input.json"
            output_path = Path(directory) / "output.json"
            input_path.write_text(request.model_dump_json(), encoding="utf-8")
            job.update(progress=15, detail="Starting the Wan 2.2 video pipeline on AMD GPU", stage="model_loading")
            process = await asyncio.create_subprocess_exec(
                command,
                str(input_path),
                str(output_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            async with worker_state_lock:
                active_process = process
            if job_id in cancel_requested_jobs:
                await terminate_process(process)
                raise StoryJobCancelled("AMD Product Story cancelled.")
            stdout_task = asyncio.create_task(collect_process_stream(process.stdout, job, parse_progress=True))
            stderr_task = asyncio.create_task(collect_process_stream(process.stderr, job))
            timed_out = False
            try:
                await asyncio.wait_for(process.wait(), timeout=18 * 60)
            except TimeoutError:
                timed_out = True
                await terminate_process(process)
            stdout, stderr = await asyncio.gather(stdout_task, stderr_task)
            raise_if_cancelled(job_id)
            if timed_out:
                raise RuntimeError("AMD story pipeline exceeded its 18 minute execution limit.")
            if process.returncode != 0:
                reason = stderr[-800:] or stdout[-800:]
                raise RuntimeError(f"AMD story pipeline failed: {reason}")
            if not output_path.exists():
                raise RuntimeError("AMD story pipeline did not write output.json.")
            output = json.loads(output_path.read_text(encoding="utf-8"))
            if not output.get("videoUrl"):
                raise RuntimeError("AMD story pipeline did not return a public videoUrl.")
            output_evidence = output.get("evidence", {})
            expected_shots = len(request.story.get("shots", []))
            verified_shots = output_evidence.get("shots", [])
            identity = output_evidence.get("identityVerified") is True
            if not identity or expected_shots < 1:
                raise RuntimeError("AMD story pipeline did not pass product identity verification.")
            if len(verified_shots) != expected_shots or not all(shot.get("identityVerified") is True for shot in verified_shots):
                raise RuntimeError("AMD story pipeline did not verify every directed cinematic shot.")
            output["evidence"] = {
                **output_evidence,
                **evidence,
                "identityVerified": True,
                "shotCount": expected_shots,
            }
            async with worker_state_lock:
                raise_if_cancelled(job_id)
                job.update(status="ready", progress=100, detail="AMD Product Story ready", stage="complete", **output)
    except StoryJobCancelled:
        async with worker_state_lock:
            job.update(status="cancelled", progress=100, detail="AMD Product Story cancelled", stage="cancelled", error="")
    except Exception as error:
        async with worker_state_lock:
            if job_id in cancel_requested_jobs:
                job.update(status="cancelled", progress=100, detail="AMD Product Story cancelled", stage="cancelled", error="")
            else:
                job.update(status="failed", progress=100, detail="AMD Product Story failed", error=str(error))
    finally:
        await terminate_process(process)
        async with worker_state_lock:
            job["updatedAt"] = time.time()
            if active_job_id == job_id:
                active_job_id = None
                active_process = None
            cancel_requested_jobs.discard(job_id)
            prune_job_history(preserve_job_id=job_id)


@app.get("/health")
def health() -> dict:
    evidence = rocm_evidence()
    return {
        "status": "ok" if evidence["available"] else "not_ready",
        "service": "rukter-amd-story-worker",
        "workerVersion": os.getenv("WORKER_VERSION", "unknown"),
        "acceptingJobs": evidence["available"] and active_job_id is None,
        **evidence,
    }


@app.post("/v1/story-jobs", status_code=202)
async def create_story_job(request: StoryRequest, background_tasks: BackgroundTasks, authorization: str | None = Header(default=None)) -> dict:
    global active_job_id
    require_token(authorization)
    evidence = await asyncio.to_thread(rocm_evidence)
    if not evidence["available"]:
        raise HTTPException(status_code=503, detail="AMD ROCm device is not ready.")
    async with worker_state_lock:
        if active_job_id is not None:
            raise HTTPException(status_code=409, detail="AMD GPU worker is already running a Product Story job.")
        prune_job_history(limit=MAX_JOB_HISTORY - 1)
        job_id = f"amd_story_{uuid.uuid4().hex}"
        jobs[job_id] = {
            "jobId": job_id,
            "status": "queued",
            "progress": 0,
            "detail": "Queued on AMD GPU worker",
            "stage": "queued",
            "createdAt": time.time(),
            "updatedAt": time.time(),
        }
        active_job_id = job_id
    background_tasks.add_task(execute_story, job_id, request)
    return jobs[job_id]


@app.get("/v1/story-jobs/{job_id}")
def get_story_job(job_id: str, authorization: str | None = Header(default=None)) -> dict:
    require_token(authorization)
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="AMD Product Story job not found.")
    return job


@app.post("/v1/story-jobs/{job_id}/cancel")
async def cancel_story_job(job_id: str, authorization: str | None = Header(default=None)) -> dict:
    require_token(authorization)
    async with worker_state_lock:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="AMD Product Story job not found.")
        # Recheck terminal state while holding the same lock used by the
        # executor's terminal transition. This makes ready-vs-cancel atomic.
        if job.get("status") in TERMINAL_JOB_STATUSES:
            return job
        cancel_requested_jobs.add(job_id)
        process = active_process if active_job_id == job_id else None
        job.update(status="cancelling", detail="Cancelling AMD Product Story", stage="cancelling", updatedAt=time.time())

    await terminate_process(process)
    async with worker_state_lock:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="AMD Product Story job not found.")
        if job.get("status") not in TERMINAL_JOB_STATUSES:
            job.update(
                status="cancelled",
                progress=100,
                detail="AMD Product Story cancelled",
                stage="cancelled",
                error="",
                updatedAt=time.time(),
            )
        return job
