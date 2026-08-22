export function getSafeNextPath(value: string | null | undefined) {
  if (!value?.startsWith("/") || value.startsWith("//")) return "/projects";
  return value;
}

export function needsAuthentication(pathname: string, hasSessionCookie: boolean) {
  return pathname.startsWith("/projects") && !hasSessionCookie;
}
