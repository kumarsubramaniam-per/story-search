import "./env.js";
import { MilvusClient } from "@zilliz/milvus2-sdk-node";

const address = "localhost:19530";
const client = new MilvusClient({ address });

try {
  // checkHealth() confirms the gRPC connection works.
  const health = await client.checkHealth();
  if (!health.isHealthy) throw new Error("Milvus reported unhealthy");

  // getVersion() returns the Milvus server version, e.g. { version: "v2.6.x" }.
  const { version } = await client.getVersion();
  console.log(`Connected to Milvus at ${address}, server version: ${version}`);
} catch (err) {
  console.error(`Could not reach Milvus at ${address}: ${(err as Error).message}`);
  console.error("Is it running? Try: npm run dev:up");
  process.exitCode = 1;
} finally {
  await client.closeConnection();
}
