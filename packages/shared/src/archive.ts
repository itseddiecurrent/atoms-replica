export type ArchiveFile = { path: string; content: string };

const excludedSegments = new Set(["node_modules", ".git", "dist", ".vite", "coverage"]);

export function isSafeArchivePath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

export function shouldIncludeProjectFile(path: string): boolean {
  if (!isSafeArchivePath(path)) return false;
  return !path.split("/").some((segment) => {
    return excludedSegments.has(segment) || segment === ".env" || segment.startsWith(".env.");
  });
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function header(size: number, write: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(size);
  write(new DataView(bytes.buffer));
  return bytes;
}

export function createProjectZip(files: ArchiveFile[]): Uint8Array {
  const encoder = new TextEncoder();
  const included = files.filter((file) => shouldIncludeProjectFile(file.path));
  const paths = new Set<string>();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const file of included.sort((left, right) => left.path.localeCompare(right.path))) {
    if (paths.has(file.path)) throw new Error(`Duplicate archive path: ${file.path}`);
    paths.add(file.path);
    const name = encoder.encode(file.path);
    const content = encoder.encode(file.content);
    const checksum = crc32(content);
    const localHeader = header(30, (view) => {
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0x0800, true);
      view.setUint32(14, checksum, true);
      view.setUint32(18, content.length, true);
      view.setUint32(22, content.length, true);
      view.setUint16(26, name.length, true);
    });
    localParts.push(localHeader, name, content);

    const centralHeader = header(46, (view) => {
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 20, true);
      view.setUint16(8, 0x0800, true);
      view.setUint32(16, checksum, true);
      view.setUint32(20, content.length, true);
      view.setUint32(24, content.length, true);
      view.setUint16(28, name.length, true);
      view.setUint32(42, localOffset, true);
    });
    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length + content.length;
  }

  const centralDirectory = concatBytes(centralParts);
  const end = header(22, (view) => {
    view.setUint32(0, 0x06054b50, true);
    view.setUint16(8, included.length, true);
    view.setUint16(10, included.length, true);
    view.setUint32(12, centralDirectory.length, true);
    view.setUint32(16, localOffset, true);
  });
  return concatBytes([...localParts, centralDirectory, end]);
}

export function readProjectZip(zip: Uint8Array): ArchiveFile[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const decoder = new TextDecoder();
  const files: ArchiveFile[] = [];
  let offset = 0;
  while (offset + 30 <= zip.length && view.getUint32(offset, true) === 0x04034b50) {
    const compression = view.getUint16(offset + 8, true);
    if (compression !== 0) throw new Error("Unsupported compressed snapshot.");
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const contentOffset = offset + 30 + nameLength + extraLength;
    const path = decoder.decode(zip.slice(offset + 30, offset + 30 + nameLength));
    if (!shouldIncludeProjectFile(path)) throw new Error(`Unsafe snapshot path: ${path}`);
    if (contentOffset + size > zip.length) throw new Error("Truncated snapshot archive.");
    files.push({ path, content: decoder.decode(zip.slice(contentOffset, contentOffset + size)) });
    offset = contentOffset + size;
  }
  return files;
}

export function safeArchiveName(projectName: string): string {
  const name = projectName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${name || "project"}.zip`;
}
