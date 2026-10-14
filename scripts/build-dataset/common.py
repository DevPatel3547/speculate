"""Shared helpers: shell-command parsing, path normalization, tool classification."""
import re, shlex, json

READ_ONLY, IDEMPOTENT, SIDE = "read_only", "idempotent", "side_effecting"
RANK = {READ_ONLY: 0, IDEMPOTENT: 1, SIDE: 2}

# ---------- classification tables (tool name -> class) ----------
SH_READ = """cat head tail less more ls ll tree find grep egrep fgrep rg ag ack wc pwd echo printf which whereis type file stat du df
diff cmp sort uniq cut awk nl tr basename dirname realpath readlink env printenv whoami id uname date hostname true false test [
python.--version pip.show pip.list pip.freeze pip.--version conda.list conda.info npm.ls npm.view node.--version jq xxd od hexdump strings
git.status git.diff git.log git.show git.blame git.grep git.ls-files git.branch git.rev-parse git.remote git.describe git.config.get git.shortlog git.tag.list
ps top lsof netstat history sleep column md5sum sha256sum seq yes man help tldr locate ldd nm objdump readelf cloc tokei bat fd sed.print""".split()
SH_IDEM = """pytest python.-m.pytest tox nox make.test unittest python.-m.unittest nosetests py.test mypy flake8 pylint ruff.check black.--check isort.--check
python python.-c python.script node node.-e ruby perl go.test go.build go.run go.vet cargo.test cargo.build cargo.check cargo.run javac java mvn gradle
npm.test npm.run npx yarn.test jest vitest tsc make cmake gcc g++ clang ctest bazel dotnet.test dotnet.build php phpunit composer.dump-autoload
pip.install pip3.install pip.download python.-m.pip conda.install npm.install npm.ci yarn.install yarn.add apt-get.install apt.install brew.install
mkdir touch export source cd set unset alias conda.activate deactivate pushd popd curl wget timeout chmod.+x chmod chown ln
git.fetch git.stash.list git.config git.add git.init""".split()
SH_SIDE = """rm rmdir mv cp sed.inplace perl.inplace patch tee dd truncate install unzip tar git.commit git.checkout git.reset git.apply git.stash
git.restore git.revert git.merge git.rebase git.cherry-pick git.clean git.push git.pull git.am git.rm git.mv git.switch git.clone git.branch.delete
kill pkill killall npm.uninstall pip.uninstall pip3.uninstall apt-get.remove sudo docker systemctl service crontab heredoc.write""".split()

NON_SH = {
    # SWE-agent ACI
    "open": READ_ONLY, "goto": READ_ONLY, "scroll_up": READ_ONLY, "scroll_down": READ_ONLY,
    "search_dir": READ_ONLY, "search_file": READ_ONLY, "find_file": READ_ONLY,
    "create": SIDE, "edit": SIDE, "submit": SIDE,
    # OpenHands / SWE-smith str_replace_editor
    "editor.view": READ_ONLY, "editor.create": SIDE, "editor.str_replace": SIDE, "editor.insert": SIDE, "editor.undo_edit": SIDE,
    "editor.write": SIDE, "editor.edit": SIDE,
    "think": READ_ONLY, "finish": SIDE, "task_tracker.view": READ_ONLY, "task_tracker.plan": IDEMPOTENT,
    "browse": READ_ONLY, "browse_interactive": SIDE, "delegate": SIDE,
    # OpenHands agentskills via IPython
    "ipy:open_file": READ_ONLY, "ipy:goto_line": READ_ONLY, "ipy:scroll_down": READ_ONLY, "ipy:scroll_up": READ_ONLY,
    "ipy:search_dir": READ_ONLY, "ipy:search_file": READ_ONLY, "ipy:find_file": READ_ONLY, "ipy:parse_pdf": READ_ONLY,
    "ipy:parse_docx": READ_ONLY, "ipy:parse_latex": READ_ONLY, "ipy:parse_pptx": READ_ONLY, "ipy:print": READ_ONLY,
    "ipy:search_class": READ_ONLY, "ipy:search_method": READ_ONLY, "ipy:search_method_in_class": READ_ONLY, "ipy:search_method_in_file": READ_ONLY, "ipy:search_code": READ_ONLY, "ipy:search_code_in_file": READ_ONLY, "ipy:get_code_around_line": READ_ONLY, "ipy:get_file_info": READ_ONLY, "ipy:create_file": SIDE, "ipy:edit_file_by_replace": SIDE, "ipy:insert_content_at_line": SIDE, "ipy:append_file": SIDE,
    "ipy:edit_file": SIDE, "ipy:pip_install": IDEMPOTENT, "ipy:code": SIDE, "ipy:shell": SIDE,
    "sh:empty": READ_ONLY, "sh:interrupt": SIDE, "sh:stdin": SIDE,
}
SH_CLASS = {}
for lst, c in ((SH_READ, READ_ONLY), (SH_IDEM, IDEMPOTENT), (SH_SIDE, SIDE)):
    for p in lst:
        SH_CLASS[p] = c
