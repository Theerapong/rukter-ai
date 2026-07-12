import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
import requests
import torch
from PIL import Image
from diffusers import AutoencoderKLWan, WanImageToVideoPipeline
from diffusers.utils import export_to_video
from identity_guard import product_ocr_evidence, requires_ocr_retention
from transformers import CLIPModel, CLIPProcessor


FPS = int(os.getenv("WAN_FPS", "16"))
MAX_NUM_FRAMES = int(os.getenv("WAN_NUM_FRAMES", "81"))
INFERENCE_STEPS = int(os.getenv("WAN_INFERENCE_STEPS", "16"))
MODEL_ID = os.getenv("WAN_MODEL_ID", "Wan-AI/Wan2.2-TI2V-5B-Diffusers")
CLIP_MODEL_ID = os.getenv("WAN_CLIP_MODEL_ID", "openai/clip-vit-base-patch32")
IDENTITY_THRESHOLD = float(os.getenv("WAN_IDENTITY_THRESHOLD", "0.42"))
IDENTITY_CLIP_FALLBACK_THRESHOLD = float(os.getenv("WAN_IDENTITY_CLIP_FALLBACK_THRESHOLD", "0.90"))
OCR_RETENTION_THRESHOLD = float(os.getenv("WAN_OCR_RETENTION_THRESHOLD", "0.15"))
OUTPUT_ROOT = Path(os.getenv("RUKTER_OUTPUT_ROOT", "/var/lib/rukter-outputs"))
IDENTITY_RETRY_PROMPT = (
    " Product identity lock: preserve the exact source product silhouette, shell pattern, wheels, handles, "
    "logos, packaging text, colors, and proportions. Use minimal camera motion. Do not morph, replace, "
    "redesign, relabel, or remove any visible product feature."
)
IDENTITY_RETRY_NEGATIVE = (
    " changed product identity, warped logo, missing text, unreadable text, different luggage, missing wheels, "
    "altered handles, changed shell pattern, product morphing, extra objects"
)


def positive_env_int(name: str, default: int) -> int:
    try:
        return max(1, int(os.getenv(name, str(default))))
    except (TypeError, ValueError):
        return default


OUTPUT_RETENTION_MAX_JOBS = positive_env_int("OUTPUT_RETENTION_MAX_JOBS", 4)
OUTPUT_RETENTION_MAX_AGE_SECONDS = positive_env_int("OUTPUT_RETENTION_MAX_AGE_SECONDS", 6 * 60 * 60)
IDENTITY_RETRY_ATTEMPTS = positive_env_int("WAN_IDENTITY_RETRY_ATTEMPTS", 2)
OCR_RETENTION_MIN_TOKENS = positive_env_int("WAN_OCR_RETENTION_MIN_TOKENS", 2)


