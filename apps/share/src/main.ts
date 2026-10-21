import { readShareConfig } from "./config.ts";
import { startShareService } from "./server.ts";

const result = readShareConfig(process.env);
if (result.status === "refused") {
  console.error(`octant-share: ${result.reason}`);
  process.exit(1);
}
const service = startShareService(result.config);
// The only line the service writes: where it listens, nothing about any request.
console.log(`octant-share: public ${service.publicUrl}, user content ${service.usercontentUrl}`);
