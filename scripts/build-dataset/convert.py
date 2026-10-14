"""Convert raw HF trajectory datasets into normalized JSONL (one trajectory per line)."""
import json, re, random, sys, glob, collections, datetime
import pyarrow.parquet as pq
from common import *

PARSE = collections.Counter()  # parse diagnostics

def clean(d):
    return {k: v for k, v in d.items() if v is not None and v != {} and v != []}

def mkstep(tool, args, cls, result_bytes=None, think_ms=None, tool_ms=None):
    return clean({"tool": tool, "args": clean(args or {}), "cls": cls, "result_bytes": result_bytes,
                  "think_ms": think_ms, "tool_ms": tool_ms})

def nlines(s):
    return None if s is None else (s.count("\n") + 1 if s else 0)

def editor_step(p, norm):
    c = (p.get("command") or "unknown").strip()
    tool = "editor." + c
    a = {"path": norm((p.get("path") or "").strip()) or None}
    vr = p.get("view_range")
    if vr not in (None, "", "null"):
        if isinstance(vr, str):
            try: vr = json.loads(vr)
            except Exception: vr = None
        a["view_range"] = vr if isinstance(vr, list) else None
    if c == "str_replace":
        a["old_lines"] = nlines(p.get("old_str")); a["new_lines"] = nlines(p.get("new_str"))
    elif c == "create":
        a["n_lines"] = nlines(p.get("file_text"))
    elif c == "insert":
        a["insert_line"] = p.get("insert_line"); a["new_lines"] = nlines(p.get("new_str"))
    return tool, a, tool_class(tool)

FILE_EDITOR = re.compile(r"file_editor\(\*\*(\{.*\})\)", re.S)
import ast
def ipy_step(code, norm):
    m = FILE_EDITOR.search(code or "")
    if m:
        try:
            d = ast.literal_eval(m.group(1))
            if isinstance(d, dict): return editor_step(d, norm)
        except Exception:
            PARSE["ipy_file_editor_unparsed"] += 1
    body = "\n".join(l for l in (code or "").split("\n") if not l.strip().startswith("#")).strip()
    return parse_ipython(body, norm)

def fn_step(name, p, norm):
    """OpenHands / SWE-agent function-calling tool -> (tool, args, cls)."""
    if name in ("execute_bash", "bash", "cmd_run", "run"):
        cmd = p.get("command") or ""
        if str(p.get("is_input", "false")).lower() == "true" and cmd.strip() not in ("", "C-c", "C-d", "C-z"):
            return "sh:stdin", {"text": trunc(cmd, 100)}, SIDE
        return parse_shell(cmd, norm)
    if name in ("str_replace_editor", "file_editor", "edit_file", "str_replace_based_edit_tool"):
        return editor_step(p, norm)
    if name in ("execute_ipython_cell", "ipython", "run_ipython"):
        return ipy_step(p.get("code") or "", norm)
    if name == "think":
        return "think", {}, READ_ONLY
    if name in ("finish", "submit"):
        return "finish", {}, SIDE
    if name == "task_tracker":
        t = "task_tracker." + (p.get("command") or "plan")
        return t, {}, tool_class(t)
    if name in ("browser", "web_read", "fetch"):
        t = "browse_interactive" if name == "browser" else "browse"
        return t, {"code": trunc(p.get("code") or p.get("url"), 200)}, tool_class(t)
    PARSE["unknown_fn:" + name] += 1
    return "fn:" + name, {k: trunc(v, 100) for k, v in p.items()}, SIDE

# ---------------- nebius/SWE-agent-trajectories (classic SWE-agent ACI, text actions) ----------------
CODEBLOCK = re.compile(r"```[a-zA-Z]*\n?(.*?)```", re.S)
FOOTER = re.compile(r"\s*\(Open file: (.*?)\)\s*\(Current directory: (.*?)\)\s*bash-\$\s*$", re.S)
SWEA_CMDS = {"open", "goto", "scroll_up", "scroll_down", "create", "edit", "search_dir", "search_file", "find_file", "submit"}

def swea_split(line):
    try: return shlex.split(line)
    except ValueError: return line.split()

