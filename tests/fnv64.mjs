/** FNV-1a over 64 bits, the fingerprint the determinism check and benchmark report pin. */
export const fnv64 = (input) => {
  let hash = 0xcbf2_9ce4_8422_2325n;
  for (const byte of input) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x0000_0100_0000_01b3n);
  }
  return hash.toString(16).padStart(16, '0');
};
