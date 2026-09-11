import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positionalPort = args.find((arg) => !arg.startsWith("-"));
const port = Number(positionalPort || process.env.PORT || 4173);

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error("Usage: pnpm kill:port [port]");
  console.error("Example: pnpm kill:port 4173");
  process.exit(1);
}

const pids = findPids(port);

if (pids.length === 0) {
  console.log(`No process is listening on port ${port}.`);
  process.exit(0);
}

console.log(`Port ${port} is used by PID(s): ${pids.join(", ")}`);

if (dryRun) {
  console.log("Dry run only. Re-run without --dry-run to kill them.");
  process.exit(0);
}

for (const pid of pids) {
  try {
    process.kill(Number(pid), "SIGTERM");
    console.log(`Sent SIGTERM to ${pid}.`);
  } catch (error: any) {
    console.error(`Failed to kill ${pid}: ${error.message}`);
  }
}

function findPids(targetPort: any) {
  try {
    const output = execFileSync("lsof", ["-ti", `tcp:${targetPort}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });

    return [...new Set(output.split(/\s+/).filter(Boolean))];
  } catch {
    return [];
  }
}
