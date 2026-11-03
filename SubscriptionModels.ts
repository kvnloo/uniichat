// SubscriptionModels
// ==================
// Text-model snapshots from authenticated first-party catalogs, 2026-10-22:
// ChatGPT /backend-api/codex/models?client_version=0.162.1 (originator
// codex_cli_rs), and Anthropic /v1/models?limit=1000 (OAuth beta).
// A catalog entry is not a promise of inference entitlement or spare quota.
// Hidden Codex entries are retained because they are API-supported text models.

import type { Model } from "./Pick.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const ULTRA = [...EFFORTS, "ultra"];

export const CODEX_MODELS: Model[] = [
  { label: "gpt-6.1-sol", id: "gpt-6.1-sol", speeds: ["slow", "fast"], efforts: ULTRA },
  { label: "gpt-6-astra", id: "gpt-6-astra", speeds: ["slow", "fast"], efforts: ULTRA },
  { label: "gpt-6-sol", id: "gpt-6-sol", speeds: ["slow", "fast"], efforts: ULTRA },
  { label: "gpt-reserve", id: "gpt-reserve", speeds: ["slow", "fast"], efforts: EFFORTS },
  { label: "gpt-6-luna", id: "gpt-6-luna", speeds: ["slow", "fast"], efforts: EFFORTS },
  { label: "gpt-5.6-sol", id: "gpt-5.6-sol", speeds: ["slow", "fast"], efforts: ULTRA },
  { label: "gpt-5.6-terra", id: "gpt-5.6-terra", speeds: ["slow", "fast"], efforts: ULTRA },
  { label: "gpt-5.6-luna", id: "gpt-5.6-luna", speeds: ["slow", "fast"], efforts: EFFORTS },
  { label: "codex-auto-review", id: "codex-auto-review", speeds: ["slow", "fast"], efforts: EFFORTS },
];

export type ClaudeModel = Model & { max: number; adaptive: boolean; effort: boolean };

export const CLAUDE_MODELS: ClaudeModel[] = [
  { label: "haiku-5.5", id: "claude-haiku-5-5", speeds: ["slow"], efforts: EFFORTS, max: 128000, adaptive: true, effort: true },
  { label: "sonnet-5.5", id: "claude-sonnet-5-5", speeds: ["slow"], efforts: EFFORTS, max: 128000, adaptive: true, effort: true },
  { label: "opus-5.5", id: "claude-opus-5-5", speeds: ["slow", "fast"], efforts: EFFORTS, max: 128000, adaptive: true, effort: true },
  { label: "fable-5.1", id: "claude-fable-5-1", speeds: ["slow"], efforts: EFFORTS, max: 128000, adaptive: true, effort: true },
  { label: "opus-5", id: "claude-opus-5", speeds: ["slow"], efforts: EFFORTS, max: 128000, adaptive: true, effort: true },
  { label: "sonnet-5", id: "claude-sonnet-5", speeds: ["slow"], efforts: EFFORTS, max: 128000, adaptive: true, effort: true },
  { label: "fable-5", id: "claude-fable-5", speeds: ["slow"], efforts: EFFORTS, max: 128000, adaptive: true, effort: true },
  { label: "opus-4.8", id: "claude-opus-4-8", speeds: ["slow"], efforts: EFFORTS, max: 128000, adaptive: true, effort: true },
  { label: "opus-4.7", id: "claude-opus-4-7", speeds: ["slow"], efforts: EFFORTS, max: 128000, adaptive: true, effort: true },
  { label: "sonnet-4.6", id: "claude-sonnet-4-6", speeds: ["slow"], efforts: ["low", "medium", "high", "max"], max: 128000, adaptive: true, effort: true },
  { label: "opus-4.6", id: "claude-opus-4-6", speeds: ["slow"], efforts: ["low", "medium", "high", "max"], max: 128000, adaptive: true, effort: true },
  { label: "opus-4.5", id: "claude-opus-4-5-20251101", speeds: ["slow"], efforts: ["low", "medium", "high"], max: 64000, adaptive: false, effort: true },
  { label: "haiku-4.5", id: "claude-haiku-4-5-20251001", speeds: ["slow"], efforts: EFFORTS, max: 64000, adaptive: false, effort: false },
  { label: "sonnet-4.5", id: "claude-sonnet-4-5-20250929", speeds: ["slow"], efforts: EFFORTS, max: 64000, adaptive: false, effort: false },
];
