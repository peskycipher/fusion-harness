/** Generated RunPod provider names reserve this prefix for GPU-time billing. */
export function gpuBilled(model: string): boolean {
  return model.split("/", 1)[0].startsWith("runpod-");
}
export function costLabel(model: string, tokenCostUsd: number): string {
  return gpuBilled(model) ? "GPU billed separately" : `$${tokenCostUsd.toFixed(4)}`;
}
