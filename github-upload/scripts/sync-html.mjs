import { copyFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptDir, "..");
const sourcePath = resolve(projectDir, "publish", "index.html");
const targetPath = resolve(projectDir, "..", "index.html");

copyFileSync(sourcePath, targetPath);

if (readFileSync(sourcePath, "utf8") !== readFileSync(targetPath, "utf8")) {
  throw new Error("公開用HTMLとルートHTMLの同期に失敗しました。");
}

console.log("publish/index.html をルート index.html へ同期しました。");
