#!/usr/bin/env bash
# Fetch pinned real-world C projects used as analysis test codebases, and generate
# compile_commands.json for each with CMake. Output: analysis/test/codebases/<name>/
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
dest="$root/analysis/test/codebases"
mkdir -p "$dest"

# name | repository | pinned commit or tag | extra CMake flags
projects=(
  "cJSON|https://github.com/DaveGamble/cJSON.git|v1.7.19|-DENABLE_CJSON_UTILS=ON -DENABLE_CJSON_TEST=ON"
  "Collections-C|https://github.com/srdja/Collections-C.git|dbedaf9599716c9aa16c6e955fdc3ef76d5c5cca|"
)

for entry in "${projects[@]}"; do
  IFS='|' read -r name url ref flags <<<"$entry"
  dir="$dest/$name"
  if [[ ! -d "$dir/.git" ]]; then
    git init -q "$dir"
    git -C "$dir" remote add origin "$url"
  fi
  if [[ "$(git -C "$dir" rev-parse -q --verify HEAD 2>/dev/null)" != "$(git -C "$dir" rev-parse -q --verify "$ref^{commit}" 2>/dev/null || echo none)" ]]; then
    echo "Fetching $name @ $ref"
    git -C "$dir" fetch -q --depth 1 origin "$ref"
    git -C "$dir" checkout -q --detach FETCH_HEAD
  fi
  if command -v cmake >/dev/null 2>&1; then
    # shellcheck disable=SC2086
    cmake -S "$dir" -B "$dir/build" -DCMAKE_EXPORT_COMPILE_COMMANDS=ON -DCMAKE_POLICY_VERSION_MINIMUM=3.5 $flags >/dev/null
    echo "$name: $(git -C "$dir" rev-parse --short HEAD), $(grep -c '"file"' "$dir/build/compile_commands.json") compile commands"
  else
    echo "$name: $(git -C "$dir" rev-parse --short HEAD) (cmake not found; every .c file will be analyzed)"
  fi
done
