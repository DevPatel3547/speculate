# Benchmark outputs

`real-*.txt` are the raw `eval:traces` reports behind the REAL-data tables in the main README (n-gram predictor,
8,754 public trajectories, generated 2026-10-12 with speculate-tools 1.0.0-rc.1; data attribution in the main README).
All runs: `--tool-classes tool_classes.json --think-ms 5300 --tool-ms 450`.

| file | extra flags | headline |
| --- | --- | --- |
| `real-all.txt` | `--exclude-tools think` | top-1 5.0%, top-3 6.4%; est. saved 0.2%, ceiling 1.8% |
| `real-all-with-think.txt` | (none) | top-1 8.2%, top-3 11.4% (inflated by the no-op `think` tool) |
| `real-ohfb.txt` | `--exclude-tools think --test-prefix ohfb- --test-fraction 0.5` | top-1 11.9%, top-3 13.2%; est. saved 0.1%, ceiling 0.8% |
| `real-idem.txt` | `--exclude-tools think --allow-idempotent` | top-1 5.8%, top-3 7.2%; est. saved 0.4%, ceiling 5.9% |

`real-all.txt` was regenerated from the dataset below on 2026-10-12 and matched byte for byte (the evaluation is
deterministic; it takes about 2 minutes).

## The real-trace dataset (not in this repository)

The dataset is a derived work of public Hugging Face datasets and is **not committed**: it is large, and the
evaluation only needs it locally. The exact build used for the reports above:

| file | size | sha256 |
| --- | ---: | --- |
| `trajectories.jsonl.gz` | 4,425,573 bytes | `b34a020769681f64a909a9fb605df7df0d312027537f9533586dff07f6ff6a8c` |
| `tool_classes.json` | 99,343 bytes | `ed992031ba9db4f6c7a8b048a74d0b57bb498a54b63eddb1ffa18a3ceeb9bf5a` |

Totals: 8,754 trajectories, 330,942 steps (mean 37.8 steps per trajectory, p50 30, p90 77). Class share over all
steps: read-only 43.6%, side-effecting 29.5%, idempotent 26.8%.

### How to rebuild it

The conversion script is not part of this repository; any producer that writes the schema in
[`docs/trace-format.md`](../trace-format.md) works with `eval:traces`. The build used these sources and subsets
(downloaded 2026-10-11, unauthenticated, no gated repositories; licenses read from each dataset card):

| id prefix | dataset | license | subset | kept |
| --- | --- | --- | --- | ---: |
| `swea-` | [nebius/SWE-agent-trajectories](https://huggingface.co/datasets/nebius/SWE-agent-trajectories) | CC BY 4.0 | shards 00000 and 00006 of 12; 1,500 random rows each (seeds 0 and 1) | 3,000 |
| `rebench-` | [nebius/SWE-rebench-openhands-trajectories](https://huggingface.co/datasets/nebius/SWE-rebench-openhands-trajectories) | CC BY 4.0 | row groups 0, 8, 16 of 17 (9,730 rows); 3,000 random rows (seed 10) | 3,000 |
| `smith-` | [SWE-bench/SWE-smith-trajectories](https://huggingface.co/datasets/SWE-bench/SWE-smith-trajectories) | MIT | `tool` split, shard tool-00004-of-00008 (3,012 rows); 2,000 random rows (seed 20) | 2,000 |
| `swegym-` | [SWE-Gym/OpenHands-SFT-Trajectories](https://huggingface.co/datasets/SWE-Gym/OpenHands-SFT-Trajectories) | MIT | all of `train.success.oss` | 491 |
| `ohfb-` | [all-hands/openhands-feedback](https://huggingface.co/datasets/all-hands/openhands-feedback) | MIT | all 275 rows (all `public`); 12 had no agent tool actions | 263 |

Per trajectory, the conversion:

1. Extracts each tool call in order: the tool name (OpenHands editor commands become `editor.view`,
   `editor.str_replace`, ...; shell commands become `sh:<program>` with a subcommand where relevant, e.g. `sh:git.diff`)
   and its parsed arguments, normalized and truncated, with repository roots replaced by `$REPO`.
2. Records `result_bytes` and, where the source has wall-clock event timestamps (only `ohfb-`), `think_ms` (time from
   the previous observation to this action) and `tool_ms`.
3. Assigns a per-call `cls` (`read_only` / `idempotent` / `side_effecting`). Shell commands are classified from the
   parsed program list (kept in `args.programs`, with redirect targets in `args.redirect`), so the same tool name can
   have different classes per call. Redirect detection is conservative: in the build, 12 `sh:grep` calls were marked
   side-effecting, some only because a quoted `>` looked like a redirect.
4. Drops message text, model reasoning and patches. Tool *results* are not kept, which disables the n-gram's
   result-derived argument templates.

`tool_classes.json` maps each tool name to its default class (`{"tools": {"name": {"class": "read_only"}}}`).

Skipped sources: SWE-Gym/OpenHands-Sampled-Trajectories and zai-org/SWE-Dev-train (no license declared);
ByteDance-Seed/Multi-SWE-RL (license "other", and it holds task instances rather than agent trajectories).

The scripts that built the dataset are in [`scripts/build-dataset/`](../../scripts/build-dataset/README.md).
