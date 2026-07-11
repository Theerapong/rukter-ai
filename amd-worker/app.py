import asyncio
import json
import os
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


async def execute_story(job_id: str, request: StoryRequest) -> None:
    job = jobs[job_id]
    command = os.getenv("STORY_PIPELINE_COMMAND", "/opt/rukter/run_story_pipeline.sh")
    try:
        job.update(status="running", progress=5, detail="Validating AMD ROCm device")
        evidence = rocm_evidence()
        if not evidence["available"]:
            raise RuntimeError(f"AMD ROCm device is not ready: {evidence.get('reason', 'no compatible GPU found')}")
        if not Path(command).exists():
            raise RuntimeError("STORY_PIPELINE_COMMAND is not installed in this worker image.")

        with tempfile.TemporaryDirectory(prefix="rukter-story-") as directory:
            input_path = Path(directory) / "input.json"
            output_path = Path(directory) / "output.json"
            input_path.write_text(request.model_dump_json(), encoding="utf-8")
            job.update(progress=15, detail="Running Product Story pipeline on AMD GPU")
            process = await asyncio.create_subprocess_exec(
                command,
                str(input_path),
                str(output_path),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=18 * 60)
            if process.returncode != 0:
                reason = stderr.decode("utf-8", errors="replace")[-800:] or stdout.decode("utf-8", errors="replace")[-800:]
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
            job.update(status="ready", progress=100, detail="AMD Product Story ready", **output)
    except Exception as error:
        job.update(status="failed", progress=100, detail="AMD Product Story failed", error=str(error))
    finally:
        job["updatedAt"] = time.time()


@app.get("/health")
def health() -> dict:
    evidence = rocm_evidence()
    return {"status": "ok" if evidence["available"] else "not_ready", "service": "rukter-amd-story-worker", **evidence}


@app.post("/v1/story-jobs", status_code=202)
def create_story_job(request: StoryRequest, background_tasks: BackgroundTasks, authorization: str | None = Header(default=None)) -> dict:
    require_token(authorization)
    evidence = rocm_evidence()
    if not evidence["available"]:
        raise HTTPException(status_code=503, detail="AMD ROCm device is not ready.")
    job_id = f"amd_story_{uuid.uuid4().hex}"
    jobs[job_id] = {
        "jobId": job_id,
        "status": "queued",
        "progress": 0,
        "detail": "Queued on AMD GPU worker",
        "createdAt": time.time(),
        "updatedAt": time.time(),
    }
    background_tasks.add_task(execute_story, job_id, request)
    return jobs[job_id]


@app.get("/v1/story-jobs/{job_id}")
def get_story_job(job_id: str, authorization: str | None = Header(default=None)) -> dict:
    require_token(authorization)
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="AMD Product Story job not found.")
    return jobs[job_id]
