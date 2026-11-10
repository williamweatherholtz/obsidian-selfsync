// Types for the build-time define control (used by test/e2ee/define.test.ts).
export interface KdfCost { m_kib: number; t: number; p: number }
export function parseKdfDefault(kdfSource: string): KdfCost;
export function acceptedKdfDecisions(text: string): KdfCost[];
export function checkE2eeDefine(args: { literal: boolean; decisionTexts: string[]; kdfSource: string }): { ok: true } | { ok: false; reason: string };
export function readDecisionTexts(decisionsDir: string | URL): string[];
