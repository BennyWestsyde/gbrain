/**
 * Minimal DOMMatrix polyfill for pdfjs-dist in Node.js / Bun environments.
 *
 * pdfjs-dist v5 uses DOMMatrix for 2D affine-transform math during text
 * extraction (getTextContent). Node and Bun don't provide it globally, so
 * every `instanceof DOMMatrix` check throws "Right hand side of instanceof
 * is not an object" and all PDFs fail with zero text.
 *
 * This polyfill implements only the parts pdfjs actually calls:
 *   - constructor([a, b, c, d, e, f]) or no-arg (identity)
 *   - multiply(other)
 *   - transformPoint({x, y})
 *   - inverse()
 *   - translate / scale / rotate (best-effort — text layer rarely needs them)
 *
 * Also stubs ImageData and Path2D so pdfjs doesn't throw on those either.
 *
 * Call installDOMPolyfills() once before the first pdfjs import.
 */

class PolyfillDOMMatrix {
  a: number; b: number; c: number; d: number; e: number; f: number;
  m11: number; m12: number; m13: number; m14: number;
  m21: number; m22: number; m23: number; m24: number;
  m31: number; m32: number; m33: number; m34: number;
  m41: number; m42: number; m43: number; m44: number;
  is2D: boolean;
  isIdentity: boolean;

  constructor(init?: number[] | string) {
    // Default: identity
    this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
    this.m11 = 1; this.m12 = 0; this.m13 = 0; this.m14 = 0;
    this.m21 = 0; this.m22 = 1; this.m23 = 0; this.m24 = 0;
    this.m31 = 0; this.m32 = 0; this.m33 = 1; this.m34 = 0;
    this.m41 = 0; this.m42 = 0; this.m43 = 0; this.m44 = 1;
    this.is2D = true;
    this.isIdentity = true;

    if (Array.isArray(init) && init.length >= 6) {
      this.a = init[0]!; this.b = init[1]!;
      this.c = init[2]!; this.d = init[3]!;
      this.e = init[4]!; this.f = init[5]!;
      this.m11 = this.a; this.m12 = this.b;
      this.m21 = this.c; this.m22 = this.d;
      this.m41 = this.e; this.m42 = this.f;
      this.isIdentity = (this.a === 1 && this.b === 0 && this.c === 0 &&
                         this.d === 1 && this.e === 0 && this.f === 0);
    }
  }

  multiply(other: PolyfillDOMMatrix): PolyfillDOMMatrix {
    // 2D affine multiply: [a c e] * [a2 c2 e2]
    //                     [b d f]   [b2 d2 f2]
    //                     [0 0 1]   [0  0  1 ]
    return new PolyfillDOMMatrix([
      this.a * other.a + this.c * other.b,
      this.b * other.a + this.d * other.b,
      this.a * other.c + this.c * other.d,
      this.b * other.c + this.d * other.d,
      this.a * other.e + this.c * other.f + this.e,
      this.b * other.e + this.d * other.f + this.f,
    ]);
  }

  transformPoint(point: { x?: number; y?: number; z?: number; w?: number }): { x: number; y: number; z: number; w: number } {
    const x = point.x ?? 0;
    const y = point.y ?? 0;
    return {
      x: this.a * x + this.c * y + this.e,
      y: this.b * x + this.d * y + this.f,
      z: 0,
      w: 1,
    };
  }

  inverse(): PolyfillDOMMatrix {
    const det = this.a * this.d - this.b * this.c;
    if (Math.abs(det) < 1e-10) return new PolyfillDOMMatrix();
    const inv = 1 / det;
    return new PolyfillDOMMatrix([
      this.d * inv,
      -this.b * inv,
      -this.c * inv,
      this.a * inv,
      (this.c * this.f - this.d * this.e) * inv,
      (this.b * this.e - this.a * this.f) * inv,
    ]);
  }

  translate(tx: number, ty: number, _tz?: number): PolyfillDOMMatrix {
    return this.multiply(new PolyfillDOMMatrix([1, 0, 0, 1, tx, ty]));
  }

  scale(sx: number, sy?: number, _sz?: number, _ox?: number, _oy?: number, _oz?: number): PolyfillDOMMatrix {
    return this.multiply(new PolyfillDOMMatrix([sx, 0, 0, sy ?? sx, 0, 0]));
  }

  rotate(_rx: number, _ry?: number, rz?: number): PolyfillDOMMatrix {
    const angle = ((rz ?? _rx) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return this.multiply(new PolyfillDOMMatrix([cos, sin, -sin, cos, 0, 0]));
  }

  toFloat32Array(): Float32Array {
    return Float32Array.from([
      this.m11, this.m12, this.m13, this.m14,
      this.m21, this.m22, this.m23, this.m24,
      this.m31, this.m32, this.m33, this.m34,
      this.m41, this.m42, this.m43, this.m44,
    ]);
  }

  toFloat64Array(): Float64Array {
    return Float64Array.from([
      this.m11, this.m12, this.m13, this.m14,
      this.m21, this.m22, this.m23, this.m24,
      this.m31, this.m32, this.m33, this.m34,
      this.m41, this.m42, this.m43, this.m44,
    ]);
  }
}

class PolyfillImageData {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  constructor(widthOrData: number | Uint8ClampedArray, height: number, _settings?: Record<string, unknown>) {
    if (typeof widthOrData === 'number') {
      this.width = widthOrData;
      this.height = height;
      this.data = new Uint8ClampedArray(widthOrData * height * 4);
    } else {
      this.data = widthOrData;
      this.width = Math.floor(widthOrData.length / 4 / height);
      this.height = height;
    }
  }
}

class PolyfillPath2D {
  moveTo(_x: number, _y: number): void {}
  lineTo(_x: number, _y: number): void {}
  closePath(): void {}
  arc(_x: number, _y: number, _r: number, _sA: number, _eA: number, _cc?: boolean): void {}
  rect(_x: number, _y: number, _w: number, _h: number): void {}
  addPath(_path: PolyfillPath2D, _transform?: PolyfillDOMMatrix): void {}
}

let installed = false;

export function installDOMPolyfills(): void {
  if (installed) return;
  installed = true;
  const g = globalThis as Record<string, unknown>;
  if (typeof g['DOMMatrix'] === 'undefined') g['DOMMatrix'] = PolyfillDOMMatrix;
  if (typeof g['ImageData'] === 'undefined') g['ImageData'] = PolyfillImageData;
  if (typeof g['Path2D'] === 'undefined') g['Path2D'] = PolyfillPath2D;
}
