import { execFileSync } from "node:child_process";

const port = 4173;
const pids = findPids();

if (pids.length === 0) {
  console.log(`Port ${port} is available.`);
  process.exit(0);
}

console.log(`Port ${port} is used by PID(s): ${pids.join(", ")}`);

for (const pid of pids) {
  try {
    process.kill(Number(pid), "SIGTERM");
    console.log(`Sent SIGTERM to ${pid}.`);
  } catch (error: unknown) {
    console.error(`Failed to kill ${pid}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function findPids(): string[] {
  try {
    const output = execFileSync("lsof", ["-ti", `tcp:${port}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });

    return [...new Set(output.split(/\s+/).filter(Boolean))];
  } catch {
    return [];
  }
}
