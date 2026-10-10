import crypto from 'crypto';
import { RESILIENCE_CONFIG } from './resilienceConfig.js';

export interface BloomFilterOptions {
  expectedItems?: number;
  falsePositiveRate?: number;
}

/**
 * High-performance, memory-bounded, probabilistic Bloom Filter.
 * 
 * Mathematical Foundation:
 * Optimal bit array size: m = ceil(- (n * ln(p)) / (ln(2)^2))
 * Optimal hash count:     k = ceil((m / n) * ln(2))
 * 
 * Double Hashing (Kirsch-Mitzenmacher Technique):
 * h_i(x) = (h1(x) + i * h2(x)) mod m
 * Produces k independent, uniformly distributed bit positions from only two 32-bit hashes,
 * avoiding expensive multiple cryptographic rounds without loss of theoretical false-positive bounds.
 */
export class BloomFilter {
  public readonly expectedItems: number;
  public readonly falsePositiveRate: number;
  public readonly bitSize: number; // m
  public readonly hashCount: number; // k
  private bitArray: Uint8Array;
  private itemCount: number = 0;

  constructor(options?: BloomFilterOptions) {
    this.expectedItems = Math.max(
      100,
      options?.expectedItems ?? RESILIENCE_CONFIG.BLOOM.DEFAULT_EXPECTED_ITEMS
    );
    this.falsePositiveRate = Math.min(
      0.5,
      Math.max(0.0001, options?.falsePositiveRate ?? RESILIENCE_CONFIG.BLOOM.DEFAULT_FALSE_POSITIVE_RATE)
    );

    // Calculate optimal bit size m
    const n = this.expectedItems;
    const p = this.falsePositiveRate;
    const m = Math.ceil(-((n * Math.log(p)) / (Math.LN2 * Math.LN2)));

    // Bound bit size to prevent runaway memory allocation
    this.bitSize = Math.min(m, RESILIENCE_CONFIG.BLOOM.MAX_BITSET_SIZE_BITS);

    // Calculate optimal hash count k
    this.hashCount = Math.max(1, Math.min(30, Math.ceil((this.bitSize / n) * Math.LN2)));

    // Allocate byte array: 1 byte = 8 bits
    const byteLength = Math.ceil(this.bitSize / 8);
    this.bitArray = new Uint8Array(byteLength);
  }

  /**
   * Generates two 32-bit hash seeds (h1, h2) using SHA-256 slice
   */
  private getHashes(key: string): [number, number] {
    const hashBuf = crypto.createHash('sha256').update(key).digest();
    // Read two 32-bit unsigned integers from digest
    const h1 = hashBuf.readUInt32BE(0);
    const h2 = hashBuf.readUInt32BE(4);
    // Ensure h2 is odd or non-zero to guarantee co-prime step in circular modular space
    return [h1, (h2 | 1) >>> 0];
  }

  /**
   * Computes the k bit positions for a key
   */
  private getBitIndices(key: string): number[] {
    const [h1, h2] = this.getHashes(key);
    const indices: number[] = new Array(this.hashCount);
    for (let i = 0; i < this.hashCount; i++) {
      // Kirsch-Mitzenmacher: (h1 + i * h2) mod m
      // Using unsigned 32-bit arithmetic
      const combined = (h1 + (i * h2)) >>> 0;
      indices[i] = combined % this.bitSize;
    }
    return indices;
  }

  /**
   * Adds an element into the Bloom Filter.
   * Naturally idempotent: duplicate additions do not inflate item count.
   */
  public add(key: string): boolean {
    if (!key || typeof key !== 'string') return false;
    const indices = this.getBitIndices(key);
    let newlyFlipped = false;
    for (const bitIdx of indices) {
      const byteIdx = Math.floor(bitIdx / 8);
      const bitOffset = bitIdx % 8;
      if ((this.bitArray[byteIdx] & (1 << bitOffset)) === 0) {
        newlyFlipped = true;
        this.bitArray[byteIdx] |= (1 << bitOffset);
      }
    }
    if (newlyFlipped) {
      this.itemCount++;
    }
    return newlyFlipped;
  }

  /**
   * Queries whether an element might be present in the Bloom Filter.
   * 
   * Returns:
   * - FALSE: Element is DEFINITELY NOT in the filter (Zero false negatives).
   * - TRUE:  Element MAY be in the filter (Subject to configured false positive rate).
   */
  public mightContain(key: string): boolean {
    if (!key || typeof key !== 'string') return false;
    const indices = this.getBitIndices(key);
    for (const bitIdx of indices) {
      const byteIdx = Math.floor(bitIdx / 8);
      const bitOffset = bitIdx % 8;
      if ((this.bitArray[byteIdx] & (1 << bitOffset)) === 0) {
        return false; // Definitely not present
      }
    }
    return true; // May be present
  }

  /**
   * Returns number of items added so far
   */
  public getItemCount(): number {
    return this.itemCount;
  }

  /**
   * Returns allocated memory in bytes
   */
  public getMemoryBytes(): number {
    return this.bitArray.byteLength;
  }

  /**
   * Returns theoretical estimated current false positive rate based on current load
   * Formula: p = (1 - e^(-k * n / m))^k
   */
  public getEstimatedFalsePositiveRate(): number {
    if (this.itemCount === 0) return 0;
    const exponent = - (this.hashCount * this.itemCount) / this.bitSize;
    const factor = 1 - Math.exp(exponent);
    return Math.pow(factor, this.hashCount);
  }

  /**
   * Clears all bits in the filter
   */
  public clear(): void {
    this.bitArray.fill(0);
    this.itemCount = 0;
  }

  /**
   * Serializes filter to binary buffer
   */
  public serialize(): Buffer {
    const meta = Buffer.alloc(16);
    meta.writeUInt32BE(this.expectedItems, 0);
    meta.writeFloatBE(this.falsePositiveRate, 4);
    meta.writeUInt32BE(this.bitSize, 8);
    meta.writeUInt32BE(this.itemCount, 12);
    return Buffer.concat([meta, Buffer.from(this.bitArray.buffer)]);
  }

  /**
   * Deserializes binary buffer back to BloomFilter
   */
  public static deserialize(buffer: Buffer): BloomFilter {
    const expectedItems = buffer.readUInt32BE(0);
    const falsePositiveRate = buffer.readFloatBE(4);
    const itemCount = buffer.readUInt32BE(12);

    const filter = new BloomFilter({ expectedItems, falsePositiveRate });
    const bitData = buffer.subarray(16);
    filter.bitArray.set(bitData);
    filter.itemCount = itemCount;
    return filter;
  }
}
