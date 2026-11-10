"""Convert CMake's quoted command strings to argv without executing a shell."""
import json
import shlex
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    database = json.load(source)

commands = []
for entry in database:
    if not entry["file"].endswith(".c"):
        continue
    args = entry.get("arguments") or shlex.split(entry["command"])
    # JavaScript owns analysis-specific flag filtering for every request mode.
    commands.append({"args": args, "directory": entry["directory"], "file": entry["file"]})

with open(sys.argv[2], "w", encoding="utf-8") as target:
    json.dump(commands, target)