def swea_step(cmd, open_file, norm):
    first = cmd.split("\n", 1)[0].strip()
    toks = swea_split(first)
    if not toks:
        return "sh:empty", {}, READ_ONLY
    name = toks[0]
    if name not in SWEA_CMDS:
        return parse_shell(cmd, norm)
    a = {}
    if name == "open":
        a["path"] = norm(toks[1]) if len(toks) > 1 else None
        a["line"] = int(toks[2]) if len(toks) > 2 and toks[2].isdigit() else None
    elif name == "goto":
        a["path"] = norm(open_file); a["line"] = int(toks[1]) if len(toks) > 1 and toks[1].isdigit() else None
    elif name in ("scroll_up", "scroll_down"):
        a["path"] = norm(open_file)
    elif name == "create":
        a["path"] = norm(toks[1]) if len(toks) > 1 else None
    elif name == "edit":
        m = re.match(r"edit\s+(\d+):(\d+)", first)
        a["path"] = norm(open_file)
        if m: a["start"], a["end"] = int(m.group(1)), int(m.group(2))
        body = cmd.split("\n", 1)[1] if "\n" in cmd else ""
        body = body.rsplit("end_of_edit", 1)[0]
        a["new_lines"] = body.count("\n")
    elif name in ("search_dir", "find_file"):
        a["pattern"] = trunc(toks[1], 200) if len(toks) > 1 else None
        a["path"] = norm(toks[2]) if len(toks) > 2 else None
    elif name == "search_file":
        a["pattern"] = trunc(toks[1], 200) if len(toks) > 1 else None
        a["path"] = norm(toks[2]) if len(toks) > 2 else norm(open_file)
    return name, a, tool_class(name)

def conv_swe_agent(path, idxs):
    t = pq.read_table(path, columns=["instance_id", "model_name", "target", "trajectory"]).take(idxs)
    for row in t.to_pylist():
        msgs = row["trajectory"]
        root = None
        for m in msgs:
            if m["role"] == "user" and m["text"]:
                f = FOOTER.search(m["text"])
                if f: root = f.group(2).strip(); break
        norm = make_normalizer(root)
        steps, open_file = [], None
        for i, m in enumerate(msgs):
            if m["role"] != "ai":
                continue
            blocks = CODEBLOCK.findall(m["text"] or "")
            if not blocks:
                PARSE["swe_agent_no_block"] += 1; continue
            cmd = blocks[-1].strip()
            obs = msgs[i + 1]["text"] if i + 1 < len(msgs) and msgs[i + 1]["role"] == "user" else None
            tool, a, cls = swea_step(cmd, open_file, norm)
            rb = None
            if obs is not None:
                f = FOOTER.search(obs)
                if f:
                    of = f.group(1).strip(); open_file = None if of == "n/a" else of
                    obs = obs[:f.start()]
                rb = nbytes(obs)
            steps.append(mkstep(tool, a, cls, rb))
        yield clean({"source": "nebius/SWE-agent-trajectories",
               "harness": "swe-agent (text ACI)", "model": row["model_name"], "instance_id": row["instance_id"],
               "resolved": row["target"], "steps": steps})

# ---------------- XML-ish function format (SWE-Gym OpenHands SFT, SWE-smith) + native tool_calls ----------------
FUNC = re.compile(r"<function=([^>\s]+)>(.*?)(?:</function>|\Z)", re.S)
PARAM = re.compile(r"<parameter=([^>\s]+)>(.*?)</parameter>", re.S)
OBS_PREFIX = re.compile(r"^(EXECUTION RESULT of \[[^\]]*\]:\n|OBSERVATION:\n)")

def strip1(v):
    if v.startswith("\n"): v = v[1:]
    if v.endswith("\n"): v = v[:-1]
    return v

