import { cpSync, existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const build = resolve(root, "dist/pages");
const docs = resolve(root, "../docs");
for (const name of ["index.html", "public-demo.json", "structure.json", "model.bin", "foldbot-example.json", "foldbot-example.zip", "foldbot-console-preview.html", "foldbot-console-provenance.json", "foldbot-model-preview.html", "esptool-js-LICENSE.txt", "CodeCraft-code-editor-LICENSE.txt", "CodeCraft-code-editor-NOTICE.txt", "Graph-editor-NOTICE.txt", "Wokwi-elements-LICENSE.txt", "Wokwi-elements-NOTICE.txt"]) {
  if (!existsSync(resolve(build, name))) throw new Error(`缺少分享版资源：${name}`);
}
// Only publish this static build. Keep guide.html and the original public evidence files.
// The live iframe belongs only to the local build, never to the public Pages tree.
for (const folder of [build, docs]) {
  const localConsole = resolve(folder, "foldbot-console-local.html");
  if (existsSync(localConsole)) rmSync(localConsole);
}
cpSync(build, docs, { recursive: true });
const currentAssets = new Set(readdirSync(resolve(build, "assets")));
for (const name of readdirSync(resolve(docs, "assets"))) {
  // Remove only superseded Vite chunks; never remove hand-authored documents or models.
  if (/^[A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.(js|css|woff2?|ttf)$/.test(name) && !currentAssets.has(name))
    rmSync(resolve(docs, "assets", name));
}
writeFileSync(resolve(docs, ".nojekyll"), "");
console.log("完整工作台分享版已写入 docs，guide.html 已保留。");
