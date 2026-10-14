#!/usr/bin/env node
/** Back-compat alias: `speculate-mcp [options] -- <cmd>` == `speculate-tools mcp-proxy [options] -- <cmd>`. */
import { run } from "./main.js";

run(["mcp-proxy", ...process.argv.slice(2)]);
