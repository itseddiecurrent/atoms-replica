const MAX_PROJECT_NAME_LENGTH = 60;

export function getProjectName(prompt: string) {
  const normalized = prompt.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_PROJECT_NAME_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_PROJECT_NAME_LENGTH - 1).trimEnd()}…`;
}
