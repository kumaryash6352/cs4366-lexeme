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
    # Retain each translation unit's flags, but suppress object/dependency outputs.
    filtered = []
    skip = False
    for arg in args:
        if skip:
            skip = False
        elif arg in ("-o", "-MF", "-MT", "-MQ", "-MJ"):
            skip = True
        elif arg in ("-c", "-MD", "-MMD", "-MP", "-MG"):
            continue
        elif arg.startswith(("-o", "-MF", "-MT", "-MQ", "-MJ")):
            continue
        else:
            filtered.append(arg)
    commands.append({"args": filtered, "directory": entry["directory"], "file": entry["file"]})

with open(sys.argv[2], "w", encoding="utf-8") as target:
    json.dump(commands, target)
