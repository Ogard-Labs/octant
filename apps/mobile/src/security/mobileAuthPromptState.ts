let activeHighRiskPrompts = 0;

export function beginMobileHighRiskPrompt(): () => void {
  activeHighRiskPrompts += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeHighRiskPrompts = Math.max(0, activeHighRiskPrompts - 1);
  };
}

export function isMobileHighRiskPromptActive(): boolean {
  return activeHighRiskPrompts > 0;
}
