const defaultPreviewOrigin = "https://*.e2b.app";

function validatedOrigin(value: string | undefined) {
  const origin = value?.trim() || defaultPreviewOrigin;
  if (!/^https:\/\/(?:\*\.)?[a-z0-9.-]+(?::\d+)?$/i.test(origin))
    throw new Error("E2B_PREVIEW_CSP_ORIGIN must be one HTTPS origin or wildcard subdomain.");
  return origin;
}

export function contentSecurityPolicy(previewOriginValue?: string) {
  const previewOrigin = validatedOrigin(previewOriginValue);
  const previewWebSocketOrigin = previewOrigin.replace("https://", "wss://");
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "script-src 'self' 'unsafe-inline' https://apis.google.com https://www.gstatic.com",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https://lh3.googleusercontent.com",
    `frame-src 'self' https://*.firebaseapp.com https://accounts.google.com ${previewOrigin}`,
    `connect-src 'self' https://*.googleapis.com https://*.firebaseio.com wss://*.firebaseio.com https://*.supabase.co wss://*.supabase.co ${previewOrigin} ${previewWebSocketOrigin}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'"
  ].join("; ");
}

export function productionSecurityHeaders(previewOriginValue?: string) {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(previewOriginValue) },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" }
  ];
}
