import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";

const modelPath = "src-tauri/resources/models/ggml-base.en.bin";
const tempPath = `${modelPath}.tmp`;
const modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
const expectedSha256 = "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002";

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

try {
  await stat(modelPath);
  if ((await sha256(modelPath)) === expectedSha256) process.exit(0);
  console.log("Whisper model checksum mismatch; re-downloading...");
  await rm(modelPath, { force: true });
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

await mkdir(dirname(modelPath), { recursive: true });
console.log("Downloading local Whisper model for bundled dictation...");
const response = await fetch(modelUrl);
if (!response.ok || !response.body) {
  throw new Error(`Whisper model download failed: ${response.status} ${response.statusText}`);
}
await pipeline(response.body, createWriteStream(tempPath));
const actualSha256 = await sha256(tempPath);
if (actualSha256 !== expectedSha256) {
  await rm(tempPath, { force: true });
  throw new Error(`Whisper model checksum mismatch: expected ${expectedSha256}, got ${actualSha256}`);
}
await rename(tempPath, modelPath);
