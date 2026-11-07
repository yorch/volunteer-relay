import { parseEnvironment } from "@relay/config";

parseEnvironment(process.env);
if (process.versions.node !== "26.11.1")
  throw new Error("Worker requires Node 26.11.1");
console.info(
  JSON.stringify({
    service: "worker",
    status: "ready",
    runtime: process.versions.node,
    mode: "skeleton-no-handlers",
  }),
);
const heartbeat = setInterval(() => {}, 30_000);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    clearInterval(heartbeat);
    console.info("Worker stopped");
  });
