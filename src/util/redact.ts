export function redactSecrets(text: string): string {
  return text
    .replace(/\bsk-\S+/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/g, 'Bearer [REDACTED]')
}
