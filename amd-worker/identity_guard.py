import os
import re
from dataclasses import dataclass

import numpy as np
from PIL import Image


TOKEN_PATTERN = re.compile(r"[^\W_][\w\u0E00-\u0E7F._-]{1,}", re.UNICODE)
OCR_LANGUAGES = os.getenv("WAN_OCR_LANGUAGES", "eng+tha")
OCR_CONFIDENCE_MIN = float(os.getenv("WAN_OCR_CONFIDENCE_MIN", "45"))
PRODUCT_COMPONENT_MIN_AREA_RATIO = float(os.getenv("WAN_PRODUCT_COMPONENT_MIN_AREA_RATIO", "0.004"))
PRODUCT_COMPONENT_MIN_BBOX_RATIO = float(os.getenv("WAN_PRODUCT_COMPONENT_MIN_BBOX_RATIO", "0.018"))
PRODUCT_TOKEN_OVERLAP_MIN = float(os.getenv("WAN_PRODUCT_TOKEN_OVERLAP_MIN", "0.08"))
PRODUCT_COLOR_MIN_CHROMATIC_RATIO = float(os.getenv("WAN_COLOR_MIN_CHROMATIC_RATIO", "0.015"))
PRODUCT_COLOR_MIN_PIXELS = int(os.getenv("WAN_COLOR_MIN_PIXELS", "50"))
PRODUCT_EDGE_INTRUSION_THRESHOLD = float(os.getenv("WAN_EDGE_INTRUSION_THRESHOLD", "0.0025"))
PRODUCT_EDGE_COMPONENT_MIN_AREA_RATIO = 0.0005
PRODUCT_EDGE_OUTER_CENTROID_RATIO = 0.20
PRODUCT_EDGE_MATCH_MIN_AREA_SCALE = 0.30
PRODUCT_EDGE_MATCH_MIN_ASPECT_SCALE = 0.30
PRODUCT_EDGE_MATCH_MIN_COLOR_OVERLAP = 0.30


@dataclass(frozen=True)
class OcrToken:
    text: str
    left: int
    top: int
    width: int
    height: int
    confidence: float = 100.0

    @property
    def normalized(self) -> set[str]:
        return {token.casefold() for token in TOKEN_PATTERN.findall(self.text or "")}


def _image_array(image: Image.Image) -> np.ndarray:
    return np.asarray(image.convert("RGB"), dtype=np.int16)


