"use client";
import { useI18n } from "@/components/I18nProvider";
import { guestDictionary, type GuestMessageKey } from "./guestMessages";
import { useCallback, useMemo } from "react";

export function useGuestI18n() {
  const { locale } = useI18n();
  const dictionary = useMemo(() => guestDictionary(locale), [locale]);
  const gt = useCallback((key: GuestMessageKey) => dictionary[key], [dictionary]);
  return { locale, gt };
}