def cleanup_output_directories(preserve: Path | None = None) -> None:
    """Remove stale/crashed artifacts and cap retained output directories."""
    if not OUTPUT_ROOT.exists():
        return
    now = time.time()
    directories = sorted(
        (path for path in OUTPUT_ROOT.iterdir() if path.is_dir() and path != preserve),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    retained_slots = max(0, OUTPUT_RETENTION_MAX_JOBS - (1 if preserve is not None else 0))
    for index, directory in enumerate(directories):
        try:
            expired = now - directory.stat().st_mtime > OUTPUT_RETENTION_MAX_AGE_SECONDS
            over_limit = index >= retained_slots
            if expired or over_limit:
                shutil.rmtree(directory)
        except FileNotFoundError:
            continue


def report_progress(progress: float, detail: str, stage: str, context: dict | None = None) -> None:
    payload = {"progress": progress, "detail": detail, "stage": stage}
    if context:
        payload["context"] = context
    print(f"RUKTER_PROGRESS {json.dumps(payload)}", flush=True)


def frame_to_image(frame) -> Image.Image:
    if isinstance(frame, Image.Image):
        return frame.convert("RGB")
    array = np.asarray(frame)
    if array.ndim != 3 or array.shape[-1] not in (3, 4):
        raise RuntimeError(f"Unsupported generated frame shape: {array.shape}")
    if np.issubdtype(array.dtype, np.floating):
        finite = np.nan_to_num(array, nan=0.0, posinf=1.0, neginf=0.0)
        if finite.size and float(finite.max()) <= 1.0 and float(finite.min()) >= 0.0:
            finite = finite * 255.0
        array = finite
    array = np.clip(array, 0, 255).astype(np.uint8)
    return Image.fromarray(array).convert("RGB")


def load_source(url: str) -> Image.Image:
    response = requests.get(url, timeout=30)
    response.raise_for_status()
    with tempfile.NamedTemporaryFile(suffix=".img") as handle:
        handle.write(response.content)
        handle.flush()
        return Image.open(handle.name).convert("RGB")


def output_size(aspect: str) -> tuple[int, int]:
    if aspect == "9:16":
        return 544, 960
    if aspect == "1:1":
        return 544, 544
    return 960, 544


def resize_cover(image: Image.Image, width: int, height: int) -> Image.Image:
    scale = max(width / image.width, height / image.height)
    resized = image.resize((math.ceil(image.width * scale), math.ceil(image.height * scale)), Image.Resampling.LANCZOS)
    left = max(0, (resized.width - width) // 2)
    top = max(0, (resized.height - height) // 2)
    return resized.crop((left, top, left + width, top + height))


def image_feature_tensor(features) -> torch.Tensor:
    if isinstance(features, torch.Tensor):
        return features
    for attribute in ("pooler_output", "image_embeds", "last_hidden_state"):
        value = getattr(features, attribute, None)
        if isinstance(value, torch.Tensor):
            if value.ndim == 3:
                return value[:, 0, :]
            return value
    raise RuntimeError(f"CLIP image features did not contain a tensor: {type(features).__name__}")


def identity_evidence(source: Image.Image, frames: list[Image.Image], clip_model, clip_processor) -> dict:
    samples = [frames[0], frames[len(frames) // 2], frames[-1]]
    inputs = clip_processor(images=[source, *samples], return_tensors="pt")
    inputs = {key: value.to("cuda") for key, value in inputs.items()}
    with torch.inference_mode():
        features = image_feature_tensor(clip_model.get_image_features(**inputs))
        features = features / features.norm(dim=-1, keepdim=True)
    similarities = (features[1:] @ features[0]).detach().float().cpu().tolist()
    source_ocr = product_ocr_evidence(source)
    sampled_ocr = [product_ocr_evidence(frame) for frame in samples]
    source_tokens = source_ocr["productTokens"]
    sampled_tokens = [sample["productTokens"] for sample in sampled_ocr]
    retention = 1.0 if not source_tokens else min(len(source_tokens & tokens) / len(source_tokens) for tokens in sampled_tokens)
    clip_similarity_min = min(similarities)
    source_token_count = len(source_tokens)
    ocr_retention_required = requires_ocr_retention(
        source_token_count,
        clip_similarity_min,
        IDENTITY_CLIP_FALLBACK_THRESHOLD,
        OCR_RETENTION_MIN_TOKENS,
    )
    if not source_tokens:
        ocr_retention_reason = "no_source_ocr"
    elif source_token_count < OCR_RETENTION_MIN_TOKENS:
        ocr_retention_reason = "insufficient_source_ocr_tokens"
    elif ocr_retention_required:
        ocr_retention_reason = "required_below_clip_fallback"
    else:
        ocr_retention_reason = "clip_similarity_fallback"
    verified = clip_similarity_min >= IDENTITY_THRESHOLD and (not ocr_retention_required or retention >= OCR_RETENTION_THRESHOLD)
    return {
        "identityVerified": verified,
        "clipSimilarityMin": round(clip_similarity_min, 4),
        "clipSimilaritySamples": [round(value, 4) for value in similarities],
        "sourceOcrTokenCount": source_token_count,
        "sourceAnnotationOcrTokenCount": source_ocr["annotationTokenCount"],
        "ocrEvidenceMode": source_ocr["mode"],
        "ocrRetentionMin": round(retention, 4),
        "ocrRetentionRequired": ocr_retention_required,
        "ocrRetentionThreshold": OCR_RETENTION_THRESHOLD,
        "ocrRetentionMinTokens": OCR_RETENTION_MIN_TOKENS,
        "ocrRetentionReason": ocr_retention_reason,
        "clipFallbackThreshold": IDENTITY_CLIP_FALLBACK_THRESHOLD,
        "threshold": IDENTITY_THRESHOLD,
    }


def wan_frame_count(duration_seconds: int) -> int:
    maximum = max(17, min(81, ((MAX_NUM_FRAMES - 1) // 4) * 4 + 1))
    requested = ((max(1, duration_seconds) * FPS + 3) // 4) * 4 + 1
    return max(17, min(maximum, requested))


def compose(clips: list[Path], output_path: Path, duration_seconds: float) -> None:
    concat_path = output_path.with_suffix(".txt")
    concat_path.write_text("".join(f"file '{clip.as_posix()}'\n" for clip in clips), encoding="utf-8")
    command = [
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_path),
        "-vf", "eq=contrast=1.05:saturation=1.08,format=yuv420p",
        "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-movflags", "+faststart",
        "-t", f"{duration_seconds:.3f}", str(output_path),
    ]
    subprocess.run(command, check=True)


def upload_video(video_path: Path, job_id: str) -> str:
    upload_url = os.environ["OUTPUT_UPLOAD_URL"]
    token = os.getenv("WORKER_TOKEN", "")
    with video_path.open("rb") as handle:
        response = requests.post(
            upload_url,
            data=handle,
            headers={
                "authorization": f"Bearer {token}",
                "content-type": "video/mp4",
                "x-rukter-job-id": job_id,
            },
            timeout=180,
        )
    response.raise_for_status()
    payload = response.json()
    if not payload.get("url"):
        raise RuntimeError("Rukter output upload did not return a URL.")
    return payload["url"]


def main() -> None:
    input_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    request = json.loads(input_path.read_text(encoding="utf-8"))
    story = request["story"]
    shots = story.get("shots", [])
    if not shots:
        raise RuntimeError("The cinematic storyboard contains no shots.")

    width, height = output_size(story.get("aspect", "9:16"))
    total_shots = len(shots)
    report_progress(
        16,
        "Loading Wan 2.2 text-image-to-video and CLIP identity models on AMD ROCm",
        "model_loading",
        {"model": MODEL_ID, "runtime": "AMD ROCm", "backend": "Diffusers"},
    )
    vae = AutoencoderKLWan.from_pretrained(MODEL_ID, subfolder="vae", torch_dtype=torch.float32)
    pipe = WanImageToVideoPipeline.from_pretrained(MODEL_ID, vae=vae, torch_dtype=torch.bfloat16)
    pipe.to("cuda")
    clip_model = CLIPModel.from_pretrained(CLIP_MODEL_ID).to("cuda").eval()
    clip_processor = CLIPProcessor.from_pretrained(CLIP_MODEL_ID)
    report_progress(19, "Wan 2.2 is ready; starting text-guided image-to-video generation", "video_generation")

    evidence = []
    clips = []
    generated_frame_counts = []
    job_id = hashlib.sha256(input_path.read_bytes()).hexdigest()[:20]
    output_directory = OUTPUT_ROOT / job_id
    output_directory.mkdir(parents=True, exist_ok=True)
    cleanup_output_directories(preserve=output_directory)

    for index, shot in enumerate(shots):
        shot_start = 20 + (index * 68 / total_shots)
        prompt_excerpt = str(shot.get("cinematicPrompt", ""))[:180]
        report_progress(
            round(shot_start, 1),
            f"Generating text-guided video shot {index + 1} of {total_shots} on AMD GPU",
            "video_generation",
            {"shot": index + 1, "totalShots": total_shots, "prompt": prompt_excerpt},
        )
        source = resize_cover(load_source(shot["sourceUrl"]), width, height)
        duration = max(3, min(5, int(shot.get("generation", {}).get("durationSeconds", 3))))
        num_frames = wan_frame_count(duration)
        last_evidence = None
        verified_frames = None
        verified_clip_path = None
        for attempt in range(IDENTITY_RETRY_ATTEMPTS):
            retrying = attempt > 0
            if retrying:
                report_progress(
                    round(min(91.5, shot_start + (attempt * 6 / max(1, total_shots))), 1),
                    f"Retrying shot {index + 1} with stricter product identity lock",
                    "video_generation",
                    {"shot": index + 1, "totalShots": total_shots, "attempt": attempt + 1, "maxAttempts": IDENTITY_RETRY_ATTEMPTS},
                )
            prompt = str(shot["cinematicPrompt"]) + (IDENTITY_RETRY_PROMPT if retrying else "")
            negative_prompt = str(shot["negativePrompt"]) + (IDENTITY_RETRY_NEGATIVE if retrying else "")
            generator = torch.Generator(device="cuda").manual_seed(4100 + index + attempt * 997)
            result = pipe(
                image=source,
                prompt=prompt,
                negative_prompt=negative_prompt,
                height=height,
                width=width,
                num_frames=num_frames,
                num_inference_steps=INFERENCE_STEPS,
                guidance_scale=4.4 if retrying else 5.0,
                generator=generator,
            )
            frames = [frame_to_image(frame) for frame in result.frames[0]]
            clip_path = output_directory / f"shot-{index + 1}.mp4"
            export_to_video(frames, str(clip_path), fps=FPS, quality=9)
            report_progress(
                round(shot_start + (54 / total_shots), 1),
                f"Comparing generated shot {index + 1} with the source product using CLIP and OCR",
                "identity_check",
                {"shot": index + 1, "totalShots": total_shots, "attempt": attempt + 1, "maxAttempts": IDENTITY_RETRY_ATTEMPTS},
            )
            shot_evidence = {
                "id": shot.get("id", f"shot-{index + 1}"),
                "clipUrl": "",
                "attempt": attempt + 1,
                "maxAttempts": IDENTITY_RETRY_ATTEMPTS,
                **identity_evidence(source, frames, clip_model, clip_processor),
            }
            last_evidence = shot_evidence
            if shot_evidence["identityVerified"]:
                verified_frames = frames
                verified_clip_path = clip_path
                break
            if attempt < IDENTITY_RETRY_ATTEMPTS - 1:
                report_progress(
                    round(min(91.5, shot_start + (60 / total_shots)), 1),
                    f"Identity check rejected shot {index + 1}; retrying before failing the job",
                    "identity_check",
                    {"shot": index + 1, "totalShots": total_shots, "attempt": attempt + 1, "maxAttempts": IDENTITY_RETRY_ATTEMPTS},
                )
        if not last_evidence or not last_evidence["identityVerified"] or verified_frames is None or verified_clip_path is None:
            raise RuntimeError(f"Product identity verification failed for shot {index + 1}: {last_evidence}")
        evidence.append(last_evidence)
        generated_frame_counts.append(len(verified_frames))
        clips.append(verified_clip_path)

    final_path = output_directory / "story.mp4"
    report_progress(92, "Composing verified Wan 2.2 shots into the final MP4", "video_composition")
    generated_duration_seconds = sum(generated_frame_counts) / FPS
    requested_duration_seconds = max(1.0, float(story.get("durationSeconds", generated_duration_seconds)))
    output_duration_seconds = min(requested_duration_seconds, generated_duration_seconds)
    compose(clips, final_path, output_duration_seconds)
    report_progress(97, "Uploading the final MP4 before releasing the AMD GPU", "output_upload")
    video_url = upload_video(final_path, job_id)
    result = {
        "videoUrl": video_url,
        "format": "video/mp4",
        "width": width,
        "height": height,
        "durationSeconds": output_duration_seconds,
        "evidence": {
            "identityVerified": all(item["identityVerified"] for item in evidence),
            "shotCount": len(evidence),
            "method": "Wan 2.2 TI2V plus CLIP similarity and OCR retention",
            "model": MODEL_ID,
            "fps": FPS,
            "numFramesPerShot": generated_frame_counts[0],
            "generatedFrameCounts": generated_frame_counts,
            "inferenceSteps": INFERENCE_STEPS,
            "shots": evidence,
        },
    }
    output_path.write_text(json.dumps(result), encoding="utf-8")
    cleanup_output_directories(preserve=output_directory)
    report_progress(100, "AMD Product Story ready", "complete")


if __name__ == "__main__":
    main()
