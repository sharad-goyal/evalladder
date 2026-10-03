export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k: string) => (k in vars ? vars[k] : ''));
}
