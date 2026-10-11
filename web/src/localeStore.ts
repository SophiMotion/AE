export type Locale = "zh-CN" | "en";
export const LANGUAGE_STORAGE_KEY = "ae.ui-language.v1";
const listeners = new Set<() => void>();
const translations: Record<string, string> = Object.create(null);

function readPreference(): Locale {
  try {
    return typeof window !== "undefined" &&
      window.localStorage.getItem(LANGUAGE_STORAGE_KEY) === "en"
      ? "en"
      : "zh-CN";
  } catch {
    return "zh-CN";
  }
}
let locale: Locale = readPreference();
function updateDocument() {
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
    document.title =
      locale === "en"
        ? "AE · Auto Engineering Workbench"
        : "AE · Auto Engineering 工作台";
  }
}
updateDocument();
export function getLocale(): Locale {
  return locale;
}
export function subscribeLocale(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function setLocale(next: Locale) {
  if (next !== "zh-CN" && next !== "en") return;
  try {
    if (typeof window !== "undefined")
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
  } catch {
    /* In-memory switching still works in restricted browsers. */
  }
  if (next === locale) return;
  locale = next;
  updateDocument();
  listeners.forEach((listener) => listener());
}
export function registerTranslations(values: Record<string, string>) {
  Object.assign(translations, values);
}
/** Translate presentation text only. Never pass user data, code or original logs. */
export function t(source: string, english?: string): string {
  return locale === "en" ? (english ?? translations[source] ?? source) : source;
}
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== LANGUAGE_STORAGE_KEY && event.key !== null) return;
    const next = readPreference();
    if (next !== locale) {
      locale = next;
      updateDocument();
      listeners.forEach((listener) => listener());
    }
  });
}
