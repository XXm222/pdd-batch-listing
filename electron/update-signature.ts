import { verify } from 'node:crypto';

export function releasePayload(raw: any): Buffer {
  if (!Array.isArray(raw?.files)) throw Error('更新说明格式不正确');
  return Buffer.from(
    JSON.stringify({
      version: raw.version,
      notes: raw.notes,
      files: raw.files.map((f: any) => ({
        platform: f.platform,
        arch: f.arch,
        url: f.url,
        size: f.size,
        sha256: f.sha256,
      })),
    }),
  );
}

export function verifyReleaseSignature(raw: any, publicKey: string): void {
  if (
    typeof raw?.signature !== 'string' ||
    !/^[A-Za-z0-9+/]{86}==$/.test(raw.signature) ||
    !verify(null, releasePayload(raw), publicKey, Buffer.from(raw.signature, 'base64'))
  )
    throw Error('更新说明签名校验未通过，已停止更新');
}
