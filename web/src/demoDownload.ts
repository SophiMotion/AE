import { isPublicDemo, type Run } from "./api";

export function recordDownloadUrl(run: Run): string {
  if (!isPublicDemo) return `/api/runs/${run.id}/export`;
  return `${import.meta.env.BASE_URL}public-demo.json`;
}

export function downloadDraft(draft: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify({
    format: "ae-public-prd-draft-v1",
    scope: "浏览器需求草稿，未经生成、编译和运行验证",
    draft,
  }, null, 2)], { type: "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "AE-需求草稿.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
