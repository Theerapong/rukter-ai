import json
import re
import shutil
import subprocess
import time
from typing import Any, Dict, List, Optional, Tuple


def _number(value: Any) -> Optional[float]:
    if isinstance(value, (int, float)):
        return float(value)
    match = re.search(r"-?\d+(?:\.\d+)?", str(value or ""))
    if not match:
        return None
    try:
        return float(match.group(0))
    except ValueError:
        return None


def _bounded(value: Optional[float], minimum: float, maximum: float) -> Optional[float]:
    if value is None:
        return None
    return max(minimum, min(maximum, value))


def _flatten_fields(value: Any) -> List[Tuple[str, Any]]:
    fields: List[Tuple[str, Any]] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if isinstance(child, dict):
                fields.extend(_flatten_fields(child))
            else:
                fields.append((str(key), child))
    return fields


def _find_field(fields: List[Tuple[str, Any]], required: Tuple[str, ...], excluded: Tuple[str, ...] = ()) -> Optional[float]:
    for key, value in fields:
        normalized = key.lower()
        if all(term in normalized for term in required) and not any(term in normalized for term in excluded):
            parsed = _number(value)
            if parsed is not None:
                return parsed
    return None


def _first_metric(*values: Optional[float]) -> Optional[float]:
    for value in values:
        if value is not None:
            return value
    return None


def parse_rocm_smi_json(raw: str) -> Dict[str, Any]:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {"available": False, "source": "rocm-smi", "reason": "rocm-smi did not return JSON telemetry"}

    fields = _flatten_fields(payload)
    utilization = _first_metric(
        _find_field(fields, ("gpu", "use", "%")),
        _find_field(fields, ("gpu", "util", "%")),
        _find_field(fields, ("gfx", "activity")),
    )
    vram = _first_metric(
        _find_field(fields, ("vram", "%")),
        _find_field(fields, ("memory", "%")),
        _find_field(fields, ("memory", "allocated")),
    )
    power = _first_metric(
        _find_field(fields, ("power", "w"), ("cap",)),
        _find_field(fields, ("power",), ("cap",)),
    )
    temperature = _first_metric(
        _find_field(fields, ("temp", "c")),
        _find_field(fields, ("temperature",)),
    )
    values = {
        "utilizationPct": _bounded(utilization, 0, 100),
        "vramPct": _bounded(vram, 0, 100),
        "powerWatts": _bounded(power, 0, 1000),
        "temperatureC": _bounded(temperature, -20, 130),
    }
    return {
        "available": any(value is not None for value in values.values()),
        "source": "rocm-smi",
        "sampledAt": time.time(),
        **values,
    }


def collect_rocm_smi_metrics() -> Dict[str, Any]:
    command = shutil.which("rocm-smi")
    if not command:
        return {"available": False, "source": "rocm-smi", "reason": "rocm-smi is unavailable"}
    try:
        result = subprocess.run(
            [command, "--showuse", "--showmemuse", "--showpower", "--showtemp", "--json"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return {"available": False, "source": "rocm-smi", "reason": str(error)[:240]}
    raw = (result.stdout or result.stderr or "").strip()
    if result.returncode != 0:
        return {"available": False, "source": "rocm-smi", "reason": raw[:240] or f"rocm-smi exited {result.returncode}"}
    metrics = parse_rocm_smi_json(raw)
    if not metrics.get("available") and raw:
        metrics["reason"] = metrics.get("reason") or "rocm-smi telemetry did not include supported utilization fields"
    return metrics
