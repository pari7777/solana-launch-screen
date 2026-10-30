/** Minimal Borsh-style little-endian reader for Anchor events and account data. */
import bs58 from "bs58";
import { createHash } from "node:crypto";

export class Reader {
  off = 0;
  constructor(readonly buf: Buffer) {}
  get left() { return this.buf.length - this.off; }
  u8() { const v = this.buf.readUInt8(this.off); this.off += 1; return v; }
  u16() { const v = this.buf.readUInt16LE(this.off); this.off += 2; return v; }
  u32() { const v = this.buf.readUInt32LE(this.off); this.off += 4; return v; }
  u64() { const v = this.buf.readBigUInt64LE(this.off); this.off += 8; return v; }
  i64() { const v = this.buf.readBigInt64LE(this.off); this.off += 8; return v; }
  bool() { return this.u8() !== 0; }
  pubkey() { const v = bs58.encode(this.buf.subarray(this.off, this.off + 32)); this.off += 32; return v; }
  string() {
    const n = this.u32();
    if (n > 4096 || n > this.left) throw new Error("bad string length");
    const v = this.buf.subarray(this.off, this.off + n).toString("utf8"); this.off += n; return v;
  }
}

export const anchorEventDisc = (name: string) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
export const anchorAccountDisc = (name: string) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
