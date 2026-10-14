import os, pyarrow.parquet as pq, pyarrow as pa, time
from huggingface_hub import hf_hub_download, HfFileSystem
os.makedirs("raw", exist_ok=True)
t0 = time.time()
def dl(repo, fn, sub):
    p = hf_hub_download(repo, fn, repo_type="dataset", local_dir="raw/" + sub)
    print("got", repo, fn, os.path.getsize(p) // 1_000_000, "MB", round(time.time() - t0), "s", flush=True)
dl("SWE-Gym/OpenHands-SFT-Trajectories", "data/train.success.oss-00000-of-00001.parquet", "swegym")
dl("SWE-bench/SWE-smith-trajectories", "data/tool-00004-of-00008.parquet", "smith")
dl("nebius/SWE-agent-trajectories", "data/train-00000-of-00012.parquet", "swe_agent")
dl("nebius/SWE-agent-trajectories", "data/train-00006-of-00012.parquet", "swe_agent")
# SWE-rebench-openhands: range-read 3 of 17 row groups instead of the whole 2GB file
out = "raw/rebench_oh/subset.parquet"
if not os.path.exists(out):
    os.makedirs("raw/rebench_oh", exist_ok=True)
    fs = HfFileSystem()
    with fs.open("datasets/nebius/SWE-rebench-openhands-trajectories/trajectories.parquet", "rb", block_size=64 * 2**20) as f:
        pf = pq.ParquetFile(f)
        tabs = []
        for rg in (0, 8, 16):
            t = pf.read_row_group(rg, columns=["trajectory_id", "instance_id", "repo", "trajectory", "exit_status", "resolved"])
            tabs.append(t); print("rebench rg", rg, t.num_rows, round(time.time() - t0), "s", flush=True)
        pq.write_table(pa.concat_tables(tabs), out)
print("DONE", round(time.time() - t0), "s", flush=True)
