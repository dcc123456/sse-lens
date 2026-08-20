/**
 * Generates the extension icons.
 *
 * Chrome needs raster PNGs for the toolbar, so the artwork is produced here
 * rather than committed as opaque binaries: the design stays reviewable as code,
 * and every size is regenerated consistently instead of being rescaled by hand.
 *
 * Design: a rounded square in the panel background colour holding three stacked
 * bars of unequal length — a stream of frames arriving one after another — with
 * the newest (top) bar in the accent colour. At 48px and up a lens ring is laid
 * over the lower right, which is the "inspect" half of the idea. The ring is
 * dropped at 16/32px because at that scale its stroke lands under one device
 * pixel and dissolves into a smudge over the bars.
 *
 * Run with: node scripts/generate-icons.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'public', 'icons')

const BG = [0x16, 0x1a, 0x21]
const ACCENT = [0x3d, 0xd6, 0x8c]
const FACE = [0xe6, 0xe8, 0xec]
const DIM = [0x8b, 0x93, 0xa1]

/** Sizes Chrome asks for across the toolbar, management page, and store. */
const SIZES = [16, 32, 48, 128]

/** Straight-alpha pixel buffer helper. */
function createCanvas(size) {
  // RGBA, transparent by default so the rounded corners stay transparent.
  return { size, data: new Uint8Array(size * size * 4) }
}

function setPixel(canvas, x, y, [r, g, b], alpha) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) return
  if (alpha <= 0) return

  const index = (y * canvas.size + x) * 4
  const existingAlpha = canvas.data[index + 3] / 255
  const incoming = Math.min(1, alpha)

  // Standard source-over compositing, so anti-aliased edges layer correctly.
  const outAlpha = incoming + existingAlpha * (1 - incoming)
  if (outAlpha <= 0) return

  for (let channel = 0; channel < 3; channel += 1) {
    const src = [r, g, b][channel]
    const dst = canvas.data[index + channel]
    canvas.data[index + channel] = Math.round(
      (src * incoming + dst * existingAlpha * (1 - incoming)) / outAlpha,
    )
  }
  canvas.data[index + 3] = Math.round(outAlpha * 255)
}

/**
 * Coverage of a pixel by a shape, sampled on a 4x4 grid.
 *
 * Supersampling rather than analytic coverage: at 16px the difference is
 * invisible, and this keeps each shape a simple inside/outside predicate.
 */
function coverage(x, y, inside) {
  const STEPS = 4
  let hits = 0
  for (let sy = 0; sy < STEPS; sy += 1) {
    for (let sx = 0; sx < STEPS; sx += 1) {
      const px = x + (sx + 0.5) / STEPS
      const py = y + (sy + 0.5) / STEPS
      if (inside(px, py)) hits += 1
    }
  }
  return hits / (STEPS * STEPS)
}

/**
 * Fills a shape, optionally restricted to a mask.
 *
 * The mask is used to repaint the background *inside* a cleared gap, so the gap
 * shows the icon's own backdrop rather than a hole through to the toolbar.
 */
function fill(canvas, colour, inside, mask) {
  for (let y = 0; y < canvas.size; y += 1) {
    for (let x = 0; x < canvas.size; x += 1) {
      const alpha = coverage(x, y, mask ? (px, py) => inside(px, py) && mask(px, py) : inside)
      if (alpha > 0) setPixel(canvas, x, y, colour, alpha)
    }
  }
}

/** Resets pixels inside a shape to fully transparent, ignoring what was there. */
function clear(canvas, inside) {
  for (let y = 0; y < canvas.size; y += 1) {
    for (let x = 0; x < canvas.size; x += 1) {
      if (coverage(x, y, inside) < 0.5) continue
      const index = (y * canvas.size + x) * 4
      canvas.data[index] = 0
      canvas.data[index + 1] = 0
      canvas.data[index + 2] = 0
      canvas.data[index + 3] = 0
    }
  }
}

/** Rounded-square predicate, matching the panel's card radius in spirit. */
function roundedSquare(size) {
  const radius = size * 0.22
  const min = size * 0.04
  const max = size - min
  return (x, y) => {
    if (x < min || y < min || x > max || y > max) return false
    const innerMinX = min + radius
    const innerMaxX = max - radius
    const innerMinY = min + radius
    const innerMaxY = max - radius
    const cx = Math.min(Math.max(x, innerMinX), innerMaxX)
    const cy = Math.min(Math.max(y, innerMinY), innerMaxY)
    // Inside the straight edges, or within the corner radius.
    if (x >= innerMinX && x <= innerMaxX) return true
    if (y >= innerMinY && y <= innerMaxY) return true
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
  }
}

function ring(cx, cy, outer, inner) {
  return (x, y) => {
    const d2 = (x - cx) ** 2 + (y - cy) ** 2
    return d2 <= outer ** 2 && d2 >= inner ** 2
  }
}

