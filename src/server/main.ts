import { app } from "./app";
import { config } from "./config";
import { startSsh } from "./ssh";

app.listen({ hostname: config.host, port: config.port });
console.log(`Ether listening on http://${config.host}:${config.port} (public URL ${config.publicUrl}, data ${config.dataDir})`);
const ssh = startSsh();
if (ssh) console.log(`Git over SSH on ${config.host}:${config.sshPort}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (app.stop(), ssh?.close(), process.exit(0)));
