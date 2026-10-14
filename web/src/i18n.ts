import { useSyncExternalStore } from "react";
import { getLocale, setLocale, subscribeLocale, t } from "./localeStore";

/** A language change only rerenders subscribers; form and workflow state stay mounted. */
export function useI18n() {
  const locale = useSyncExternalStore(
    subscribeLocale,
    getLocale,
    () => "zh-CN" as const,
  );
  return { locale, setLocale, t };
}
