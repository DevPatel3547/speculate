import json
from common import tool_class, SH_CLASS, NON_SH, NEUTRAL, READ_ONLY, IDEMPOTENT, SIDE, SH_READ, SH_IDEM, SH_SIDE

seen = json.load(open("tools_seen.json"))
RAT = {
 "swe_aci_read": "SWE-agent ACI viewer/search command: reads files or moves the editor window; no filesystem writes.",
 "swe_aci_write": "SWE-agent ACI edit/create: writes a file in the repo.",
 "terminate": "Ends the episode / submits the patch; must never be speculated.",
 "editor_read": "str_replace_editor `view` (cat -n of a file or 2-level dir listing); no writes.",
 "editor_write": "str_replace_editor mutation (create/str_replace/insert/undo_edit/write/edit) of a repo file.",
 "think": "Pure reasoning log; touches no environment state.",
 "plan": "Agent-internal task list; overwriting with same content converges (idempotent), no repo effect.",
 "browse_read": "Plain URL fetch / page read (GET).",
 "browse_act": "Interactive browser actions (click/fill/submit) can change remote state.",
 "delegate": "Spawns a sub-agent that may perform arbitrary actions.",
 "ipy_read": "OpenHands agentskills read/search helper called from IPython (open_file, search_*, goto_line, scroll_*, print).",
 "ipy_write": "OpenHands agentskills file mutation from IPython (create_file, edit_file_by_replace, insert_content_at_line, append_file, edit_file).",
 "ipy_install": "%pip install: environment change, but repeating it converges to the same state.",
 "ipy_code": "Arbitrary Python cell; cannot be proven effect-free, so treated conservatively.",
 "sh_read": "Shell program that only inspects files/repo/process state (cat, ls, grep, find, head, git status/diff/log, sed -n, ...).",
 "sh_idem": "Runs code/tests/builds or installs packages (pytest, python script, make, pip install, mkdir -p, cd/export). May write caches/artifacts or env state, but re-running converges and tracked source is not intentionally modified.",
 "sh_side": "Mutates files, git history, processes or system state non-repeatably (rm, mv, cp, sed -i, git commit/checkout/apply/reset, kill, ...).",
 "sh_unknown": "Program not in the curated tables (project CLIs, typos like `cd..`, stray code lines). Defaulted to side_effecting (conservative).",
 "sh_special": "Empty command (poll for output) is read_only; Ctrl-C / stdin input to a running process is side_effecting.",
}
def rationale(t):
    if t in ("open", "goto", "scroll_up", "scroll_down", "search_dir", "search_file", "find_file"): return "swe_aci_read"
    if t in ("edit", "create"): return "swe_aci_write"
    if t in ("submit", "finish"): return "terminate"
    if t == "editor.view": return "editor_read"
    if t.startswith("editor."): return "editor_write"
    if t == "think": return "think"
    if t.startswith("task_tracker"): return "plan"
    if t in ("browse", "search.rag"): return "browse_read"
    if t == "browse_interactive": return "browse_act"
    if t == "delegate": return "delegate"
    if t == "ipy:pip_install": return "ipy_install"
    if t == "ipy:code": return "ipy_code"
    if t.startswith("ipy:"): return "ipy_read" if tool_class(t) == READ_ONLY else "ipy_write"
    if t in ("sh:empty", "sh:interrupt", "sh:stdin"): return "sh_special"
    if t.startswith("sh:"):
        k = t[3:]
        if k not in SH_CLASS: return "sh_unknown"
        return {READ_ONLY: "sh_read", IDEMPOTENT: "sh_idem", SIDE: "sh_side"}[SH_CLASS[k]]
    return "sh_unknown"

tools = {}
for t, dist in seen.items():
    n = sum(dist.values())
    tools[t] = {"class": tool_class(t), "rationale": rationale(t), "steps": n, "observed_step_classes": dist}
out = {
 "classes": {
   READ_ONLY: "No observable side effect on workspace, environment or external systems; safe to execute speculatively and discard.",
   IDEMPOTENT: "May write transient/derived state (caches, build artifacts, installed packages, cwd/env) but repeated execution converges to the same state and does not intentionally change tracked source; speculation is usually safe in a sandbox/overlay but not free.",
   SIDE: "Changes source files, git state, processes, remote systems, or ends the episode; must not be executed speculatively.",
 },
 "per_step_rules": [
   "Each step in trajectories.jsonl.gz carries `cls`, which is the default class of `tool` adjusted by the rules below.",
   "Shell commands are split on && || ; | & and newlines; wrappers (sudo, timeout, env, nohup, time, xargs) and control keywords (if/then/do/done) are stripped.",
   "`tool` = first non-neutral program (cd/export/source/echo/sleep are neutral). `cls` = max(read_only < idempotent < side_effecting) over all non-neutral programs in the command.",
   "Any output redirection to a real file (>, >>, &>, heredoc into a file) forces side_effecting; redirection to /dev/null does not.",
   "sed -i / perl -i -> side_effecting; plain sed (stream/print) -> read_only; git subcommands are classified individually (status/diff/log/show/blame read_only; add/fetch/config idempotent; commit/checkout/reset/apply/stash side_effecting).",
   "Commands containing only neutral programs: cd/export/source -> idempotent, echo/printf/sleep -> read_only.",
   "Unknown programs default to side_effecting.",
 ],
 "rationale_text": RAT,
 "program_tables": {"read_only": sorted(SH_READ + ["sed", "wait", "ping", "pyflakes", "pycodestyle", "shellcheck", "hadolint", "xargs"]),
                    "idempotent": sorted(set(k for k, v in SH_CLASS.items() if v == IDEMPOTENT)),
                    "side_effecting": sorted(set(k for k, v in SH_CLASS.items() if v == SIDE))},
 "tools": tools,
}
json.dump(out, open("tool_classes.json", "w"), indent=1)
print(len(tools), "tools;", sum(1 for v in tools.values() if v["rationale"] == "sh_unknown"), "unknown;",
      sum(v["steps"] for v in tools.values() if v["rationale"] == "sh_unknown"), "unknown steps")
