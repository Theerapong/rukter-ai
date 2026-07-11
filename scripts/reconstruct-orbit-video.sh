#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <orbit-video.mov> <output.usdz> [preview|reduced|medium|full|raw]" >&2
  exit 64
fi

video_path="$1"
output_path="$2"
detail="${3:-medium}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/rukter-orbit.XXXXXX")"
frames_dir="$work_dir/frames"
binary_path="$work_dir/reconstruct-video-usdz"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

command -v ffmpeg >/dev/null || { echo "ffmpeg is required." >&2; exit 69; }
command -v xcrun >/dev/null || { echo "Xcode command-line tools are required." >&2; exit 69; }
[[ -f "$video_path" ]] || { echo "Video not found: $video_path" >&2; exit 66; }

mkdir -p "$frames_dir" "$(dirname "$output_path")"
ffmpeg -hide_banner -loglevel error -i "$video_path" \
  -vf "fps=2,scale=1600:-2:flags=lanczos" \
  -q:v 2 "$frames_dir/frame-%04d.jpg"

frame_count="$(find "$frames_dir" -type f -name 'frame-*.jpg' | wc -l | tr -d ' ')"
if [[ "$frame_count" -lt 12 ]]; then
  echo "At least 12 usable frames are required; extracted $frame_count." >&2
  exit 65
fi

xcrun swiftc -parse-as-library "$script_dir/reconstruct-video-usdz.swift" -o "$binary_path"
"$binary_path" "$frames_dir" "$output_path" "$detail"
xcrun usdchecker "$output_path"
echo "asset=$output_path"
echo "frames=$frame_count"
