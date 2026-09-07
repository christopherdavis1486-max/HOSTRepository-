"use client";
import { useI18n } from "@/components/I18nProvider";
import { interfaceDictionary, type InterfaceMessageKey } from "./interfaceMessages";
import { useCallback, useMemo } from "react";

export function useInterfaceI18n() {
  const { locale } = useI18n();
  const dictionary = useMemo(() => interfaceDictionary(locale), [locale]);
  const ui = useCallback((key: InterfaceMessageKey) => dictionary[key], [dictionary]);
  return { locale, ui };
}
