import { app } from "./app";
import { config } from "./config";

app.listen({ hostname: config.host, port: config.port });
console.log(`Ether listening on http://${config.host}:${config.port} (public URL ${config.publicUrl}, data ${config.dataDir})`);

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (app.stop(), process.exit(0)));
