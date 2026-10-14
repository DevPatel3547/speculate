# Source datasets and licenses

`trajectories.jsonl.gz` is a derived work: tool names and normalized/truncated arguments, plus result sizes and timings,
extracted from the public Hugging Face datasets below (downloaded 2026-10-11, unauthenticated, no gated repos).
Licenses were read from each repo's dataset-card `license:` field (and the LICENSE file where one is present).

| id prefix | Dataset | License | Subset used | Kept |
|---|---|---|---|---|
| `swea-` | [nebius/SWE-agent-trajectories](https://huggingface.co/datasets/nebius/SWE-agent-trajectories) | CC-BY-4.0 | shards 00000 and 00006 of 12; 1,500 random rows each (seeds 0 and 1) | 3,000 |
| `rebench-` | [nebius/SWE-rebench-openhands-trajectories](https://huggingface.co/datasets/nebius/SWE-rebench-openhands-trajectories) | CC-BY-4.0 (LICENSE file = CC BY 4.0 legal code) | row groups 0, 8, 16 of 17 (9,730 rows) range-read; 3,000 random rows (seed 10) | 3,000 |
| `smith-` | [SWE-bench/SWE-smith-trajectories](https://huggingface.co/datasets/SWE-bench/SWE-smith-trajectories) | MIT | `tool` split, shard tool-00004-of-00008 (3,012 rows); 2,000 random rows (seed 20) | 2,000 |
| `swegym-` | [SWE-Gym/OpenHands-SFT-Trajectories](https://huggingface.co/datasets/SWE-Gym/OpenHands-SFT-Trajectories) | MIT | all of `train.success.oss` (491) | 491 |
| `ohfb-` | [all-hands/openhands-feedback](https://huggingface.co/datasets/all-hands/openhands-feedback) | MIT | all 275 rows (all `permissions = public`); 12 had no agent tool actions | 263 |

## Attribution (CC-BY-4.0 sources)
- Nebius: "SWE-agent-trajectories" (Badertdinov et al., Nebius AI R&D), https://huggingface.co/datasets/nebius/SWE-agent-trajectories, CC BY 4.0.
- Nebius: "SWE-rebench-OpenHands-Trajectories" (Qwen3-Coder-480B-A35B-Instruct + OpenHands v0.54.0), https://huggingface.co/datasets/nebius/SWE-rebench-openhands-trajectories, CC BY 4.0.
- Changes made: we subsampled, dropped the message text, model reasoning and patches, kept tool name and parsed/truncated arguments, replaced repo roots with `$REPO`, and added a derived side-effect class.

## Notes
- Models (per-row `model` field): SWE-agent-trajectories = nebius swe-agent-llama-70b/8b/405b; SWE-rebench = Qwen3-Coder-480B-A35B-Instruct; SWE-smith = claude-3-5-sonnet-20241022 / claude-3-7-sonnet-20250219 / gpt-4o-2024-08-06; SWE-Gym SFT = gpt-4o / claude-3.5-sonnet (dataset-level only); openhands-feedback = per-session LLM from the initialize event (mixed, some null).
- Only `all-hands/openhands-feedback` contains wall-clock event timestamps, so `think_ms` / `tool_ms` exist only on `ohfb-` steps. It is real-user hosted-app data that users chose to publish (`public`).
- Skipped: SWE-Gym/OpenHands-Sampled-Trajectories and zai-org/SWE-Dev-train (no license declared); ByteDance-Seed/Multi-SWE-RL (license "other", and it holds task instances rather than agent trajectories).
- MIT sources: copyright belongs to the respective dataset authors; reproduce the MIT notice when redistributing.