def chat_steps(msgs, norm):
    """msgs: list of {role, content, tool_calls?, tool_call_id?}. Handles both inline <function=...> and native tool_calls."""
    steps = []
    tool_results = {m.get("tool_call_id"): m.get("content") for m in msgs if m.get("role") == "tool" and m.get("tool_call_id")}
    for i, m in enumerate(msgs):
        if m.get("role") != "assistant":
            continue
        tcs = m.get("tool_calls") or []
        if tcs:
            for tc in tcs:
                fn = tc.get("function") or {}
                try:
                    p = json.loads(fn.get("arguments") or "{}")
                    if not isinstance(p, dict): raise ValueError
                except Exception:
                    PARSE["bad_tool_args"] += 1; continue
                tool, a, cls = fn_step(fn.get("name"), p, norm)
                res = tool_results.get(tc.get("id"))
                steps.append(mkstep(tool, a, cls, nbytes(res) if res is not None else None))
            continue
        calls = FUNC.findall(m.get("content") or "")
        if not calls:
            PARSE["assistant_no_call"] += 1; continue
        nxt = msgs[i + 1] if i + 1 < len(msgs) else None
        obs = nxt.get("content") if nxt and nxt.get("role") in ("user", "tool") else None
        for j, (name, body) in enumerate(calls):
            p = {k: strip1(v) for k, v in PARAM.findall(body)}
            tool, a, cls = fn_step(name, p, norm)
            rb = None
            if obs is not None and j == len(calls) - 1:
                rb = nbytes(OBS_PREFIX.sub("", obs))
            steps.append(mkstep(tool, a, cls, rb))
    return steps

def conv_swegym(path):
    t = pq.read_table(path)
    for k, row in enumerate(t.to_pylist()):
        steps = chat_steps(row["messages"], make_normalizer())
        yield {"source": "SWE-Gym/OpenHands-SFT-Trajectories", "harness": "openhands (CodeAct, xml fn-calls)",
               "model": "gpt-4o-2024-08-06|claude-3-5-sonnet-20241022 (per dataset card; not per-row)", "resolved": True, "steps": steps}

def conv_smith(path, idxs):
    t = pq.read_table(path, columns=["messages", "instance_id", "resolved", "model"]).take(idxs)
    for row in t.to_pylist():
        msgs = json.loads(row["messages"])
        for m in msgs:
            if isinstance(m.get("content"), list):
                m["content"] = "".join(x.get("text", "") for x in m["content"] if isinstance(x, dict))
        yield {"source": "SWE-bench/SWE-smith-trajectories", "harness": "swe-agent (fn-calling: bash/str_replace_editor/submit)",
               "model": row["model"], "instance_id": row["instance_id"], "resolved": row["resolved"], "steps": chat_steps(msgs, make_normalizer())}

def conv_rebench(path, idxs):
    t = pq.read_table(path, columns=["instance_id", "trajectory", "resolved", "exit_status"]).take(idxs)
    for row in t.to_pylist():
        yield {"source": "nebius/SWE-rebench-openhands-trajectories", "harness": "openhands v0.54.0 (native tool_calls)",
               "model": "Qwen3-Coder-480B-A35B-Instruct", "instance_id": row["instance_id"], "resolved": bool(row["resolved"]),
               "steps": chat_steps(row["trajectory"], make_normalizer())}

# ---------------- all-hands/openhands-feedback (real user sessions, event stream with wall-clock timestamps) ----------------
NON_TOOL_ACTIONS = {"message", "change_agent_state", "initialize", None, "null"}

def ts(e):
    v = e.get("timestamp")
    if v is None: return None
    if isinstance(v, str): v = datetime.datetime.fromisoformat(v)
    return v.timestamp() * 1000.0

def jl(s):
    try: return json.loads(s) if s else {}
    except Exception: return {}

def fb_step(action, ex, norm):
    if action == "run":
        return fn_step("execute_bash", {"command": ex.get("command", ""), "is_input": ex.get("is_input", "false")}, norm)
    if action == "run_ipython":
        return ipy_step(ex.get("code", ""), norm)
    if action == "browse_interactive":
        return "browse_interactive", {"code": trunc(ex.get("browser_actions"), 200)}, SIDE
    if action in ("browse", "crawl"):
        return "browse", {"url": trunc(ex.get("url"), 200)}, READ_ONLY
    if action == "read":
        return "editor.view", {"path": norm(ex.get("path"))}, READ_ONLY
    if action == "write":
        return "editor.write", {"path": norm(ex.get("path")), "n_lines": nlines(ex.get("content"))}, SIDE
    if action == "edit":
        return "editor.edit", {"path": norm(ex.get("path"))}, SIDE
    if action == "delegate":
        return "delegate", {"agent": ex.get("agent")}, SIDE
    if action == "finish":
        return "finish", {}, SIDE
    if action in ("add_task", "modify_task", "task_plan", "save_plan"):
        return "task_tracker.plan", {}, IDEMPOTENT
    if action == "rag_search":
        return "search.rag", {"query": trunc(ex.get("query"), 200)}, READ_ONLY
    PARSE["fb_unknown_action:" + str(action)] += 1
    return "fn:" + str(action), {}, SIDE

