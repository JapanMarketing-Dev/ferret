// Iterative in-place radix-2 FFT on split real/imag arrays.

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

const twiddleCache = new Map<number, { cos: Float64Array; sin: Float64Array }>();

function twiddles(n: number) {
  let t = twiddleCache.get(n);
  if (!t) {
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    t = { cos, sin };
    if (twiddleCache.size > 8) twiddleCache.clear();
    twiddleCache.set(n, t);
  }
  return t;
}

/** Forward (inverse=false) or inverse FFT. Inverse is scaled by 1/n. Length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  if (n !== im.length) throw new RangeError('re/im length mismatch');
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new RangeError(`FFT length must be a power of two: ${n}`);
  // bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]!; re[i] = re[j]!; re[j] = t;
      t = im[i]!; im[i] = im[j]!; im[j] = t;
    }
  }
  const { cos, sin } = twiddles(n);
  const sign = inverse ? 1 : -1;
  for (let size = 2; size <= n; size *= 2) {
    const half = size / 2;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step]!;
        const wi = sign * sin[k * step]!;
        const a = start + k;
        const b = a + half;
        const xr = re[b]! * wr - im[b]! * wi;
        const xi = re[b]! * wi + im[b]! * wr;
        re[b] = re[a]! - xr;
        im[b] = im[a]! - xi;
        re[a] = re[a]! + xr;
        im[a] = im[a]! + xi;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] = re[i]! / n;
      im[i] = im[i]! / n;
    }
  }
}

/**
 * Linear cross-correlation c[lag] = Σ a[n]·b[n+lag] for lag in [-maxLag, maxLag], via FFT.
 * Returns an array of length 2·maxLag+1 where index i ↔ lag = i − maxLag.
 */
export function xcorr(a: ArrayLike<number>, b: ArrayLike<number>, maxLag: number): Float64Array {
  const lagMax = Math.max(0, Math.floor(maxLag));
  const n = nextPow2(a.length + b.length + 1);
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const br = new Float64Array(n);
  const bi = new Float64Array(n);
  for (let i = 0; i < a.length; i++) ar[i] = a[i]!;
  for (let i = 0; i < b.length; i++) br[i] = b[i]!;
  fft(ar, ai);
  fft(br, bi);
  // conj(A)·B
  for (let i = 0; i < n; i++) {
    const r = ar[i]! * br[i]! + ai[i]! * bi[i]!;
    const im = ar[i]! * bi[i]! - ai[i]! * br[i]!;
    ar[i] = r;
    ai[i] = im;
  }
  fft(ar, ai, true);
  const out = new Float64Array(2 * lagMax + 1);
  for (let lag = -lagMax; lag <= lagMax; lag++) {
    // positive lags at index lag, negative at n + lag (circular), valid while |lag| < n - max(len)
    const idx = lag >= 0 ? lag : n + lag;
    const valid = lag >= 0 ? lag < b.length : -lag < a.length;
    out[lag + lagMax] = valid ? ar[idx]! : 0;
  }
  return out;
}