SH_CLASS.update({"wait": READ_ONLY, "ping": READ_ONLY, "nproc": READ_ONLY, "free": READ_ONLY, "apt-get.update": IDEMPOTENT, "apt.update": IDEMPOTENT,
                 "poetry": IDEMPOTENT, "coverage": IDEMPOTENT, "pyflakes": READ_ONLY, "pycodestyle": READ_ONLY, "shellcheck": READ_ONLY, "hadolint": READ_ONLY,
                 "jupyter": SIDE, "sqlite3": SIDE, "pdm": IDEMPOTENT, "easy_install": IDEMPOTENT, "uv": IDEMPOTENT, "pipenv": IDEMPOTENT, "npm.init": SIDE,
                 "sed": READ_ONLY, "shell_script": IDEMPOTENT, "black": SIDE, "isort": SIDE, "autopep8": SIDE, "prettier": SIDE,
                 "xargs": READ_ONLY, "git": IDEMPOTENT, "pip": IDEMPOTENT, "npm": IDEMPOTENT, "conda": IDEMPOTENT, "yarn": IDEMPOTENT})
NEUTRAL = {"cd", "export", "source", "set", "unset", "conda.activate", "pushd", "popd", "true", "alias", "deactivate", "sleep", "echo", "printf", "clear"}
WRAPPERS = {"sudo", "timeout", "nohup", "time", "env", "nice", "stdbuf", "command", "builtin", "exec", "xargs"}

def sh_class(key):
    return SH_CLASS.get(key, SIDE)  # unknown programs: conservative

def tool_class(tool):
    if tool in NON_SH:
        return NON_SH[tool]
    if tool.startswith("sh:"):
        return sh_class(tool[3:])
    return NON_SH.get(tool, SIDE)

# ---------- path normalization ----------
LB = r"(?<![\w.\-$])"
GENERIC_ROOTS = [(re.compile(LB + r"/workspace/[A-Za-z0-9_.\-]+__[A-Za-z0-9_.\-]+"), "$REPO"),
                 (re.compile(LB + r"/workspace\b"), "$REPO"),
                 (re.compile(LB + r"/testbed\b"), "$REPO")]

def make_normalizer(extra_root=None):
    pats = []
    if extra_root and extra_root not in ("/", ""):
        pats.append((re.compile(LB + re.escape(extra_root.rstrip("/")) + r"(?=/|\b|$)"), "$REPO"))
    pats += GENERIC_ROOTS
    def norm(s):
        if not isinstance(s, str):
            return s
        for p, r in pats:
            s = p.sub(r, s)
        return s
    return norm

def trunc(s, n=300):
    if s is None:
        return None
    s = str(s)
    return s if len(s) <= n else s[:n] + "…"

def nbytes(s):
    return len(s.encode("utf-8", "replace")) if s else 0

# ---------- shell parsing ----------
HEREDOC = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")

def strip_heredocs(cmd):
    lines = cmd.split("\n"); out = []; i = 0; had = False
    while i < len(lines):
        line = lines[i]; out.append(line)
        m = HEREDOC.search(line)
        if m:
            had = True; delim = m.group(2); i += 1
            while i < len(lines) and lines[i].strip() != delim:
                i += 1
        i += 1
    return "\n".join(out), had

SEPS = {"&&", "||", ";", "|", "&", "(", ")", "\n", ";;", "|&"}
REDIR = {">", ">>", "&>", ">|", "&>>"}

def tokenize(cmd):
    try:
        lx = shlex.shlex(cmd, posix=True, punctuation_chars="();<>|&\n")
        lx.whitespace = " \t\r"; lx.whitespace_split = True; lx.commenters = "#"
        return list(lx)
    except ValueError:
        return re.findall(r"&&|\|\||[;|&()\n]|>>|>|<<|<|[^\s;|&()<>]+", cmd)

PUNCT = set("();<>|&\n")

def split_segments(tokens):
    """-> list of (argv, redirect_targets)"""
    segs, cur, redirs = [], [], []
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if t and set(t) <= PUNCT:
            if "<<" in t:
                i += 2; continue
            if ">" in t:
                if t.endswith("&") and i + 1 < len(tokens) and tokens[i + 1].isdigit():
                    i += 2; continue  # fd dup like 2>&1
                tgt = tokens[i + 1] if i + 1 < len(tokens) else ""
                if tgt and not (set(tgt) <= PUNCT):
                    if tgt not in ("/dev/null", "/dev/stderr", "/dev/stdout"):
                        redirs.append(tgt)
                    i += 2; continue
                i += 1; continue
            if t == "<":
                i += 2; continue
            if cur or redirs:
                segs.append((cur, redirs))
            cur, redirs = [], []
            i += 1; continue
        if cur == [] and t.isdigit() and i + 1 < len(tokens) and ">" in tokens[i + 1]:
            i += 1; continue
        cur.append(t); i += 1
    if cur or redirs:
        segs.append((cur, redirs))
    return segs

