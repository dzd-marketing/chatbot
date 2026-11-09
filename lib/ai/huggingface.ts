/** Read-only Hugging Face token for private server-side Spaces. */
export function getHfReadToken() {
  return process.env.HF_READ_TOKEN || process.env.HF_TOKEN || undefined;
}