/** Thick line segment as a capsule, so bar ends stay round at small sizes. */
function segment(x1, y1, x2, y2, halfWidth) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSquared = dx * dx + dy * dy
  return (x, y) => {
    if (lengthSquared === 0) return (x - x1) ** 2 + (y - y1) ** 2 <= halfWidth ** 2
    let t = ((x - x1) * dx + (y - y1) * dy) / lengthSquared
    t = Math.min(1, Math.max(0, t))
    const px = x1 + t * dx
    const py = y1 + t * dy
    return (x - px) ** 2 + (y - py) ** 2 <= halfWidth ** 2
  }
}

function disc(cx, cy, radius) {
  return (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
}

/**
 * Axis-aligned bar with square ends.
 *
 * Used instead of {@link segment} at small sizes: a capsule's round caps spend
 * roughly a pixel of anti-aliasing at each end, which on a 2px-tall bar turns
 * the whole shape into a grey smear. With integer bounds this renders as exact
 * pixels and no anti-aliasing happens at all.
 */
function bar(x1, x2, y1, y2) {
  return (x, y) => x >= x1 && x <= x2 && y >= y1 && y <= y2
}

function drawIcon(size) {
  const canvas = createCanvas(size)
  const s = (fraction) => Math.round(fraction * size)

  fill(canvas, BG, roundedSquare(size))

  // The lens ring needs ~3 device pixels of stroke to read as a ring rather than
  // a filled dot. Below 48px that is not available, so those sizes show the
  // bars alone at full width instead of a shrunken, illegible composition.
  const withLens = size >= 48

  /**
   * Bar geometry, snapped to whole pixels.
   *
   * Heights, gaps and offsets are rounded before drawing: at 16px a bar is two
   * device pixels tall, so half a pixel of misalignment is a 25% error and the
   * three bars blur into one grey block. Verified by decoding the PNGs and
   * checking that three separated ink bands exist at every size.
   *
   * Lengths descend so the stack reads as a stream in progress rather than as a
   * hamburger menu, which any set of equal bars unavoidably suggests. The
   * shortest bar is last because that is the frame still arriving.
   */
  const barHeight = Math.max(2, s(0.09))
  const gap = Math.max(2, s(0.085))
  const stackHeight = barHeight * 3 + gap * 2
  const top = Math.round((size - stackHeight) / 2)
  const left = s(0.18)
  const lengths = withLens ? [0.46, 0.34, 0.22] : [0.62, 0.46, 0.3]
  const colours = [ACCENT, FACE, DIM]

  lengths.forEach((length, index) => {
    const y = top + index * (barHeight + gap)
    // `-1` because the predicate bounds are inclusive: a bar from y to
    // y + height would cover one row too many.
    fill(canvas, colours[index], bar(left, s(0.18 + length), y, y + barHeight - 1))
  })

  if (withLens) {
    /**
     * Lens placement is bounded by the badge, not chosen by eye.
     *
     * An earlier version put the ring at 0.72 with a longer handle, and the
     * handle tip landed outside the rounded square — the mark appeared to leak
     * into the toolbar. These values keep the ring's extremes and the handle tip
     * within the corner radius, and both fills are masked by the badge as a
     * belt-and-braces guard so no future tweak can spill again.
     */
    const badge = roundedSquare(size)
    const lensX = size * 0.68
    const lensY = size * 0.66
    const outer = size * 0.19
    const stroke = Math.max(2, size * 0.055)

    // Punch a transparent gap, then repaint the icon's own backdrop inside it,
    // so the lens never fuses with the bars it overlaps. Repainting through the
    // badge mask means any part of the gap outside the badge stays transparent.
    const gapOuter = outer + stroke * 0.7
    clear(canvas, disc(lensX, lensY, gapOuter))
    fill(canvas, BG, badge, disc(lensX, lensY, gapOuter))

    fill(canvas, ACCENT, ring(lensX, lensY, outer, outer - stroke), badge)
    // Handle, pointing down-right along the diagonal.
    const angle = Math.PI / 4
    const from = outer - stroke * 0.2
    const to = outer + stroke * 1.3
    fill(
      canvas,
      ACCENT,
      segment(
        lensX + Math.cos(angle) * from,
        lensY + Math.sin(angle) * from,
        lensX + Math.cos(angle) * to,
        lensY + Math.sin(angle) * to,
        stroke * 0.5,
      ),
      badge,
    )
  }

  return canvas
}

// --- Minimal PNG encoder -----------------------------------------------------
// Only what these icons need: 8-bit RGBA, no interlacing. Avoids adding an image
// dependency for four small files.

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, crc])
}

function encodePng(canvas) {
  const { size, data } = canvas

  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // colour type: RGBA
  header[10] = 0
  header[11] = 0
  header[12] = 0

  // Each scanline is prefixed with its filter type (0 = none).
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1)
    raw[rowStart] = 0
    for (let x = 0; x < size * 4; x += 1) {
      raw[rowStart + 1 + x] = data[y * size * 4 + x]
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT_DIR, { recursive: true })
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon-${size}.png`)
  writeFileSync(file, encodePng(drawIcon(size)))
  console.log(`wrote ${file}`)
}
