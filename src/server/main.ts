import { app } from "./app";
import { config } from "./config";
import { resumeQueue, stopAllJobs } from "./ci";
import { startSsh } from "./ssh";

app.listen({ hostname: config.host, port: config.port });
console.log(`Ether listening on http://${config.host}:${config.port} (public URL ${config.publicUrl}, data ${config.dataDir})`);
resumeQueue();
const ssh = startSsh();
if (ssh) console.log(`Git over SSH on ${config.host}:${config.sshPort}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (stopAllJobs(), app.stop(), ssh?.close(), process.exit(0)));
