"use client";
import { useI18n } from "@/components/I18nProvider";
import { formatHostCurrency, formatHostDate, formatHostStatus, hostDictionary } from "./hostMessages";
import { useCallback, useMemo } from "react";

export function useHostI18n() {
  const { locale } = useI18n();
  const dictionary = useMemo(() => hostDictionary(locale), [locale]);
  const ht = useCallback((source: string) => dictionary(source), [dictionary]);
  const hDate = useCallback((value: string) => formatHostDate(value,locale),[locale]);
  const hStatus = useCallback((value: string | null | undefined) => formatHostStatus(value,locale),[locale]);
  const hCurrency = useCallback((amount: number | string | null | undefined,currency: string | null | undefined) => formatHostCurrency(amount,currency,locale),[locale]);
  return { locale, ht, hDate, hStatus, hCurrency };
}
