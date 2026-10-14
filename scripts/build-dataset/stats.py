import gzip, json, collections, statistics, os, re, sys
from common import tool_class, SH_CLASS, NON_SH, NEUTRAL

def pct(xs, q):
    xs = sorted(xs); return xs[min(len(xs) - 1, int(q * len(xs)))] if xs else None

per = collections.defaultdict(lambda: {"traj": 0, "steps": [], "cls": collections.Counter(), "tools": collections.Counter(),
                                        "models": collections.Counter(), "resolved": collections.Counter(), "think": [], "toolms": [], "rb": []})
tool_cls_seen = collections.defaultdict(collections.Counter)
roots = collections.Counter()
for line in gzip.open("trajectories.jsonl.gz", "rt"):
    r = json.loads(line); d = per[r["source"]]
    d["traj"] += 1; d["steps"].append(len(r["steps"])); d["models"][r.get("model")] += 1; d["resolved"][str(r.get("resolved"))] += 1
    for s in r["steps"]:
        d["cls"][s["cls"]] += 1; d["tools"][s["tool"]] += 1; tool_cls_seen[s["tool"]][s["cls"]] += 1
        if "think_ms" in s: d["think"].append(s["think_ms"])
        if "tool_ms" in s: d["toolms"].append(s["tool_ms"])
        if "result_bytes" in s: d["rb"].append(s["result_bytes"])
        for p in s.get("args", {}).get("paths", [])[:1] + ([s.get("args", {})["path"]] if "path" in s.get("args", {}) else []):
            if isinstance(p, str) and p.startswith("/"): roots["/".join(p.split("/")[:3])] += 1

def summ(xs):
    if not xs: return None
    return {"n": len(xs), "mean": round(statistics.mean(xs), 1), "p50": pct(xs, .5), "p90": pct(xs, .9), "p99": pct(xs, .99), "max": max(xs)}

out = {"total": {}, "per_dataset": {}}
allc = collections.Counter(); allsteps = []
for src, d in per.items():
    n = sum(d["cls"].values()); allc.update(d["cls"]); allsteps += d["steps"]
    out["per_dataset"][src] = {
        "trajectories": d["traj"], "steps": n, "steps_per_trajectory": summ(d["steps"]),
        "class_share": {k: round(v / n, 4) for k, v in d["cls"].most_common()},
        "read_only_share": round(d["cls"]["read_only"] / n, 4),
        "top_tools": dict(d["tools"].most_common(25)), "distinct_tools": len(d["tools"]),
        "models": dict(d["models"].most_common(10)), "resolved": dict(d["resolved"]),
        "result_bytes": summ(d["rb"]), "think_ms": summ(d["think"]), "tool_ms": summ(d["toolms"]),
    }
n = sum(allc.values())
out["total"] = {"trajectories": sum(d["traj"] for d in per.values()), "steps": n, "steps_per_trajectory": summ(allsteps),
                "class_share": {k: round(v / n, 4) for k, v in allc.most_common()}, "read_only_share": round(allc["read_only"] / n, 4),
                "file_bytes_gz": os.path.getsize("trajectories.jsonl.gz")}
out["unnormalized_abs_path_prefixes_top"] = dict(roots.most_common(15))
json.dump(out, open("stats.json", "w"), indent=1)
json.dump({t: dict(c) for t, c in sorted(tool_cls_seen.items(), key=lambda x: -sum(x[1].values()))}, open("tools_seen.json", "w"), indent=1)
print(json.dumps(out["total"], indent=1)); print(json.dumps(out["unnormalized_abs_path_prefixes_top"]))
for src, d in out["per_dataset"].items():
    print(src, d["trajectories"], d["steps"], d["steps_per_trajectory"], d["read_only_share"], list(d["top_tools"].items())[:12], d["think_ms"], d["tool_ms"])
