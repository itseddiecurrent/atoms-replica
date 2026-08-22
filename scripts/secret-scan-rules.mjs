export function isSensitiveTrackedPath(path) {
  const isEnvironmentFile = /(?:^|\/)\.env(?:\.|$)/.test(path);
  const isAllowedEnvironmentTemplate = /(?:^|\/)\.env\.example$/.test(path);
  const isServiceAccountFile = /(?:service[-_]?account|firebase[-_]?admin).*\.json$/i.test(path);

  return (isEnvironmentFile && !isAllowedEnvironmentTemplate) || isServiceAccountFile;
}