def conv_feedback(path):
    t = pq.read_table(path)
    perms = collections.Counter(t.column("permissions").to_pylist()); print("feedback permissions:", perms, file=sys.stderr)
    for row in t.to_pylist():
        ev = row["trajectory"]; norm = make_normalizer()
        model = next((jl(e["extras"]).get("LLM_MODEL") for e in ev if e["action"] == "initialize"), None)
        steps = []; seen_ids = set()
        for i, e in enumerate(ev):
            if e["id"] is not None:
                if (e["id"], e["action"], e["observation"]) in seen_ids:
                    PARSE["fb_dup_event"] += 1; continue
                seen_ids.add((e["id"], e["action"], e["observation"]))
            if e["source"] != "agent" or e["action"] in NON_TOOL_ACTIONS:
                if e["source"] == "user" and e["action"] == "run": PARSE["fb_user_run_skipped"] += 1
                continue
            tool, a, cls = fb_step(e["action"], jl(e["extras"]), norm)
            t_act = ts(e)
            # think_ms: gap from the previous timestamped event (prior observation / state change) to this action
            prev = next((ts(ev[j]) for j in range(i - 1, -1, -1) if ts(ev[j]) is not None), None)
            think = round(t_act - prev) if t_act is not None and prev is not None and 0 <= t_act - prev <= 600_000 else None
            tool_ms = rb = None
            for j in range(i + 1, len(ev)):
                o = ev[j]
                if o["action"] not in (None, "null") and o["source"] == "agent":
                    break
                if o["observation"] and o["observation"] not in ("agent_state_changed", "null"):
                    rb = nbytes(o["content"])
                    to = ts(o)
                    if to is not None and t_act is not None and 0 <= to - t_act <= 3_600_000:
                        tool_ms = round(to - t_act)
                    break
            steps.append(mkstep(tool, a, cls, rb, think, tool_ms))
        yield {"source": "all-hands/openhands-feedback", "harness": "openhands (hosted app, real users)", "model": model,
               "feedback": row["feedback"], "permissions": row["permissions"], "steps": steps}

# ---------------- main ----------------
def sample(path, n, seed):
    rows = pq.ParquetFile(path).metadata.num_rows
    idx = list(range(rows)); random.Random(seed).shuffle(idx)
    return sorted(idx[:n])

if __name__ == "__main__":
    import gzip
    N = dict(swe_agent=1500, rebench=3000, smith=2000)  # swe_agent is per shard (2 shards)
    jobs = []
    for s, f in enumerate(sorted(glob.glob("raw/swe_agent/data/*.parquet"))):
        jobs.append(("swea", lambda f=f, s=s: conv_swe_agent(f, sample(f, N["swe_agent"], s))))
    jobs.append(("rebench", lambda: conv_rebench("raw/rebench_oh/subset.parquet", sample("raw/rebench_oh/subset.parquet", N["rebench"], 10))))
    f_sm = glob.glob("raw/smith/data/*.parquet")[0]
    jobs.append(("smith", lambda: conv_smith(f_sm, sample(f_sm, N["smith"], 20))))
    jobs.append(("swegym", lambda: conv_swegym(glob.glob("raw/swegym/data/*.parquet")[0])))
    jobs.append(("ohfb", lambda: conv_feedback(glob.glob("raw/oh_feedback/data/*.parquet")[0])))
    counts = collections.Counter(); empty = collections.Counter()
    with gzip.open("trajectories.jsonl.gz", "wt", encoding="utf-8", compresslevel=9) as out:
        for short, job in jobs:
            for rec in job():
                if not rec["steps"]:
                    empty[short] += 1; continue
                rec = {"id": f"{short}-{counts[short]:05d}", **rec}
                out.write(json.dumps(rec, ensure_ascii=False) + "\n")
                counts[short] += 1
            print(short, counts[short], "empty", empty[short], file=sys.stderr, flush=True)
    print("PARSE", dict(PARSE.most_common(40)), file=sys.stderr)
    print("DONE", dict(counts), file=sys.stderr)
