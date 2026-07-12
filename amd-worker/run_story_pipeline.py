import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import pytesseract
import requests
import torch
from PIL import Image
from diffusers import AutoencoderKLWan, WanImageToVideoPipeline
from diffusers.utils import export_to_video
from transformers import CLIPModel, CLIPProcessor


FPS = int(os.getenv("WAN_FPS", "16"))
NUM_FRAMES = int(os.getenv("WAN_NUM_FRAMES", "49"))
INFERENCE_STEPS = int(os.getenv("WAN_INFERENCE_STEPS", "16"))
MODEL_ID = os.getenv("WAN_MODEL_ID", "Wan-AI/Wan2.2-TI2V-5B-Diffusers")
CLIP_MODEL_ID = os.getenv("WAN_CLIP_MODEL_ID", "openai/clip-vit-base-patch32")
IDENTITY_THRESHOLD = float(os.getenv("WAN_IDENTITY_THRESHOLD", "0.42"))
IDENTITY_CLIP_FALLBACK_THRESHOLD = float(os.getenv("WAN_IDENTITY_CLIP_FALLBACK_THRESHOLD", "0.90"))


def report_progress(progress: int, detail: str) -> None:
    print(f"RUKTER_PROGRESS {json.dumps({'progress': progress, 'detail': detail})}", flush=True)


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


def normalized_tokens(image: Image.Image) -> set[str]:
    text = pytesseract.image_to_string(image)
    return {token.lower() for token in re.findall(r"[A-Za-z0-9]{3,}", text)}


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
    source_tokens = normalized_tokens(source)
    sampled_tokens = [normalized_tokens(frame) for frame in samples]
    retention = 1.0 if not source_tokens else min(len(source_tokens & tokens) / len(source_tokens) for tokens in sampled_tokens)
    clip_similarity_min = min(similarities)
    ocr_retention_required = bool(source_tokens) and clip_similarity_min < IDENTITY_CLIP_FALLBACK_THRESHOLD
    verified = clip_similarity_min >= IDENTITY_THRESHOLD and (not ocr_retention_required or retention >= 0.15)
    return {
        "identityVerified": verified,
        "clipSimilarityMin": round(clip_similarity_min, 4),
        "clipSimilaritySamples": [round(value, 4) for value in similarities],
        "sourceOcrTokenCount": len(source_tokens),
        "ocrRetentionMin": round(retention, 4),
        "ocrRetentionRequired": ocr_retention_required,
        "clipFallbackThreshold": IDENTITY_CLIP_FALLBACK_THRESHOLD,
        "threshold": IDENTITY_THRESHOLD,
    }


def compose(clips: list[Path], output_path: Path) -> None:
    concat_path = output_path.with_suffix(".txt")
    concat_path.write_text("".join(f"file '{clip.as_posix()}'\n" for clip in clips), encoding="utf-8")
    subprocess.run(
        [
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_path),
            "-vf", "eq=contrast=1.05:saturation=1.08,format=yuv420p",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-movflags", "+faststart", str(output_path),
        ],
        check=True,
    )


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
    report_progress(16, "Loading Wan 2.2 and CLIP identity models on AMD GPU")
    vae = AutoencoderKLWan.from_pretrained(MODEL_ID, subfolder="vae", torch_dtype=torch.float32)
    pipe = WanImageToVideoPipeline.from_pretrained(MODEL_ID, vae=vae, torch_dtype=torch.bfloat16)
    pipe.to("cuda")
    clip_model = CLIPModel.from_pretrained(CLIP_MODEL_ID).to("cuda").eval()
    clip_processor = CLIPProcessor.from_pretrained(CLIP_MODEL_ID)
    report_progress(19, "AMD models ready; generating directed motion shots")

    evidence = []
    clips = []
    job_id = hashlib.sha256(input_path.read_bytes()).hexdigest()[:20]
    output_directory = Path("/var/lib/rukter-outputs") / job_id
    output_directory.mkdir(parents=True, exist_ok=True)

    for index, shot in enumerate(shots):
        shot_start = 20 + round(index * 68 / total_shots)
        report_progress(shot_start, f"Generating shot {index + 1} of {total_shots} on AMD GPU")
        source = resize_cover(load_source(shot["sourceUrl"]), width, height)
        duration = max(3, min(5, int(shot.get("generation", {}).get("durationSeconds", 3))))
        num_frames = max(17, min(81, ((NUM_FRAMES - 1) // 4) * 4 + 1))
        generator = torch.Generator(device="cuda").manual_seed(4100 + index)
        result = pipe(
            image=source,
            prompt=shot["cinematicPrompt"],
            negative_prompt=shot["negativePrompt"],
            height=height,
            width=width,
            num_frames=num_frames,
            num_inference_steps=INFERENCE_STEPS,
            guidance_scale=5.0,
            generator=generator,
        )
        frames = [frame_to_image(frame) for frame in result.frames[0]]
        clip_path = output_directory / f"shot-{index + 1}.mp4"
        export_to_video(frames, str(clip_path), fps=FPS, quality=9)
        report_progress(shot_start + round(54 / total_shots), f"Verifying product identity for shot {index + 1} of {total_shots}")
        shot_evidence = identity_evidence(source, frames, clip_model, clip_processor)
        evidence.append({"id": shot.get("id", f"shot-{index + 1}"), "clipUrl": "", **shot_evidence})
        if not shot_evidence["identityVerified"]:
            raise RuntimeError(f"Product identity verification failed for shot {index + 1}: {shot_evidence}")
        clips.append(clip_path)

    final_path = output_directory / "story.mp4"
    report_progress(92, "Composing verified cinematic shots into the final MP4")
    compose(clips, final_path)
    report_progress(97, "Uploading the final MP4")
    video_url = upload_video(final_path, job_id)
    result = {
        "videoUrl": video_url,
        "format": "video/mp4",
        "width": width,
        "height": height,
        "durationSeconds": sum(max(3, min(5, int(shot.get("generation", {}).get("durationSeconds", 3)))) for shot in shots),
        "evidence": {
            "identityVerified": all(item["identityVerified"] for item in evidence),
            "shotCount": len(evidence),
            "method": "Wan 2.2 TI2V plus CLIP similarity and OCR retention",
            "model": MODEL_ID,
            "fps": FPS,
            "numFramesPerShot": NUM_FRAMES,
            "inferenceSteps": INFERENCE_STEPS,
            "shots": evidence,
        },
    }
    output_path.write_text(json.dumps(result), encoding="utf-8")
    report_progress(100, "AMD Product Story ready")


if __name__ == "__main__":
    main()
