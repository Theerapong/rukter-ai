import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

import numpy as np
import requests
import torch
from PIL import Image, ImageOps
from diffusers import AutoencoderKLWan, WanImageToVideoPipeline
from diffusers.utils import export_to_video
from identity_guard import edge_intrusion_evidence, product_color_evidence, product_ocr_evidence, requires_ocr_retention
from transformers import CLIPModel, CLIPProcessor


FPS = int(os.getenv("WAN_FPS", "16"))
MAX_NUM_FRAMES = int(os.getenv("WAN_NUM_FRAMES", "81"))
INFERENCE_STEPS = int(os.getenv("WAN_INFERENCE_STEPS", "32"))
STORY_INFERENCE_STEP_BUDGET_PER_PASS = int(os.getenv("WAN_STORY_INFERENCE_STEP_BUDGET_PER_PASS", "120"))
GUIDANCE_SCALE = float(os.getenv("WAN_GUIDANCE_SCALE", "4.5"))
IDENTITY_RETRY_GUIDANCE_SCALE = float(os.getenv("WAN_IDENTITY_RETRY_GUIDANCE_SCALE", "3.5"))
MODEL_ID = os.getenv("WAN_MODEL_ID", "Wan-AI/Wan2.2-TI2V-5B-Diffusers")
CLIP_MODEL_ID = os.getenv("WAN_CLIP_MODEL_ID", "openai/clip-vit-base-patch32")
IDENTITY_THRESHOLD = float(os.getenv("WAN_IDENTITY_THRESHOLD", "0.42"))
IDENTITY_CLIP_FALLBACK_THRESHOLD = float(os.getenv("WAN_IDENTITY_CLIP_FALLBACK_THRESHOLD", "0.90"))
OCR_RETENTION_THRESHOLD = float(os.getenv("WAN_OCR_RETENTION_THRESHOLD", "0.15"))
HUMAN_CONTAMINATION_THRESHOLD = float(os.getenv("WAN_HUMAN_CONTAMINATION_THRESHOLD", "0.225"))
HUMAN_CONTAMINATION_MARGIN = float(os.getenv("WAN_HUMAN_CONTAMINATION_MARGIN", "0.012"))
HUMAN_CONTAMINATION_SOURCE_DELTA = float(os.getenv("WAN_HUMAN_CONTAMINATION_SOURCE_DELTA", "0.020"))
COLOR_DISTRIBUTION_THRESHOLD = float(os.getenv("WAN_COLOR_DISTRIBUTION_THRESHOLD", "0.20"))
EDGE_INTRUSION_THRESHOLD = float(os.getenv("WAN_EDGE_INTRUSION_THRESHOLD", "0.0025"))
OUTPUT_ROOT = Path(os.getenv("RUKTER_OUTPUT_ROOT", "/var/lib/rukter-outputs"))
SOURCE_MAX_BYTES = int(os.getenv("RUKTER_SOURCE_MAX_BYTES", str(8 * 1024 * 1024)))
SOURCE_MAX_PIXELS = int(os.getenv("RUKTER_SOURCE_MAX_PIXELS", "32000000"))
SOURCE_MAX_DIMENSION = int(os.getenv("RUKTER_SOURCE_MAX_DIMENSION", "12000"))
BACKGROUND_TRIM_TOLERANCE = int(os.getenv("WAN_BACKGROUND_TRIM_TOLERANCE", "18"))
BACKGROUND_TRIM_PADDING_RATIO = float(os.getenv("WAN_BACKGROUND_TRIM_PADDING_RATIO", "0.06"))
Image.MAX_IMAGE_PIXELS = SOURCE_MAX_PIXELS
ALLOWED_SOURCE_MIME_TYPES = {
    "image/avif",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
}
HUMAN_CONTAMINATION_PROMPTS = [
    "a person or human figure visible anywhere in the frame",
    "a human face, head, hair, shoulder, or torso entering from a frame edge",
    "a cartoon, anime, or illustrated human character in the frame",
    "a human hand, arm, skin, or body part visible in the frame",
]
HUMAN_OCCLUSION_PROMPTS = [
    "a human hand covering the product",
    "a human arm or finger in front of the product",
    "a person or body part blocking, touching, or overlapping the product",
    "skin, fingers, fingernails, wrist, or forearm occluding an object",
]
CLEAN_PRODUCT_PROMPTS = [
    "isolated retail merchandise centered on an empty studio background",
    "a clean catalog packshot of products",
    "an undisturbed product display on a plain background",
]
ALLOWED_PEOPLE_SAFE_PROMPTS = [
    "a background person standing behind a fully visible separate retail product",
    "an unobstructed foreground product with a person farther in the background",
    "clear depth separation between a complete foreground product and a distant background person",
]
DEFAULT_IDENTITY_LOCKS = (
    "the complete source silhouette and proportions",
    "the visible component count and geometry",
    "the source colors, materials, logos, and packaging text",
)
FAILURE_CODE_CLIP_SIMILARITY = "clip_similarity_below_threshold"
FAILURE_CODE_OCR_RETENTION = "ocr_retention_below_threshold"
FAILURE_CODE_HUMAN_CONTAMINATION = "human_product_occlusion"
FAILURE_CODE_COLOR_DISTRIBUTION = "product_color_distribution_drift"
FAILURE_CODE_EDGE_INTRUSION = "foreign_edge_intrusion"
FAILURE_RETRY_INSTRUCTIONS = {
    FAILURE_CODE_CLIP_SIMILARITY: "reduce camera motion and keep the complete source geometry continuously recognizable",
    FAILURE_CODE_OCR_RETENTION: "keep visible logo and packaging text front-facing, stable, and legible",
    FAILURE_CODE_HUMAN_CONTAMINATION: (
        "remove every newly introduced realistic or illustrated person, face, head, hair, shoulder, torso, "
        "hand, arm, and body part from the frame while preserving source artwork"
    ),
    FAILURE_CODE_COLOR_DISTRIBUTION: "restore the exact source hue and saturation and remove every new foreground or edge color",
    FAILURE_CODE_EDGE_INTRUSION: (
        "remove the unmatched foreground component entering from the frame edge because it is not present in the source"
    ),
}
FAILURE_NEGATIVE_TERMS = {
    FAILURE_CODE_CLIP_SIMILARITY: "changed identity, altered geometry, changed component count, product morphing",
    FAILURE_CODE_OCR_RETENTION: "warped logo, changed label, missing text, unreadable text",
    FAILURE_CODE_HUMAN_CONTAMINATION: (
        "extra foreground figure not present in reference, foreign person entering frame edge, "
        "newly added human-shaped subject, intrusive body part not present in reference"
    ),
    FAILURE_CODE_COLOR_DISTRIBUTION: "recolored product, hue shift, saturation shift, color cast, foreign object, colored artifact",
    FAILURE_CODE_EDGE_INTRUSION: "foreign disconnected edge object not present in source, intrusive extra foreground object",
}
PREVENTIVE_HUMAN_NEGATIVE_TERMS = (
    "extra foreground figure not present in reference, foreign person entering frame edge, "
    "intrusive body part not present in reference"
)
HUMAN_NEGATIVE_PATTERN = re.compile(
    r"\b(?:person|people|human|body|body part|hand|hands|finger|fingers|arm|arms|skin|wrist|forearm|nails|fingernails)\b",
    re.IGNORECASE,
)
HUMAN_PROHIBITION_PATTERN = re.compile(
    r"\bno\s+(?:people|persons?|humans?|hands?|fingers?|arms?|body parts?)"
    r"(?:\s*,\s*no\s+(?:people|persons?|humans?|hands?|fingers?|arms?|body parts?))*[^.]*\.?",
    re.IGNORECASE,
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


def _origin_tuple(value: str) -> tuple[str, str, int]:
    parsed = urlsplit(str(value or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise RuntimeError("Product source origin must be an HTTP(S) URL without embedded credentials.")
    default_port = 443 if parsed.scheme == "https" else 80
    return parsed.scheme, parsed.hostname.lower(), parsed.port or default_port


def configured_source_origin() -> tuple[str, str, int]:
    configured = os.getenv("RUKTER_SOURCE_ORIGIN", "").strip() or os.getenv("OUTPUT_UPLOAD_URL", "").strip()
    if not configured:
        raise RuntimeError("RUKTER_SOURCE_ORIGIN or OUTPUT_UPLOAD_URL is required for safe source loading.")
    return _origin_tuple(configured)


def validate_source_url(url: str) -> str:
    normalized = str(url or "").strip()
    if _origin_tuple(normalized) != configured_source_origin():
        raise RuntimeError("Product source URL must use the configured Rukter source origin.")
    return normalized


def normalized_identity_locks(shot: dict) -> list[str]:
    supplied = shot.get("identityLocks")
    locks = []
    if isinstance(supplied, list):
        for value in supplied[:16]:
            text = " ".join(str(value or "").split())[:240]
            if text and text not in locks:
                locks.append(text)
    return locks or list(DEFAULT_IDENTITY_LOCKS)


def identity_failure_codes(evidence: dict) -> list[str]:
    codes = []
    if float(evidence.get("clipSimilarityMin", 0)) < float(evidence.get("threshold", IDENTITY_THRESHOLD)):
        codes.append(FAILURE_CODE_CLIP_SIMILARITY)
    if evidence.get("ocrRetentionRequired") and float(evidence.get("ocrRetentionMin", 0)) < float(
        evidence.get("ocrRetentionThreshold", OCR_RETENTION_THRESHOLD)
    ):
        codes.append(FAILURE_CODE_OCR_RETENTION)
    if evidence.get("humanContaminationDetected"):
        codes.append(FAILURE_CODE_HUMAN_CONTAMINATION)
    if evidence.get("colorDistributionRequired") and float(evidence.get("colorDistributionMin", 0)) < float(
        evidence.get("colorDistributionThreshold", COLOR_DISTRIBUTION_THRESHOLD)
    ):
        codes.append(FAILURE_CODE_COLOR_DISTRIBUTION)
    if evidence.get("edgeIntrusionDetected"):
        codes.append(FAILURE_CODE_EDGE_INTRUSION)
    return codes


def retry_directives(identity_locks: list[str], failure_codes: list[str], allow_people: bool) -> tuple[str, str]:
    codes = [code for code in failure_codes if code in FAILURE_RETRY_INSTRUCTIONS]
    if not codes:
        codes = [FAILURE_CODE_CLIP_SIMILARITY]
    lock_text = "; ".join(identity_locks)
    instructions = "; ".join(
        "move every person strictly behind the product and remove all hand, body, or clothing contact and overlap"
        if code == FAILURE_CODE_HUMAN_CONTAMINATION and allow_people
        else FAILURE_RETRY_INSTRUCTIONS[code]
        for code in codes
    )
    negative_terms = [
        "hand touching product, body overlapping product, person blocking product, clothing occluding product"
        if code == FAILURE_CODE_HUMAN_CONTAMINATION and allow_people
        else FAILURE_NEGATIVE_TERMS[code]
        for code in codes
    ]
    if not allow_people and FAILURE_CODE_HUMAN_CONTAMINATION not in codes:
        negative_terms.append(PREVENTIVE_HUMAN_NEGATIVE_TERMS)
    prompt = (
        f" Product identity retry. Lock these observed source features: {lock_text}. "
        f"Correct only these local failure modes: {instructions}. Do not redesign or replace any visible product feature."
    )
    return prompt, ", ".join(negative_terms)


def apply_people_policy(prompt: str, negative_prompt: str, allow_people: bool) -> tuple[str, str]:
    if not allow_people:
        return (
            f"{prompt} Shot policy: people and body parts are not allowed and must not occlude the product.",
            negative_prompt,
        )
    filtered_negative = ", ".join(
        term.strip()
        for term in negative_prompt.split(",")
        if term.strip() and not HUMAN_NEGATIVE_PATTERN.search(term)
    )
    filtered_prompt = " ".join(HUMAN_PROHIBITION_PATTERN.sub("", prompt).split())
    return (
        f"{filtered_prompt} Shot policy: people are allowed when directed, but the complete product must remain unobscured and identifiable.",
        filtered_negative,
    )


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
    safe_url = validate_source_url(url)
    with requests.get(safe_url, stream=True, allow_redirects=False, timeout=(5, 30)) as response:
        if 300 <= response.status_code < 400:
            raise RuntimeError("Product source redirects are not allowed.")
        response.raise_for_status()
        content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if content_type not in ALLOWED_SOURCE_MIME_TYPES:
            raise RuntimeError(f"Product source returned unsupported MIME type: {content_type or 'missing'}.")
        declared_size = int(response.headers.get("content-length", "0") or 0)
        if declared_size > SOURCE_MAX_BYTES:
            raise RuntimeError("Product source exceeds the configured byte limit.")
        chunks = []
        total = 0
        for chunk in response.iter_content(chunk_size=64 * 1024):
            if not chunk:
                continue
            total += len(chunk)
            if total > SOURCE_MAX_BYTES:
                raise RuntimeError("Product source exceeds the configured byte limit.")
            chunks.append(chunk)
    if not chunks:
        raise RuntimeError("Product source image is empty.")
    try:
        image = Image.open(io.BytesIO(b"".join(chunks)))
        if (
            image.width < 1
            or image.height < 1
            or image.width > SOURCE_MAX_DIMENSION
            or image.height > SOURCE_MAX_DIMENSION
            or image.width * image.height > SOURCE_MAX_PIXELS
        ):
            raise RuntimeError("Product source exceeds the configured decoded image limits.")
        image.load()
        return image.convert("RGB")
    except RuntimeError:
        raise
    except (OSError, ValueError, Image.DecompressionBombError) as error:
        raise RuntimeError("Product source payload is not a decodable image.") from error


def normalized_dimension(value, fallback: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = fallback
    if parsed <= 0:
        return max(0, fallback)
    bounded = max(256, min(1280, parsed))
    # Wan/Diffusers paths are safest on dimensions aligned to 32px.
    aligned = max(256, (bounded // 32) * 32)
    return aligned


def output_size(story: dict) -> tuple[int, int]:
    output = story.get("output", {})
    width = normalized_dimension(output.get("width"), 0)
    height = normalized_dimension(output.get("height"), 0)
    if width and height:
        return width, height
    aspect = story.get("aspect", "9:16")
    if aspect == "9:16":
        return 544, 960
    if aspect == "1:1":
        return 544, 544
    return 960, 544


def trim_uniform_background(image: Image.Image) -> Image.Image:
    rgb = image.convert("RGB")
    pixels = np.asarray(rgb, dtype=np.int16)
    corners = pixels[
        [0, 0, rgb.height - 1, rgb.height - 1],
        [0, rgb.width - 1, 0, rgb.width - 1],
    ]
    background = np.median(corners, axis=0)
    color_distance = np.max(np.abs(pixels - background), axis=2)
    foreground = color_distance > max(1, BACKGROUND_TRIM_TOLERANCE)
    rows, columns = np.where(foreground)
    if not len(rows) or not len(columns):
        return rgb
    left, right = int(columns.min()), int(columns.max()) + 1
    top, bottom = int(rows.min()), int(rows.max()) + 1
    detected_area = max(1, (right - left) * (bottom - top))
    detected_width_ratio = (right - left) / max(1, rgb.width)
    detected_height_ratio = (bottom - top) / max(1, rgb.height)
    detected_area_ratio = detected_area / max(1, rgb.width * rgb.height)
    # A dark logo, handle, or label on an otherwise light product can look like
    # the only foreground against white. Be conservative: missed trimming only
    # leaves padding, while an over-tight crop can destroy product identity.
    if (
        detected_width_ratio < 0.35
        or detected_height_ratio < 0.35
        or detected_area_ratio < 0.18
    ):
        return rgb
    # The crop must agree with a more sensitive foreground threshold. If the
    # sensitive bounds expand materially, the high threshold probably found
    # only a dark logo/panel inside a light product, so trimming is unsafe.
    sensitive_threshold = max(2, round(max(1, BACKGROUND_TRIM_TOLERANCE) * 0.45))
    sensitive_rows, sensitive_columns = np.where(color_distance > sensitive_threshold)
    if not len(sensitive_rows) or not len(sensitive_columns):
        return rgb
    sensitive_left = int(sensitive_columns.min())
    sensitive_right = int(sensitive_columns.max()) + 1
    sensitive_top = int(sensitive_rows.min())
    sensitive_bottom = int(sensitive_rows.max()) + 1
    boundary_drift = max(
        abs(left - sensitive_left) / max(1, rgb.width),
        abs(right - sensitive_right) / max(1, rgb.width),
        abs(top - sensitive_top) / max(1, rgb.height),
        abs(bottom - sensitive_bottom) / max(1, rgb.height),
    )
    if boundary_drift > 0.08:
        return rgb
    left, right = sensitive_left, sensitive_right
    top, bottom = sensitive_top, sensitive_bottom
    padding = round(max(rgb.width, rgb.height) * max(0.0, min(0.2, BACKGROUND_TRIM_PADDING_RATIO)))
    crop = (
        max(0, left - padding),
        max(0, top - padding),
        min(rgb.width, right + padding),
        min(rgb.height, bottom + padding),
    )
    if crop == (0, 0, rgb.width, rgb.height):
        return rgb
    return rgb.crop(crop)


def resize_contain(image: Image.Image, width: int, height: int, trim_background: bool = True) -> Image.Image:
    rgb = image.convert("RGB")
    framed = trim_uniform_background(rgb) if trim_background else rgb
    contained = ImageOps.contain(framed, (width, height), Image.Resampling.LANCZOS)
    corners = np.asarray(rgb, dtype=np.uint8)[
        [0, 0, image.height - 1, image.height - 1],
        [0, image.width - 1, 0, image.width - 1],
    ]
    background = tuple(int(value) for value in np.median(corners, axis=0))
    canvas = Image.new("RGB", (width, height), background)
    canvas.paste(contained, ((width - contained.width) // 2, (height - contained.height) // 2))
    return canvas


def clip_feature_tensor(features, feature_kind: str) -> torch.Tensor:
    if isinstance(features, torch.Tensor):
        return features
    for attribute in (f"{feature_kind}_embeds", "pooler_output", "last_hidden_state"):
        value = getattr(features, attribute, None)
        if isinstance(value, torch.Tensor):
            if value.ndim == 3:
                return value[:, 0, :]
            return value
    raise RuntimeError(
        f"CLIP {feature_kind} features did not contain a tensor: {type(features).__name__}"
    )


def human_contamination_decision(
    human_scores: np.ndarray,
    clean_scores: np.ndarray,
    source_human_scores: np.ndarray,
    allow_people: bool = False,
) -> dict:
    frame_indices = np.arange(human_scores.shape[0])
    frame_clean = clean_scores.max(axis=1)
    peak_prompt_indices = human_scores.argmax(axis=1)
    peak_human = human_scores[frame_indices, peak_prompt_indices]
    peak_source = source_human_scores[peak_prompt_indices]
    peak_margins = peak_human - frame_clean
    prompt_deltas = human_scores - source_human_scores[np.newaxis, :]
    prompt_novelty_risks = np.where(
        human_scores >= HUMAN_CONTAMINATION_THRESHOLD,
        prompt_deltas / max(HUMAN_CONTAMINATION_SOURCE_DELTA, 1e-6),
        -np.inf,
    )
    novelty_prompt_indices = prompt_novelty_risks.argmax(axis=1)
    novelty_risks = prompt_novelty_risks[frame_indices, novelty_prompt_indices]
    protected_margin_risks = np.where(
        (peak_human >= HUMAN_CONTAMINATION_THRESHOLD)
        & (peak_source < HUMAN_CONTAMINATION_THRESHOLD),
        peak_margins / max(HUMAN_CONTAMINATION_MARGIN, 1e-6),
        -np.inf,
    )
    if allow_people:
        prompt_margin_risks = np.where(
            human_scores >= HUMAN_CONTAMINATION_THRESHOLD,
            (human_scores - frame_clean[:, np.newaxis]) / max(HUMAN_CONTAMINATION_MARGIN, 1e-6),
            -np.inf,
        )
        allowed_prompt_risks = np.where(
            source_human_scores[np.newaxis, :] < HUMAN_CONTAMINATION_THRESHOLD,
            prompt_margin_risks,
            np.minimum(prompt_margin_risks, prompt_novelty_risks),
        )
        selected_prompt_indices = allowed_prompt_risks.argmax(axis=1)
        risks = allowed_prompt_risks[frame_indices, selected_prompt_indices]
        detected_matches = risks >= 1.0
    else:
        novelty_matches = novelty_risks >= 1.0
        margin_matches = protected_margin_risks >= 1.0
        detected_matches = novelty_matches | margin_matches
        use_novelty_prompt = novelty_risks >= protected_margin_risks
        selected_prompt_indices = np.where(
            use_novelty_prompt,
            novelty_prompt_indices,
            peak_prompt_indices,
        )
        risks = np.maximum(protected_margin_risks, novelty_risks)
    detected_indices = np.flatnonzero(detected_matches)
    worst_index = (
        int(detected_indices[np.argmax(risks[detected_indices])])
        if detected_indices.size
        else int(np.argmax(risks))
    )
    selected_prompt_index = int(selected_prompt_indices[worst_index])
    human_score = float(human_scores[worst_index, selected_prompt_index])
    source_score = float(source_human_scores[selected_prompt_index])
    return {
        "detected": bool(detected_matches[worst_index]),
        "worstIndex": worst_index,
        "worstPromptIndex": selected_prompt_index,
        "humanScore": human_score,
        "cleanScore": float(frame_clean[worst_index]),
        "margin": human_score - float(frame_clean[worst_index]),
        "sourceScore": source_score,
        "sourceDelta": human_score - source_score,
    }


def human_contamination_evidence(
    source_feature: torch.Tensor,
    sample_features: torch.Tensor,
    sampled_frame_indices: list[int],
    clip_model,
    clip_processor,
    allow_people: bool = False,
) -> dict:
    human_prompts = HUMAN_OCCLUSION_PROMPTS if allow_people else HUMAN_CONTAMINATION_PROMPTS
    clean_prompts = ALLOWED_PEOPLE_SAFE_PROMPTS if allow_people else CLEAN_PRODUCT_PROMPTS
    text_inputs = clip_processor(
        text=[*human_prompts, *clean_prompts],
        return_tensors="pt",
        padding=True,
        truncation=True,
    )
    text_inputs = {key: value.to("cuda") for key, value in text_inputs.items()}
    with torch.inference_mode():
        text_features = clip_feature_tensor(clip_model.get_text_features(**text_inputs), "text")
        text_features = text_features / text_features.norm(dim=-1, keepdim=True)
    source_scores = (source_feature @ text_features.T).detach().float().cpu().numpy()[0]
    scores = (sample_features @ text_features.T).detach().float().cpu().numpy()
    human_count = len(human_prompts)
    source_human_scores = source_scores[:human_count]
    human_scores = scores[:, :human_count]
    clean_scores = scores[:, human_count:]
    decision = human_contamination_decision(human_scores, clean_scores, source_human_scores, allow_people)
    worst_index = decision["worstIndex"]
    worst_prompt_index = decision["worstPromptIndex"]
    clean_prompt_index = int(np.argmax(clean_scores[worst_index]))
    human_score = decision["humanScore"]
    clean_score = decision["cleanScore"]
    margin = decision["margin"]
    source_score = decision["sourceScore"]
    source_delta = decision["sourceDelta"]
    # `allowPeople` permits background context only. Its prompt bank and
    # decision therefore remain contact/occlusion-specific. Product-only shots
    # also reject newly introduced realistic or illustrated human presence,
    # compared with the source to preserve legitimate source artwork.
    detected = decision["detected"]
    return {
        "humanContaminationDetected": bool(detected),
        "humanContaminationObserved": bool(detected),
        "allowPeople": bool(allow_people),
        "humanPolicy": "background_only" if allow_people else "disallowed",
        "humanContaminationPrompt": human_prompts[worst_prompt_index],
        "humanContaminationCleanPrompt": clean_prompts[clean_prompt_index],
        "humanContaminationSampleIndex": worst_index,
        "humanContaminationFrame": sampled_frame_indices[worst_index],
        "humanContaminationScore": round(human_score, 4),
        "humanContaminationCleanScore": round(clean_score, 4),
        "humanContaminationMargin": round(margin, 4),
        "humanContaminationThreshold": HUMAN_CONTAMINATION_THRESHOLD,
        "humanContaminationMarginThreshold": HUMAN_CONTAMINATION_MARGIN,
        "humanContaminationSourceScore": round(source_score, 4),
        "humanContaminationSourceDelta": round(source_delta, 4),
        "humanContaminationSourceDeltaThreshold": HUMAN_CONTAMINATION_SOURCE_DELTA,
    }


def evenly_spaced_frame_indices(frame_count: int, sample_count: int = 5) -> list[int]:
    if frame_count < 1:
        raise RuntimeError("Identity verification requires at least one generated frame.")
    if frame_count == 1:
        return [0]
    count = max(2, min(sample_count, frame_count))
    return [round(index * (frame_count - 1) / (count - 1)) for index in range(count)]


def identity_evidence(
    source: Image.Image,
    frames: list[Image.Image],
    clip_model,
    clip_processor,
    allow_people: bool = False,
) -> dict:
    sampled_frame_indices = evenly_spaced_frame_indices(len(frames), 5)
    samples = [frames[index] for index in sampled_frame_indices]
    inputs = clip_processor(images=[source, *samples], return_tensors="pt")
    inputs = {key: value.to("cuda") for key, value in inputs.items()}
    with torch.inference_mode():
        features = clip_feature_tensor(clip_model.get_image_features(**inputs), "image")
        features = features / features.norm(dim=-1, keepdim=True)
    sample_features = features[1:]
    similarities = (sample_features @ features[0]).detach().float().cpu().tolist()
    contamination = human_contamination_evidence(
        features[0:1],
        sample_features,
        sampled_frame_indices,
        clip_model,
        clip_processor,
        allow_people=allow_people,
    )
    color_evidence = product_color_evidence(source, samples, COLOR_DISTRIBUTION_THRESHOLD)
    edge_evidence = edge_intrusion_evidence(source, samples, EDGE_INTRUSION_THRESHOLD)
    edge_evidence["edgeIntrusionFrame"] = sampled_frame_indices[edge_evidence["edgeIntrusionSampleIndex"]]
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
    evidence = {
        "clipSimilarityMin": round(clip_similarity_min, 4),
        "clipSimilaritySamples": [round(value, 4) for value in similarities],
        "sampledFrameIndices": sampled_frame_indices,
        "sampleCount": len(samples),
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
        **color_evidence,
        **edge_evidence,
        **contamination,
    }
    evidence["failureCodes"] = identity_failure_codes(evidence)
    evidence["identityVerified"] = not evidence["failureCodes"]
    return evidence


def attempt_evidence(evidence: dict) -> dict:
    return {
        "attempt": evidence.get("attempt"),
        "identityVerified": evidence.get("identityVerified") is True,
        "failureCodes": list(evidence.get("failureCodes", [])),
        "clipSimilarityMin": evidence.get("clipSimilarityMin"),
        "ocrRetentionMin": evidence.get("ocrRetentionMin"),
        "ocrRetentionRequired": evidence.get("ocrRetentionRequired"),
        "humanContaminationDetected": evidence.get("humanContaminationDetected"),
        "humanContaminationObserved": evidence.get("humanContaminationObserved"),
        "humanContaminationFrame": evidence.get("humanContaminationFrame"),
        "humanContaminationScore": evidence.get("humanContaminationScore"),
        "humanContaminationSourceScore": evidence.get("humanContaminationSourceScore"),
        "humanContaminationSourceDelta": evidence.get("humanContaminationSourceDelta"),
        "colorDistributionMin": evidence.get("colorDistributionMin"),
        "colorDistributionRequired": evidence.get("colorDistributionRequired"),
        "edgeIntrusionDetected": evidence.get("edgeIntrusionDetected"),
        "edgeIntrusionAreaMax": evidence.get("edgeIntrusionAreaMax"),
        "edgeIntrusionAreaSamples": list(evidence.get("edgeIntrusionAreaSamples", [])),
        "edgeIntrusionThreshold": evidence.get("edgeIntrusionThreshold"),
        "edgeIntrusionFrame": evidence.get("edgeIntrusionFrame"),
        "edgeIntrusionEdges": list(evidence.get("edgeIntrusionEdges", [])),
        "edgeIntrusionSourceComponentCount": evidence.get("edgeIntrusionSourceComponentCount"),
        "edgeIntrusionComponentCount": evidence.get("edgeIntrusionComponentCount"),
        "edgeIntrusionUnmatchedComponents": list(evidence.get("edgeIntrusionUnmatchedComponents", [])),
        "allowPeople": evidence.get("allowPeople"),
        "sampledFrameIndices": list(evidence.get("sampledFrameIndices", [])),
    }


def wan_frame_count(duration_seconds: int) -> int:
    maximum = max(17, min(81, ((MAX_NUM_FRAMES - 1) // 4) * 4 + 1))
    requested = ((max(1, duration_seconds) * FPS + 3) // 4) * 4 + 1
    return max(17, min(maximum, requested))


def story_inference_steps(total_shots: int) -> int:
    per_shot_budget = max(8, STORY_INFERENCE_STEP_BUDGET_PER_PASS // max(1, total_shots))
    return max(8, min(INFERENCE_STEPS, per_shot_budget))


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

    width, height = output_size(story)
    total_shots = len(shots)
    inference_steps = story_inference_steps(total_shots)
    report_progress(
        16,
        "Loading Wan 2.2 text-image-to-video and CLIP identity models on AMD ROCm",
        "model_loading",
        {"model": MODEL_ID, "runtime": "AMD ROCm", "backend": "Diffusers", "inferenceStepsPerShot": inference_steps},
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
        prompt_excerpt = str(shot.get("renderPrompt") or shot.get("cinematicPrompt", ""))[:180]
        report_progress(
            round(shot_start, 1),
            f"Generating text-guided video shot {index + 1} of {total_shots} on AMD GPU",
            "video_generation",
            {"shot": index + 1, "totalShots": total_shots, "prompt": prompt_excerpt},
        )
        source_image = load_source(shot["sourceUrl"])
        source = resize_contain(source_image, width, height)
        identity_source = resize_contain(source_image, width, height, trim_background=False)
        duration = max(2, min(5, int(float(shot.get("generation", {}).get("durationSeconds", 3)))))
        num_frames = wan_frame_count(duration)
        allow_people = shot.get("allowPeople") is True
        identity_locks = normalized_identity_locks(shot)
        previous_failure_codes = []
        attempt_history = []
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
            prompt = str(shot.get("renderPrompt") or shot["cinematicPrompt"])
            negative_prompt = str(shot.get("negativePrompt", ""))
            prompt, negative_prompt = apply_people_policy(prompt, negative_prompt, allow_people)
            if retrying:
                retry_prompt, retry_negative = retry_directives(identity_locks, previous_failure_codes, allow_people)
                prompt = f"{prompt}{retry_prompt}"
                negative_prompt = ", ".join(value for value in (negative_prompt, retry_negative) if value)
            generator = torch.Generator(device="cuda").manual_seed(4100 + index + attempt * 997)
            result = pipe(
                image=source,
                prompt=prompt,
                negative_prompt=negative_prompt,
                height=height,
                width=width,
                num_frames=num_frames,
                num_inference_steps=inference_steps,
                guidance_scale=IDENTITY_RETRY_GUIDANCE_SCALE if retrying else GUIDANCE_SCALE,
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
                "identityLocks": identity_locks,
                **identity_evidence(identity_source, frames, clip_model, clip_processor, allow_people=allow_people),
            }
            attempt_history.append(attempt_evidence(shot_evidence))
            shot_evidence["attemptHistory"] = list(attempt_history)
            shot_evidence["observedFailureCodes"] = sorted({
                code
                for item in attempt_history
                for code in item.get("failureCodes", [])
            })
            last_evidence = shot_evidence
            if shot_evidence["identityVerified"]:
                verified_frames = frames
                verified_clip_path = clip_path
                break
            previous_failure_codes = list(shot_evidence["failureCodes"])
            if attempt < IDENTITY_RETRY_ATTEMPTS - 1:
                report_progress(
                    round(min(91.5, shot_start + (60 / total_shots)), 1),
                    f"Identity check rejected shot {index + 1}; retrying before failing the job",
                    "identity_check",
                    {"shot": index + 1, "totalShots": total_shots, "attempt": attempt + 1, "maxAttempts": IDENTITY_RETRY_ATTEMPTS},
                )
        if not last_evidence or not last_evidence["identityVerified"] or verified_frames is None or verified_clip_path is None:
            failure_evidence = {
                "identityVerified": False,
                "shot": index + 1,
                "shotId": shot.get("id", f"shot-{index + 1}"),
                "failureCodes": list(last_evidence.get("failureCodes", [])) if last_evidence else [FAILURE_CODE_CLIP_SIMILARITY],
                "observedFailureCodes": list(last_evidence.get("observedFailureCodes", [])) if last_evidence else [FAILURE_CODE_CLIP_SIMILARITY],
                "attemptHistory": list(last_evidence.get("attemptHistory", [])) if last_evidence else [],
                "lastEvidence": last_evidence,
            }
            raise RuntimeError(
                f"Product identity verification failed for shot {index + 1}: {json.dumps(failure_evidence, separators=(',', ':'))}"
            )
        evidence.append(last_evidence)
        generated_frame_counts.append(len(verified_frames))
        clips.append(verified_clip_path)

    final_path = output_directory / "story.mp4"
    report_progress(92, "Composing verified Wan 2.2 shots into the final MP4", "video_composition")
    generated_duration_seconds = sum(generated_frame_counts) / FPS
    requested_duration_seconds = max(1.0, float(story.get("durationSeconds", generated_duration_seconds)))
    output_duration_seconds = min(requested_duration_seconds, generated_duration_seconds)
    compose(clips, final_path, output_duration_seconds)
    report_progress(97, "Uploading the final MP4; the persistent AMD worker remains online", "output_upload")
    video_url = upload_video(final_path, job_id)
    result = {
        "videoUrl": video_url,
        "format": "video/mp4",
        "width": width,
        "height": height,
        "durationSeconds": output_duration_seconds,
        "evidence": {
            "identityVerified": all(item["identityVerified"] for item in evidence),
            "failureCodes": [],
            "observedFailureCodes": sorted({
                code
                for item in evidence
                for code in item.get("observedFailureCodes", [])
            }),
            "attemptHistory": [
                {"shotId": item["id"], "attempts": item.get("attemptHistory", [])}
                for item in evidence
            ],
            "shotCount": len(evidence),
            "method": (
                "Wan 2.2 TI2V plus five-frame CLIP similarity, OCR retention, color distribution, "
                "foreign edge intrusion, and shot policy checks"
            ),
            "model": MODEL_ID,
            "fps": FPS,
            "numFramesPerShot": generated_frame_counts[0],
            "generatedFrameCounts": generated_frame_counts,
            "inferenceSteps": inference_steps,
            "shots": evidence,
        },
    }
    output_path.write_text(json.dumps(result), encoding="utf-8")
    cleanup_output_directories(preserve=output_directory)
    report_progress(100, "AMD Product Story ready", "complete")


if __name__ == "__main__":
    main()
