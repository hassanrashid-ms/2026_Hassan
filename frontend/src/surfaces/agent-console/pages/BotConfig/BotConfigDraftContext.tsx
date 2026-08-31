import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { BotConfigView, LimitToggleValue, RuleEntryValue, ToolToggleValue } from '@support/types';

export type BotConfigDraft = {
  prompt: string;
  rules: RuleEntryValue[];
  toolsConfig: ToolToggleValue[];
  limitsConfig: LimitToggleValue[];
};

type BotConfigDraftContextValue = {
  draft: BotConfigDraft | null;
  setDraftField: <K extends keyof BotConfigDraft>(field: K, value: BotConfigDraft[K]) => void;
};

const BotConfigDraftContext = createContext<BotConfigDraftContextValue | null>(null);

/**
 * Seeded once from the loaded config, then only ever updated by the tabs'
 * own useEffects below — never re-seeded from `config` again, so a save on
 * one tab (which refetches `config`) doesn't clobber unsaved edits a admin
 * is mid-typing on another tab.
 */
export function BotConfigDraftProvider({
  config,
  children,
}: {
  config: BotConfigView | undefined;
  children: ReactNode;
}) {
  const [draft, setDraft] = useState<BotConfigDraft | null>(null);

  useEffect(() => {
    if (config && draft === null) {
      setDraft({
        prompt: config.prompt,
        rules: config.rules,
        toolsConfig: config.tools_config,
        limitsConfig: config.limits_config,
      });
    }
  }, [config, draft]);

  const setDraftField = useCallback(
    <K extends keyof BotConfigDraft>(field: K, value: BotConfigDraft[K]) => {
      setDraft((prev) => (prev ? { ...prev, [field]: value } : prev));
    },
    [],
  );

  return (
    <BotConfigDraftContext.Provider value={{ draft, setDraftField }}>
      {children}
    </BotConfigDraftContext.Provider>
  );
}

export function useBotConfigDraft(): BotConfigDraftContextValue {
  const ctx = useContext(BotConfigDraftContext);
  if (!ctx) throw new Error('useBotConfigDraft must be used within BotConfigDraftProvider');
  return ctx;
}