def prog_key(argv):
    """Resolve a fine-grained program key from an argv list. Returns (key, rest_args)."""
    a = list(argv)
    while a and (re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", a[0]) or a[0] in WRAPPERS or (a[0].isdigit() and len(a) > 1)):
        w = a.pop(0)
        if w == "timeout":
            while a and (a[0].startswith("-") or re.match(r"^\d+[smhd]?$", a[0])):
                a.pop(0)
        elif w in ("sudo", "env", "nice", "stdbuf", "xargs"):
            while a and a[0].startswith("-"):
                a.pop(0)
    while a and a[0] in ("if", "while", "until", "do", "then", "else", "elif", "!", "{", "}", "done", "fi", "esac", "time"):
        a.pop(0)
    if not a or a[0] in ("for", "case", "select", "function") or a[0].endswith("()"):
        return None, []
    p = a[0].rsplit("/", 1)[-1]; rest = a[1:]
    if re.match(r"^python[0-9.]*$", p) or p == "py":
        p = "python"
    if re.match(r"^pip[0-9.]*$", p):
        p = "pip"
    if p in ("python",):
        opts = [x for x in rest if x.startswith("-")]
        if rest and rest[0] == "-m" and len(rest) > 1:
            mod = rest[1]
            if mod == "pytest": return "pytest", rest[2:]
            if mod == "pip": return prog_key(["pip"] + rest[2:])
            if mod == "unittest": return "unittest", rest[2:]
            return "python.-m." + mod if "python.-m." + mod in SH_CLASS else "python", rest
        if rest and rest[0] == "-c": return "python.-c", rest[1:]
        if rest and rest[0] in ("--version", "-V"): return "python.--version", []
        return "python", rest
    if p in ("bash", "sh", "zsh") or p.endswith(".sh"):
        if p in ("bash", "sh", "zsh") and not rest: return "shell_script", rest
        return "shell_script", rest
    if p == "git":
        r = list(rest)
        while r and r[0].startswith("-"):
            o = r.pop(0)
            if o in ("-C", "-c") and r: r.pop(0)
        if not r: return "git", []
        sub = r[0]; args = r[1:]
        if sub == "branch" and any(x in ("-d", "-D", "--delete", "-m", "-M") for x in args): return "git.branch.delete", args
        if sub == "branch" and any(not x.startswith("-") for x in args): return "git.checkout", args
        if sub == "stash" and args[:1] == ["list"]: return "git.stash.list", args
        if sub == "stash" and args[:1] == ["show"]: return "git.show", args
        if sub == "config" and (any(x in ("--get", "--list", "-l") for x in args) or len([x for x in args if not x.startswith("-")]) <= 1): return "git.config.get", args
        if sub == "tag" and (not args or args[0] in ("-l", "--list")): return "git.tag.list", args
        k = "git." + sub
        return (k if k in SH_CLASS else "git." + sub), args
    if p in ("pip", "npm", "yarn", "conda", "apt-get", "apt", "brew", "go", "cargo", "dotnet", "make", "composer", "pnpm"):
        sub = next((x for x in rest if not x.startswith("-")), None)
        k = f"{p}.{sub}" if sub else p
        if p == "make" and sub and "test" in sub: k = "make.test"
        if p == "npm" and sub == "run" and any("test" in x for x in rest): k = "npm.test"
        return (k if k in SH_CLASS else p if sub is None or p in ("make",) else k), rest
    if p == "sed":
        if any(x.startswith("-i") or x == "--in-place" or re.match(r"^-[a-zA-Z]*i", x) for x in rest): return "sed.inplace", rest
        return "sed", rest
    if p == "perl" and any(re.match(r"^-[a-zA-Z]*i", x) for x in rest): return "perl.inplace", rest
    if p in ("black", "isort", "ruff") and any(x in ("--check", "--diff", "check") for x in rest):
        return ("ruff.check" if p == "ruff" else p + ".--check"), rest
    if p in ("ll", "la", "l"): p = "ls"
    return p, rest

PATHLIKE = re.compile(r"^(\.{1,2}|~)?/?[\w.\-$@+]+(/[\w.\-*$@+]*)*$")

def parse_shell(cmd, norm):
    """Map a raw shell command to (tool, args, cls)."""
    raw = (cmd or "").strip()
    if raw == "":
        return "sh:empty", {}, READ_ONLY
    if raw in ("C-c", "ctrl+c", "C-d", "C-z"):
        return "sh:interrupt", {"key": raw}, SIDE
    body, had_heredoc = strip_heredocs(raw.replace("\\\n", " "))
    segs = split_segments(tokenize(body))
    progs, redirs, primary, prim_rest = [], [], None, []
    for argv, rd in segs:
        redirs += rd
        k, rest = prog_key(argv)
        if k is None:
            continue
        progs.append(k)
        if primary is None and k not in NEUTRAL:
            primary, prim_rest = k, rest
    if primary is None:
        primary = progs[0] if progs else "unknown"
        prim_rest = []
    # class = max over non-neutral programs; neutral-only commands get their own class
    eff = [p for p in progs if p not in NEUTRAL] or progs or ["unknown"]
    cls = max((sh_class(p) for p in eff), key=lambda c: RANK[c])
    if all(p in NEUTRAL for p in progs) and progs:
        cls = IDEMPOTENT if any(p in ("cd", "export", "source", "set", "unset", "conda.activate", "pushd", "popd", "alias") for p in progs) else READ_ONLY
    if redirs:
        cls = SIDE
    args = {"cmd": trunc(norm(raw), 300)}
    if len(set(progs)) > 1:
        args["programs"] = progs[:12]
    if primary in ("sed", "sed.inplace", "awk", "perl.inplace") and not any(x in ("-e", "-f") for x in prim_rest):
        nonopt = [x for x in prim_rest if not x.startswith("-")]
        if nonopt: prim_rest = [x for x in prim_rest if x is not nonopt[0]]
    paths = [norm(x) for x in prim_rest if not x.startswith("-") and "://" not in x and ("/" in x or re.search(r"\.\w{1,6}$", x) or x == ".") and PATHLIKE.match(x)]
    if paths:
        args["paths"] = paths[:5]
    if primary in ("grep", "egrep", "fgrep", "rg", "ag", "ack", "git.grep"):
        r = list(prim_rest); pat = None
        for j, x in enumerate(r):
            if x in ("-e", "--regexp") and j + 1 < len(r):
                pat = r[j + 1]; break
        if pat is None:
            nonopt = [x for x in r if not x.startswith("-")]
            pat = nonopt[0] if nonopt else None
            if pat is not None and args.get("paths") and args["paths"][0] == norm(pat):
                args["paths"] = args["paths"][1:] or None
                if args["paths"] is None: del args["paths"]
        if pat is not None:
            args["pattern"] = trunc(pat, 200)
    if primary in ("find", "fd", "locate"):
        r = list(prim_rest)
        for j, x in enumerate(r):
            if x in ("-name", "-iname", "-path", "-ipath", "-regex") and j + 1 < len(r):
                args["pattern"] = trunc(r[j + 1], 200); break
    if redirs:
        args["redirect"] = [norm(x) for x in redirs[:3]]
    if had_heredoc:
        args["heredoc"] = True
    return "sh:" + primary, args, cls

# ---------- IPython cells (OpenHands agentskills) ----------
SKILL = re.compile(r"\b(open_file|goto_line|scroll_down|scroll_up|search_dir|search_file|find_file|create_file|edit_file_by_replace|insert_content_at_line|append_file|edit_file|parse_pdf|parse_docx|parse_latex|parse_pptx|search_class|search_method|search_method_in_class|search_method_in_file|search_code|search_code_in_file|get_code_around_line|get_file_info)\s*\(")
STR1 = re.compile(r"""\(\s*(?:[a-z_]+\s*=\s*)?(['"]{1,3})(.*?)\1""", re.S)

def parse_ipython(code, norm):
    code = code or ""
    s = code.strip()
    if s.startswith("%pip") or s.startswith("!pip"):
        return "ipy:pip_install", {"code": trunc(norm(s), 200)}, IDEMPOTENT
    if s.startswith("!"):
        t, a, c = parse_shell(s[1:], norm)
        return t, dict(a, via="ipython"), c
    calls = SKILL.findall(code)
    if calls:
        tool = "ipy:" + calls[0]
        cls = max((tool_class("ipy:" + c) for c in calls), key=lambda c: RANK[c])
        args = {}
        m = STR1.search(code, code.find(calls[0]))
        if m:
            args["pattern" if calls[0].startswith("search") else "path"] = trunc(norm(m.group(2)), 200)
        if len(set(calls)) > 1:
            args["calls"] = calls[:10]
        args["code"] = trunc(norm(s), 200)
        return tool, args, cls
    if re.fullmatch(r"print\(.*\)", s, re.S):
        return "ipy:print", {"code": trunc(norm(s), 200)}, READ_ONLY
    return "ipy:code", {"code": trunc(norm(s), 200)}, SIDE