def _foreground_mask(image: Image.Image) -> np.ndarray:
    array = _image_array(image)
    height, width = array.shape[:2]
    margin_y = max(1, height // 20)
    margin_x = max(1, width // 20)
    border = np.concatenate(
        [
            array[:margin_y, :, :].reshape(-1, 3),
            array[-margin_y:, :, :].reshape(-1, 3),
            array[:, :margin_x, :].reshape(-1, 3),
            array[:, -margin_x:, :].reshape(-1, 3),
        ],
        axis=0,
    )
    background = np.median(border, axis=0)
    diff = np.linalg.norm(array - background, axis=2)
    channel_span = array.max(axis=2) - array.min(axis=2)
    brightness = array.mean(axis=2)
    return (diff > 35) | ((channel_span > 45) & (brightness < 245))


def _component_stats(mask: np.ndarray) -> tuple[int, np.ndarray, list[tuple[int, int, int, int, int]]]:
    try:
        import cv2

        count, labels, stats, _ = cv2.connectedComponentsWithStats(mask.astype("uint8"), 8)
        components = [
            (int(stats[label, cv2.CC_STAT_LEFT]), int(stats[label, cv2.CC_STAT_TOP]),
             int(stats[label, cv2.CC_STAT_WIDTH]), int(stats[label, cv2.CC_STAT_HEIGHT]),
             int(stats[label, cv2.CC_STAT_AREA]))
            for label in range(1, count)
        ]
        return count, labels, components
    except Exception:
        return _component_stats_fallback(mask)


def _component_stats_fallback(mask: np.ndarray) -> tuple[int, np.ndarray, list[tuple[int, int, int, int, int]]]:
    height, width = mask.shape
    labels = np.zeros((height, width), dtype=np.int32)
    components: list[tuple[int, int, int, int, int]] = []
    label = 0
    for y in range(height):
        for x in range(width):
            if not mask[y, x] or labels[y, x]:
                continue
            label += 1
            stack = [(x, y)]
            labels[y, x] = label
            min_x = max_x = x
            min_y = max_y = y
            area = 0
            while stack:
                current_x, current_y = stack.pop()
                area += 1
                min_x = min(min_x, current_x)
                max_x = max(max_x, current_x)
                min_y = min(min_y, current_y)
                max_y = max(max_y, current_y)
                for next_x in (current_x - 1, current_x, current_x + 1):
                    for next_y in (current_y - 1, current_y, current_y + 1):
                        if (
                            next_x < 0 or next_y < 0 or next_x >= width or next_y >= height
                            or labels[next_y, next_x] or not mask[next_y, next_x]
                        ):
                            continue
                        labels[next_y, next_x] = label
                        stack.append((next_x, next_y))
            components.append((min_x, min_y, max_x - min_x + 1, max_y - min_y + 1, area))
    return label + 1, labels, components


def product_foreground_mask(image: Image.Image) -> np.ndarray:
    mask = _foreground_mask(image)
    height, width = mask.shape
    image_area = max(1, height * width)
    _, labels, components = _component_stats(mask)
    product_labels: set[int] = set()
    for label, (left, top, component_width, component_height, area) in enumerate(components, start=1):
        area_ratio = area / image_area
        bbox_area = max(1, component_width * component_height)
        bbox_ratio = bbox_area / image_area
        fill_ratio = area / bbox_area
        is_editorial_banner = top <= height * 0.03 and component_width >= width * 0.65 and component_height <= height * 0.20
        is_footer_caption = top >= height * 0.78 and component_height <= height * 0.16 and area_ratio < 0.025
        is_sparse_annotation = fill_ratio < 0.16 and (component_width >= width * 0.18 or component_height >= height * 0.18)
        if is_editorial_banner or is_footer_caption or is_sparse_annotation:
            continue
        if area_ratio >= PRODUCT_COMPONENT_MIN_AREA_RATIO or bbox_ratio >= PRODUCT_COMPONENT_MIN_BBOX_RATIO:
            product_labels.add(label)
    if not product_labels:
        return np.zeros(mask.shape, dtype=bool)
    return np.isin(labels, list(product_labels))


def product_color_signature(image: Image.Image) -> tuple[np.ndarray | None, float]:
    """Return a foreground HSV distribution that is insensitive to product position."""
    rgb = image.convert("RGB")
    foreground = product_foreground_mask(rgb)
    hsv = np.asarray(rgb.convert("HSV"), dtype=np.uint8)
    chromatic = foreground & (hsv[:, :, 1] >= 20) & (hsv[:, :, 2] >= 15)
    chromatic_ratio = float(chromatic.mean())
    values = hsv[chromatic]
    minimum_pixels = max(PRODUCT_COLOR_MIN_PIXELS, round(hsv.shape[0] * hsv.shape[1] * PRODUCT_COLOR_MIN_CHROMATIC_RATIO))
    if len(values) < minimum_pixels:
        return None, chromatic_ratio
    histogram, _ = np.histogramdd(
        values,
        bins=(18, 5, 5),
        range=((0, 256), (0, 256), (0, 256)),
    )
    histogram = histogram.astype(np.float64)
    histogram /= max(1.0, float(histogram.sum()))
    return histogram, chromatic_ratio


def product_color_evidence(source: Image.Image, samples: list[Image.Image], threshold: float = 0.20) -> dict:
    source_signature, source_ratio = product_color_signature(source)
    required = source_signature is not None
    similarities: list[float] = []
    if required:
        for sample in samples:
            sample_signature, _ = product_color_signature(sample)
            similarity = 0.0 if sample_signature is None else float(np.minimum(source_signature, sample_signature).sum())
            similarities.append(similarity)
    minimum = min(similarities) if similarities else 1.0
    return {
        "colorDistributionMin": round(minimum, 4),
        "colorDistributionSamples": [round(value, 4) for value in similarities],
        "colorDistributionRequired": required,
        "colorDistributionThreshold": float(threshold),
        "sourceChromaticRatio": round(source_ratio, 4),
    }


def _edge_component_descriptors(image: Image.Image) -> list[dict]:
    """Describe foreground components so generated objects can be matched to the source."""
    rgb = image.convert("RGB")
    mask = _foreground_mask(rgb)
    height, width = mask.shape
    image_area = max(1, height * width)
    _, labels, components = _component_stats(mask)
    hsv = np.asarray(rgb.convert("HSV"), dtype=np.uint8)
    descriptors = []
    for label, (left, top, component_width, component_height, area) in enumerate(components, start=1):
        area_ratio = area / image_area
        if area_ratio < PRODUCT_EDGE_COMPONENT_MIN_AREA_RATIO:
            continue
        pixels = hsv[labels == label]
        histogram, _ = np.histogramdd(
            pixels,
            bins=(12, 4, 4),
            range=((0, 256), (0, 256), (0, 256)),
        )
        histogram = histogram.astype(np.float64)
        histogram /= max(1.0, float(histogram.sum()))
        center_x = left + component_width / 2
        center_y = top + component_height / 2
        edges = []
        if left <= 1:
            edges.append("left")
        if left + component_width >= width - 1:
            edges.append("right")
        if top <= 1:
            edges.append("top")
        if top + component_height >= height - 1:
            edges.append("bottom")
        spans_opposite_edges = (
            ("left" in edges and "right" in edges)
            or ("top" in edges and "bottom" in edges)
        )
        descriptors.append({
            "areaRatio": area_ratio,
            "aspectRatio": component_width / max(1, component_height),
            "bbox": [left, top, component_width, component_height],
            "edges": edges,
            "outer": bool(edges) and not spans_opposite_edges and (
                center_x < width * PRODUCT_EDGE_OUTER_CENTROID_RATIO
                or center_x > width * (1 - PRODUCT_EDGE_OUTER_CENTROID_RATIO)
                or center_y < height * PRODUCT_EDGE_OUTER_CENTROID_RATIO
                or center_y > height * (1 - PRODUCT_EDGE_OUTER_CENTROID_RATIO)
            ),
            "histogram": histogram,
        })
    return descriptors


def _edge_component_match_score(sample: dict, source: dict) -> float | None:
    area_scale = min(sample["areaRatio"], source["areaRatio"]) / max(sample["areaRatio"], source["areaRatio"])
    aspect_scale = min(sample["aspectRatio"], source["aspectRatio"]) / max(
        sample["aspectRatio"], source["aspectRatio"]
    )
    color_overlap = float(np.minimum(sample["histogram"], source["histogram"]).sum())
    if (
        area_scale < PRODUCT_EDGE_MATCH_MIN_AREA_SCALE
        or aspect_scale < PRODUCT_EDGE_MATCH_MIN_ASPECT_SCALE
        or color_overlap < PRODUCT_EDGE_MATCH_MIN_COLOR_OVERLAP
    ):
        return None
    return area_scale + aspect_scale + color_overlap


def _unmatched_outer_edge_components(source: list[dict], sample: list[dict]) -> list[dict]:
    """One source component can explain at most one generated component."""
    compatible_pairs = []
    for sample_index, component in enumerate(sample):
        for source_index, source_component in enumerate(source):
            score = _edge_component_match_score(component, source_component)
            if score is not None:
                compatible_pairs.append((score, sample_index, source_index))
    matched_sample = set()
    matched_source = set()
    for _, sample_index, source_index in sorted(compatible_pairs, reverse=True):
        if sample_index in matched_sample or source_index in matched_source:
            continue
        matched_sample.add(sample_index)
        matched_source.add(source_index)
    return [
        component
        for sample_index, component in enumerate(sample)
        if sample_index not in matched_sample and component["outer"]
    ]


def _edge_component_evidence(component: dict) -> dict:
    return {
        "areaRatio": round(float(component["areaRatio"]), 5),
        "bbox": list(component["bbox"]),
        "edges": list(component["edges"]),
    }


def edge_intrusion_evidence(
    source: Image.Image,
    samples: list[Image.Image],
    threshold: float = PRODUCT_EDGE_INTRUSION_THRESHOLD,
) -> dict:
    source_components = _edge_component_descriptors(source)
    unmatched_samples = [
        _unmatched_outer_edge_components(source_components, _edge_component_descriptors(sample))
        for sample in samples
    ]
    areas = [sum(component["areaRatio"] for component in components) for components in unmatched_samples]
    worst_index = int(np.argmax(areas)) if areas else 0
    maximum = areas[worst_index] if areas else 0.0
    worst_components = unmatched_samples[worst_index] if unmatched_samples else []
    worst_edges = sorted({edge for component in worst_components for edge in component["edges"]})
    return {
        "edgeIntrusionDetected": maximum >= threshold,
        "edgeIntrusionAreaMax": round(maximum, 5),
        "edgeIntrusionAreaSamples": [round(value, 5) for value in areas],
        "edgeIntrusionSourceComponentCount": len(source_components),
        "edgeIntrusionThreshold": float(threshold),
        "edgeIntrusionSampleIndex": worst_index,
        "edgeIntrusionEdges": worst_edges,
        "edgeIntrusionComponentCount": len(worst_components),
        "edgeIntrusionUnmatchedComponents": [
            _edge_component_evidence(component) for component in worst_components
        ],
    }


def ocr_tokens_from_image(image: Image.Image) -> list[OcrToken]:
    import pytesseract

    try:
        data = pytesseract.image_to_data(image, lang=OCR_LANGUAGES, output_type=pytesseract.Output.DICT)
    except pytesseract.TesseractError:
        data = pytesseract.image_to_data(image, lang="eng", output_type=pytesseract.Output.DICT)
    tokens: list[OcrToken] = []
    for index, text in enumerate(data.get("text", [])):
        try:
            confidence = float(data.get("conf", ["-1"])[index])
        except (TypeError, ValueError):
            confidence = -1.0
        token = OcrToken(
            text=str(text or ""),
            left=int(data.get("left", [0])[index] or 0),
            top=int(data.get("top", [0])[index] or 0),
            width=int(data.get("width", [0])[index] or 0),
            height=int(data.get("height", [0])[index] or 0),
            confidence=confidence,
        )
        if token.confidence >= OCR_CONFIDENCE_MIN and token.normalized:
            tokens.append(token)
    return tokens


def _token_overlaps_product(token: OcrToken, product_mask: np.ndarray) -> bool:
    if token.width <= 0 or token.height <= 0:
        return False
    height, width = product_mask.shape
    left = max(0, min(width, token.left))
    top = max(0, min(height, token.top))
    right = max(left, min(width, token.left + token.width))
    bottom = max(top, min(height, token.top + token.height))
    if right <= left or bottom <= top:
        return False
    crop = product_mask[top:bottom, left:right]
    if crop.size == 0:
        return False
    center_x = max(0, min(width - 1, token.left + token.width // 2))
    center_y = max(0, min(height - 1, token.top + token.height // 2))
    return bool(product_mask[center_y, center_x]) or float(crop.mean()) >= PRODUCT_TOKEN_OVERLAP_MIN


def requires_ocr_retention(
    source_token_count: int,
    clip_similarity_min: float,
    clip_fallback_threshold: float,
    min_source_tokens: int,
) -> bool:
    if source_token_count < max(1, min_source_tokens):
        return False
    return clip_similarity_min < clip_fallback_threshold


def product_ocr_evidence(image: Image.Image, tokens: list[OcrToken] | None = None) -> dict:
    ocr_tokens = tokens if tokens is not None else ocr_tokens_from_image(image)
    product_mask = product_foreground_mask(image)
    has_product_mask = bool(product_mask.any())
    product_tokens: set[str] = set()
    annotation_tokens: set[str] = set()
    for token in ocr_tokens:
        if has_product_mask and not _token_overlaps_product(token, product_mask):
            annotation_tokens.update(token.normalized)
        else:
            product_tokens.update(token.normalized)
    return {
        "productTokens": product_tokens,
        "annotationTokens": annotation_tokens,
        "productTokenCount": len(product_tokens),
        "annotationTokenCount": len(annotation_tokens),
        "mode": "product_surface_only" if annotation_tokens else "product_surface",
    }
