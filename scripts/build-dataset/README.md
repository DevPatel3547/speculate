# Rebuilding the real-trace dataset

These scripts produced `trajectories.jsonl.gz` (8,754 public coding-agent trajectories, 330,942 tool steps) used in `docs/benchmarks/`.

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install datasets huggingface_hub pyarrow
python download.py        # fetches the public datasets listed in LICENSES.md
python convert.py         # normalizes them to the trace format in docs/trace-format.md
python build_classes.py   # writes tool_classes.json (read_only / idempotent / side_effecting)
python stats.py           # writes stats.json
```

Then run `npm run eval:traces -- trajectories.jsonl.gz --tool-classes tool_classes.json`.

Dataset licenses and the required attribution are in `LICENSES.md`. The data itself is not committed.
